/**
 * Analytics warehouse export: schema-versioned NDJSON and Parquet, redacted.
 * Spike 618 / Issue #481.
 *
 * The warehouse is a flat, append-only row model (`table`, `ts`, `metric`,
 * `value`, `status`, `wallet_fingerprint`) collected from three sources:
 * process counters, distributor health history and wash-excluded market
 * volume. Two output formats share one manifest:
 *
 *   - NDJSON: first line is a manifest object (`schema`, `version`,
 *     `row_count`, `checksum`), then one row per line — the streaming shape
 *     `lib/narrative-world-store.ts` established.
 *   - Parquet: columnar buffer via `hyparquet-writer`, with the same manifest
 *     in `key_value_metadata` (`phase.schema_version`, `phase.checksum`, …).
 *
 * Redaction is unconditional: exports never contain raw `G...` addresses or
 * `S...` seeds. Wallet fields become `fingerprintWallet()` strings and any
 * wallet/secret-looking text inside metric or status is rewritten in place
 * (`redactWarehouseRow`). Flag: phase-180.
 * Rollback: unset the flag — the export route 404s and no stored state needs
 * reversing; the Parquet/NDJSON helpers stay importable for tests.
 */

import { parquetWriteBuffer } from "hyparquet-writer"
import { isFeatureEnabled } from "@/lib/feature-flags"
import { computeSha256 } from "@/lib/data-portability"
import { fingerprintWallet, redactSecretKeys, WALLET_KEY_RE } from "@/lib/redaction"
import { snapshotSecurityCounters } from "@/lib/security-counters"
import { getHealthHistory } from "@/lib/distributor-health-store"
import { getDb } from "@/lib/sqlite-db"

export const WAREHOUSE_SCHEMA = "phase-warehouse-export"
export const WAREHOUSE_SCHEMA_VERSION = "1.0.0"

export const WAREHOUSE_TABLES = ["counter", "health", "volume"] as const
export type WarehouseTable = (typeof WAREHOUSE_TABLES)[number]

export type WarehouseRow = {
  table: WarehouseTable
  ts: number
  metric: string
  value: number | null
  status: string | null
  wallet_fingerprint: string | null
}

export function isWarehouseExportEnabled(): boolean {
  return isFeatureEnabled("phase-180")
}

export function warehouse180RollbackNote(): string {
  return "Rollback phase-180: unset NEXT_PUBLIC_FEATURE_PHASE_180 / FEATURE_PHASE_180 or set 0/false and restart. The export route 404s; no stored warehouse state exists."
}

export class WarehouseExportError extends Error {
  readonly code: "FLAG_DISABLED" | "UNAUTHORIZED" | "EXPORT_FAILED"
  readonly details?: unknown
  constructor(code: WarehouseExportError["code"], message: string, details?: unknown) {
    super(message)
    this.name = "WarehouseExportError"
    this.code = code
    this.details = details
  }
}

// ─── Redaction ───────────────────────────────────────────────────────────────

/** Fingerprints raw wallets and strips secrets from free text. */
export function redactWarehouseText(text: string): string {
  if (!text) return text
  return redactSecretKeys(text).replace(WALLET_KEY_RE, (wallet) => fingerprintWallet(wallet))
}

/**
 * Makes one row safe for export. `wallet_fingerprint` is only ever written by
 * collectors as a raw address (the field name describes the post-redaction
 * role), so a raw `G...` here is fingerprinted rather than trusted. A fresh
 * non-global regex because `WALLET_KEY_RE` carries `/g` and `.test()` on it is
 * stateful across calls.
 */
const FULL_WALLET_RE = /^G[A-Z2-7]{55}$/

export function redactWarehouseRow(row: WarehouseRow): WarehouseRow {
  return {
    ...row,
    metric: redactWarehouseText(row.metric),
    status: row.status === null ? null : redactWarehouseText(row.status),
    wallet_fingerprint:
      row.wallet_fingerprint === null
        ? null
        : FULL_WALLET_RE.test(row.wallet_fingerprint)
          ? fingerprintWallet(row.wallet_fingerprint)
          : redactWarehouseText(row.wallet_fingerprint),
  }
}

export function redactWarehouseRows(rows: WarehouseRow[]): WarehouseRow[] {
  return rows.map(redactWarehouseRow)
}

// ─── Collectors ─────────────────────────────────────────────────────────────

export type CollectOptions = {
  now?: number
  healthLimit?: number
  volumeWindowMs?: number
}

export const DEFAULT_VOLUME_WINDOW_MS = 24 * 60 * 60 * 1000

export function collectCounterRows(now: number = Date.now()): WarehouseRow[] {
  const snapshot = snapshotSecurityCounters()
  return Object.entries(snapshot).map(([metric, value]) => ({
    table: "counter" as const,
    ts: now,
    metric,
    value,
    status: null,
    wallet_fingerprint: null,
  }))
}

export async function collectHealthRows(
  opts: CollectOptions = {},
): Promise<WarehouseRow[]> {
  const history = await getHealthHistory(opts.healthLimit ?? 50)
  return history.map((record) => ({
    table: "health" as const,
    ts: record.checkedAt,
    metric: "distributor_health",
    value: record.distributorXlm,
    status: record.status,
    wallet_fingerprint: record.distributorAddress || null,
  })).concat(
    history.map((record) => ({
      table: "health" as const,
      ts: record.checkedAt,
      metric: "distributor_phase_liq_stroops",
      value: record.distributorPhaseLiqStroops === null ? null : Number(record.distributorPhaseLiqStroops),
      status: record.status,
      wallet_fingerprint: record.issuerAddress || null,
    })),
  )
}

export async function collectVolumeRows(
  opts: CollectOptions = {},
): Promise<WarehouseRow[]> {
  const now = opts.now ?? Date.now()
  const since = now - (opts.volumeWindowMs ?? DEFAULT_VOLUME_WINDOW_MS)
  try {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(amount_phaselq), 0) AS total, COUNT(*) AS offers
           FROM offers
          WHERE status = 'accepted' AND wash_flagged = 0 AND created_at >= ?`,
      )
      .get(since) as { total: number; offers: number }
    return [
      {
        table: "volume",
        ts: now,
        metric: "market_volume_phaselq_24h",
        value: Number(row?.total ?? 0),
        status: null,
        wallet_fingerprint: null,
      },
      {
        table: "volume",
        ts: now,
        metric: "market_offers_accepted_24h",
        value: Number(row?.offers ?? 0),
        status: null,
        wallet_fingerprint: null,
      },
    ]
  } catch {
    // A missing/unmigrated database yields no rows rather than failing the export.
    return []
  }
}

export async function collectWarehouseRows(opts: CollectOptions = {}): Promise<WarehouseRow[]> {
  const now = opts.now ?? Date.now()
  const [health, volume] = await Promise.all([collectHealthRows(opts), collectVolumeRows(opts)])
  return [...collectCounterRows(now), ...health, ...volume]
}

// ─── Manifest + formats ─────────────────────────────────────────────────────

export type WarehouseManifest = {
  schema: typeof WAREHOUSE_SCHEMA
  version: string
  generated_at: number
  row_count: number
  tables: string[]
  redacted: boolean
  checksum: string
}

/** Rows only — the checksum must be reproducible without the manifest line. */
export function warehouseRowsChecksum(rows: WarehouseRow[]): string {
  return computeSha256(rows.map((row) => JSON.stringify(row)).join("\n"))
}

export function buildWarehouseManifest(
  rows: WarehouseRow[],
  opts: { generatedAt?: number; redacted?: boolean } = {},
): WarehouseManifest {
  const tables = [...new Set(rows.map((row) => row.table))].sort()
  return {
    schema: WAREHOUSE_SCHEMA,
    version: WAREHOUSE_SCHEMA_VERSION,
    generated_at: opts.generatedAt ?? Date.now(),
    row_count: rows.length,
    tables,
    redacted: opts.redacted ?? true,
    checksum: warehouseRowsChecksum(rows),
  }
}

export function formatWarehouseNdjson(
  rows: WarehouseRow[],
  opts: { generatedAt?: number } = {},
): { manifest: WarehouseManifest; body: string } {
  const manifest = buildWarehouseManifest(rows, { generatedAt: opts.generatedAt, redacted: true })
  const body =
    JSON.stringify(manifest) +
    "\n" +
    rows.map((row) => JSON.stringify(row)).join("\n") +
    (rows.length > 0 ? "\n" : "")
  return { manifest, body }
}

export function rowsToParquetBuffer(
  rows: WarehouseRow[],
  opts: { generatedAt?: number } = {},
): { manifest: WarehouseManifest; buffer: ArrayBuffer } {
  const manifest = buildWarehouseManifest(rows, { generatedAt: opts.generatedAt, redacted: true })
  try {
    const buffer = parquetWriteBuffer({
      columnData: [
        { name: "table", data: rows.map((row) => row.table), type: "STRING" },
        { name: "ts", data: rows.map((row) => BigInt(row.ts)), type: "INT64" },
        { name: "metric", data: rows.map((row) => row.metric), type: "STRING" },
        { name: "value", data: rows.map((row) => row.value), type: "DOUBLE" },
        { name: "status", data: rows.map((row) => row.status), type: "STRING" },
        { name: "wallet_fingerprint", data: rows.map((row) => row.wallet_fingerprint), type: "STRING" },
      ],
      kvMetadata: [
        { key: "phase.schema", value: manifest.schema },
        { key: "phase.schema_version", value: manifest.version },
        { key: "phase.generated_at", value: String(manifest.generated_at) },
        { key: "phase.row_count", value: String(manifest.row_count) },
        { key: "phase.checksum", value: manifest.checksum },
        { key: "phase.redacted", value: "true" },
      ],
    })
    return { manifest, buffer }
  } catch (error) {
    throw new WarehouseExportError(
      "EXPORT_FAILED",
      "Parquet encoding failed",
      error instanceof Error ? error.message : String(error),
    )
  }
}
