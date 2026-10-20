/**
 * Unified Analytics Event Warehouse — Spike 610 / phase-176.
 *
 * Consolidates previously isolated event pockets:
 * 1. Faucet claim funnel 5k-ring sidecar
 * 2. Notification delivery & read lifecycles
 * 3. Observability request traces and metadata
 * 4. Forge payment, polling, and generation pipelines
 * 5. Push notification deliveries & failures
 * 6. Achievement unlocks & Quest completions
 *
 * Features:
 * - SQLite WAL persistence with unique deduplication key for idempotency
 * - Session stitching: anonymous `session_id` automatically resolved to `wallet` upon connection
 * - Bounded metadata: strict sanitization, stripping secrets/tokens, bounding payload size
 * - Backward-compatible migration from legacy `faucet-funnel-events.json` 5k-ring
 * - Fast funnel and retention queries with time-to-convert tracking
 * - GDPR Article 20 data portability export
 *
 * Feature flag: phase-176 (NEXT_PUBLIC_FEATURE_PHASE_176 / FEATURE_PHASE_176)
 * Rollback: unset the flag → writing halts safely, existing events in SQLite remain readable.
 */

import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { getDb } from "@/lib/sqlite-db"
import { isAnalyticsWarehouseEnabled, phase176RollbackNote } from "@/lib/feature-flags"
import { serverDataJsonPath } from "@/lib/server-data-paths"
import { readJsonFile } from "@/lib/json-store"

export const ANALYTICS_SURFACES = [
  "faucet",
  "claim",
  "notifications",
  "observability",
  "forge",
  "achievements",
  "quests",
  "push",
] as const

export type AnalyticsSurface = (typeof ANALYTICS_SURFACES)[number]

export const AnalyticsEventSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  surface: z.enum(ANALYTICS_SURFACES),
  stage: z.string().trim().min(1).max(64),
  wallet: z.string().trim().min(1).max(64).nullable().optional(),
  session_id: z.string().trim().min(1).max(128).nullable().optional(),
  correlation_id: z.string().trim().min(1).max(128).nullable().optional(),
  ts: z.number().int().min(0).max(4_102_444_800_000).optional(),
  metadata: z.record(z.unknown()).optional(),
  reason: z.string().trim().max(512).nullable().optional(),
  dedupe_key: z.string().trim().max(128).optional(),
})

export type AnalyticsEventInput = z.infer<typeof AnalyticsEventSchema>

export type AnalyticsWarehouseEvent = {
  id: string
  surface: AnalyticsSurface
  stage: string
  wallet: string | null
  session_id: string | null
  correlation_id: string | null
  ts: number
  metadata: Record<string, unknown>
  reason: string | null
  dedupe_key: string
}

export class AnalyticsWarehouseError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "STORAGE_ERROR"
  details?: unknown

  constructor(code: AnalyticsWarehouseError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "AnalyticsWarehouseError"
    this.code = code
    this.details = details
  }
}

const REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "secret",
  "secret_key",
  "private_key",
  "token",
  "password",
  "bearer",
  "api_key",
  "admin_secret_key",
  "faucet_distributor_secret_key",
])

/**
 * Sanitizes and bounds metadata to avoid uncontrolled log bloat or secret leakage.
 * Limits keys to 25 and string lengths to 256.
 */
export function sanitizeAnalyticsMetadata(input?: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== "object") return {}
  const output: Record<string, unknown> = {}
  let count = 0

  for (const [key, value] of Object.entries(input)) {
    if (count >= 25) break
    const lowerKey = key.toLowerCase()
    if (REDACTED_KEYS.has(lowerKey) || lowerKey.includes("secret") || lowerKey.includes("password")) {
      output[key] = "[REDACTED]"
      count++
      continue
    }

    if (typeof value === "string") {
      output[key] = value.slice(0, 256)
      count++
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      output[key] = value
      count++
    } else if (Array.isArray(value)) {
      output[key] = value.slice(0, 10).map((v) => (typeof v === "string" ? v.slice(0, 64) : v))
      count++
    } else if (typeof value === "object") {
      try {
        const str = JSON.stringify(value)
        output[key] = str.length > 256 ? `${str.slice(0, 253)}...` : str
        count++
      } catch {
        output[key] = "[Circular]"
        count++
      }
    }
  }

  return output
}

/**
 * Computes deterministic deduplication key for idempotency.
 */
export function computeDedupeKey(
  surface: string,
  stage: string,
  subject: string | null,
  ts: number,
  customKey?: string,
): string {
  if (customKey && customKey.trim()) return customKey.trim()
  const raw = `${surface}:${stage}:${subject ?? "anon"}:${Math.floor(ts / 1000)}`
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32)
}

let legacyMigrated = false

/**
 * Migrates legacy 5k-ring events from faucet-funnel-events.json into SQLite on first use.
 */
export async function migrateLegacyFunnelEvents(): Promise<number> {
  if (legacyMigrated) return 0
  legacyMigrated = true

  try {
    const filePath = serverDataJsonPath("faucetFunnelEvents")
    const data = await readJsonFile<{ events?: Array<{ stage: string; wallet?: string; session_id?: string; ts?: number; reason?: string }> }>(filePath, { events: [] })
    if (!data.events || !Array.isArray(data.events) || data.events.length === 0) {
      return 0
    }

    const db = getDb()
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO analytics_events
      (id, surface, stage, wallet, session_id, correlation_id, ts, metadata_json, reason, dedupe_key)
      VALUES (?, 'faucet', ?, ?, ?, NULL, ?, '{}', ?, ?)
    `)

    let inserted = 0
    for (const evt of data.events) {
      const ts = evt.ts ?? Date.now()
      const wallet = evt.wallet ?? null
      const sessionId = evt.session_id ?? null
      const dedupe = computeDedupeKey("faucet", evt.stage, wallet ?? sessionId, ts)
      try {
        stmt.run(
          randomUUID(),
          evt.stage,
          wallet,
          sessionId,
          ts,
          evt.reason ?? null,
          dedupe,
        )
        inserted++
      } catch {
        // Ignore dedupe clashes
      }
    }
    return inserted
  } catch (err) {
    console.warn("[analytics-warehouse] Legacy migration skipped:", err)
    return 0
  }
}

/**
 * Records a cross-surface analytics event into the SQLite event warehouse.
 */
export async function recordWarehouseEvent(
  input: unknown,
  opts: { force?: boolean; now?: number } = {},
): Promise<AnalyticsWarehouseEvent> {
  const parsed = AnalyticsEventSchema.safeParse(input)
  if (!parsed.success) {
    throw new AnalyticsWarehouseError("VALIDATION_FAILED", "Invalid analytics event schema", parsed.error.flatten())
  }

  const data = parsed.data
  const wallet = data.wallet ?? null
  const enabled = opts.force || isAnalyticsWarehouseEnabled(wallet ?? undefined)

  if (!enabled) {
    throw new AnalyticsWarehouseError("FLAG_DISABLED", "phase-176 flag disabled", {
      rollback: phase176RollbackNote(),
    })
  }

  // Ensure legacy events are migrated
  await migrateLegacyFunnelEvents().catch(() => {})

  const id = data.id ?? randomUUID()
  const now = opts.now ?? data.ts ?? Date.now()
  const metadata = sanitizeAnalyticsMetadata(data.metadata)
  const sessionId = data.session_id ?? null
  const correlationId = data.correlation_id ?? null
  const subject = wallet ?? sessionId ?? correlationId
  const dedupeKey = data.dedupe_key ?? computeDedupeKey(data.surface, data.stage, subject, now)

  const event: AnalyticsWarehouseEvent = {
    id,
    surface: data.surface,
    stage: data.stage,
    wallet,
    session_id: sessionId,
    correlation_id: correlationId,
    ts: now,
    metadata,
    reason: data.reason ?? null,
    dedupe_key: dedupeKey,
  }

  try {
    const db = getDb()

    // Perform session stitching if both session_id and wallet are available
    if (sessionId && wallet) {
      db.prepare(`
        INSERT INTO analytics_session_stitching (session_id, wallet, first_seen_at, stitched_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          wallet = excluded.wallet,
          stitched_at = excluded.stitched_at
      `).run(sessionId, wallet, now, now)

      // Stitch prior anonymous events for this session
      db.prepare(`
        UPDATE analytics_events
        SET wallet = ?
        WHERE session_id = ? AND wallet IS NULL
      `).run(wallet, sessionId)
    }

    // Insert event with idempotent deduplication
    db.prepare(`
      INSERT OR IGNORE INTO analytics_events
      (id, surface, stage, wallet, session_id, correlation_id, ts, metadata_json, reason, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.surface,
      event.stage,
      event.wallet,
      event.session_id,
      event.correlation_id,
      event.ts,
      JSON.stringify(event.metadata),
      event.reason,
      event.dedupe_key,
    )
  } catch (err) {
    throw new AnalyticsWarehouseError("STORAGE_ERROR", `Failed to record event: ${err instanceof Error ? err.message : String(err)}`)
  }

  return event
}

export type WarehouseFunnelStage = {
  stage: string
  events: number
  uniqueSubjects: number
  conversionFromPrev: number | null
  dropOffFromPrev: number | null
  avgTimeToConvertMs: number | null
}

export type UnifiedFunnelReport = {
  surface: string
  windowMs: number | null
  totalEvents: number
  stages: WarehouseFunnelStage[]
  failedEvents: number
  failedUniqueSubjects: number
  overallConversion: number
  stitchedSubjectsCount: number
}

/**
 * Standard happy paths for defined surfaces.
 */
export const SURFACE_HAPPY_PATHS: Record<string, string[]> = {
  faucet: [
    "viewed",
    "wallet_connected",
    "claim_started",
    "claim_signed",
    "claim_confirmed",
  ],
  claim: [
    "claim_pending",
    "claim_polling",
    "claim_confirmed",
  ],
  notifications: [
    "notification_created",
    "notification_delivered",
    "notification_read",
  ],
  forge: [
    "forge_started",
    "forge_paid",
    "forge_polling",
    "forge_completed",
  ],
}

/**
 * Computes unified funnel metrics across surfaces with session stitching.
 */
export async function getUnifiedFunnelAnalytics(opts: {
  surface?: string
  windowMs?: number
  now?: number
  stages?: string[]
} = {}): Promise<UnifiedFunnelReport> {
  await migrateLegacyFunnelEvents().catch(() => {})

  const db = getDb()
  const now = opts.now ?? Date.now()
  const surface = opts.surface ?? "faucet"
  const windowMs = opts.windowMs ?? null
  const minTs = windowMs ? now - windowMs : 0

  const happyStages = opts.stages ?? SURFACE_HAPPY_PATHS[surface] ?? [
    "viewed",
    "wallet_connected",
    "claim_started",
    "claim_confirmed",
  ]

  // Query raw events in window
  const query = `
    SELECT
      e.id,
      e.surface,
      e.stage,
      e.wallet,
      e.session_id,
      e.correlation_id,
      e.ts,
      e.reason,
      COALESCE(e.wallet, s.wallet, e.session_id, e.correlation_id) AS effective_subject
    FROM analytics_events e
    LEFT JOIN analytics_session_stitching s ON e.session_id = s.session_id
    WHERE e.surface = ? AND e.ts >= ?
    ORDER BY e.ts ASC
  `

  const rows = db.prepare(query).all(surface, minTs) as Array<{
    id: string
    surface: string
    stage: string
    wallet: string | null
    session_id: string | null
    correlation_id: string | null
    ts: number
    reason: string | null
    effective_subject: string | null
  }>

  const eventsByStage = new Map<string, typeof rows>()
  const subjectFirstTsByStage = new Map<string, Map<string, number>>()

  for (const row of rows) {
    if (!eventsByStage.has(row.stage)) {
      eventsByStage.set(row.stage, [])
      subjectFirstTsByStage.set(row.stage, new Map())
    }
    eventsByStage.get(row.stage)!.push(row)

    if (row.effective_subject) {
      const stageMap = subjectFirstTsByStage.get(row.stage)!
      if (!stageMap.has(row.effective_subject)) {
        stageMap.set(row.effective_subject, row.ts)
      }
    }
  }

  const stages: WarehouseFunnelStage[] = []
  let prevUnique = 0
  let prevStageMap: Map<string, number> | null = null

  for (let i = 0; i < happyStages.length; i++) {
    const stage = happyStages[i]
    const stageEvents = eventsByStage.get(stage) ?? []
    const stageMap = subjectFirstTsByStage.get(stage) ?? new Map<string, number>()
    const unique = stageMap.size

    let conversionFromPrev: number | null = null
    let dropOffFromPrev: number | null = null
    let avgTimeToConvertMs: number | null = null

    if (i > 0) {
      conversionFromPrev = prevUnique > 0 ? Math.round((unique / prevUnique) * 10_000) / 10_000 : 0
      dropOffFromPrev = prevUnique > 0 ? Math.round((1 - unique / prevUnique) * 10_000) / 10_000 : 0

      // Compute time to convert for subjects seen in both prev and curr
      if (prevStageMap && prevStageMap.size > 0 && unique > 0) {
        let totalTime = 0
        let matchCount = 0
        for (const [subj, currTs] of stageMap.entries()) {
          const prevTs = prevStageMap.get(subj)
          if (prevTs !== undefined && currTs >= prevTs) {
            totalTime += currTs - prevTs
            matchCount++
          }
        }
        if (matchCount > 0) {
          avgTimeToConvertMs = Math.round(totalTime / matchCount)
        }
      }
    }

    stages.push({
      stage,
      events: stageEvents.length,
      uniqueSubjects: unique,
      conversionFromPrev,
      dropOffFromPrev,
      avgTimeToConvertMs,
    })

    prevUnique = unique
    prevStageMap = stageMap
  }

  // Failed branch metrics
  const failedEvents = (eventsByStage.get("claim_failed") ?? []).concat(
    eventsByStage.get("failed") ?? [],
  )
  const failedUnique = new Set(failedEvents.map((e) => e.effective_subject).filter(Boolean)).size

  const top = stages[0]?.uniqueSubjects ?? 0
  const bottom = stages[stages.length - 1]?.uniqueSubjects ?? 0
  const overallConversion = top > 0 ? Math.round((bottom / top) * 10_000) / 10_000 : 0

  const stitchedCount = (
    db.prepare("SELECT COUNT(*) as count FROM analytics_session_stitching").get() as { count: number }
  )?.count ?? 0

  return {
    surface,
    windowMs,
    totalEvents: rows.length,
    stages,
    failedEvents: failedEvents.length,
    failedUniqueSubjects: failedUnique,
    overallConversion,
    stitchedSubjectsCount: stitchedCount,
  }
}

/**
 * Exports all analytics warehouse events associated with a wallet (Article 20 GDPR Data Portability).
 */
export async function exportAnalyticsForWallet(wallet: string): Promise<{
  wallet: string
  exportedAt: number
  events: AnalyticsWarehouseEvent[]
}> {
  const db = getDb()
  const rows = db.prepare(`
    SELECT
      e.id,
      e.surface,
      e.stage,
      e.wallet,
      e.session_id,
      e.correlation_id,
      e.ts,
      e.metadata_json,
      e.reason,
      e.dedupe_key
    FROM analytics_events e
    LEFT JOIN analytics_session_stitching s ON e.session_id = s.session_id
    WHERE e.wallet = ? OR s.wallet = ?
    ORDER BY e.ts ASC
  `).all(wallet, wallet) as Array<{
    id: string
    surface: string
    stage: string
    wallet: string | null
    session_id: string | null
    correlation_id: string | null
    ts: number
    metadata_json: string
    reason: string | null
    dedupe_key: string
  }>

  const events: AnalyticsWarehouseEvent[] = rows.map((r) => {
    let metadata: Record<string, unknown> = {}
    try {
      metadata = JSON.parse(r.metadata_json)
    } catch {
      // ignore
    }
    return {
      id: r.id,
      surface: r.surface as AnalyticsSurface,
      stage: r.stage,
      wallet: r.wallet,
      session_id: r.session_id,
      correlation_id: r.correlation_id,
      ts: r.ts,
      metadata,
      reason: r.reason,
      dedupe_key: r.dedupe_key,
    }
  })

  return {
    wallet,
    exportedAt: Date.now(),
    events,
  }
}

/**
 * Diagnostic wiring check for the unified analytics warehouse.
 */
export function auditAnalyticsWarehouseWiring(): { ok: boolean; note: string } {
  if (!isAnalyticsWarehouseEnabled()) {
    return {
      ok: true,
      note: "[phase-176] Unified analytics event warehouse disabled; nothing to audit.",
    }
  }

  try {
    const db = getDb()
    const tableInfo = db.prepare("PRAGMA table_info(analytics_events)").all() as Array<{ name: string }>
    if (!tableInfo.some((c) => c.name === "dedupe_key") || !tableInfo.some((c) => c.name === "surface")) {
      return {
        ok: false,
        note: "[phase-176] analytics_events table missing expected columns.",
      }
    }
    return {
      ok: true,
      note: `[phase-176] unified analytics event warehouse wiring OK. ${phase176RollbackNote()}`,
    }
  } catch (err) {
    return {
      ok: false,
      note: `[phase-176] warehouse audit failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
