/**
 * Spike 610 (#473, phase-176) — Unified analytics event warehouse across faucet,
 * claim, notifications, forge, and push funnels.
 *
 * NOTE: Written as part of the spike implementation (static review, not executed per strict constraints).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  recordWarehouseEvent,
  getUnifiedFunnelAnalytics,
  exportAnalyticsForWallet,
  sanitizeAnalyticsMetadata,
  computeDedupeKey,
  auditAnalyticsWarehouseWiring,
  AnalyticsWarehouseError,
} from "@/lib/analytics-warehouse"
import { isAnalyticsWarehouseEnabled, phase176RollbackNote } from "@/lib/feature-flags"

const TEST_WALLET_1 = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVW5S"
const TEST_WALLET_2 = "GB32D5S5H5H3QJ42K3Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4Y4"

describe("Unified Analytics Event Warehouse (Spike 610 / phase-176)", () => {
  const saved176 = process.env.FEATURE_PHASE_176

  beforeEach(() => {
    process.env.FEATURE_PHASE_176 = "1"
  })

  afterEach(() => {
    if (saved176 === undefined) delete process.env.FEATURE_PHASE_176
    else process.env.FEATURE_PHASE_176 = saved176
  })

  it("checks feature flag enabling and rollback notes", () => {
    expect(isAnalyticsWarehouseEnabled()).toBe(true)
    const note = phase176RollbackNote()
    expect(note).toContain("phase-176")
  })

  it("sanitizes and bounds metadata, redacting sensitive keys and limiting size", () => {
    const raw = {
      validMetric: 42,
      normalString: "hello world",
      admin_secret_key: "S1234567890",
      userPassword: "supersecretpassword",
      authorization: "Bearer secret-token-xyz",
      longString: "a".repeat(500),
      nestedObject: { safeField: "safe" },
    }

    const sanitized = sanitizeAnalyticsMetadata(raw)

    expect(sanitized.validMetric).toBe(42)
    expect(sanitized.normalString).toBe("hello world")
    expect(sanitized.admin_secret_key).toBe("[REDACTED]")
    expect(sanitized.userPassword).toBe("[REDACTED]")
    expect(sanitized.authorization).toBe("[REDACTED]")
    expect((sanitized.longString as string).length).toBe(256)
  })

  it("computes deterministic deduplication keys for write idempotency", () => {
    const ts = 1700000000000
    const key1 = computeDedupeKey("faucet", "claim_started", TEST_WALLET_1, ts)
    const key2 = computeDedupeKey("faucet", "claim_started", TEST_WALLET_1, ts)
    const keyDifferentStage = computeDedupeKey("faucet", "claim_confirmed", TEST_WALLET_1, ts)

    expect(key1).toBe(key2)
    expect(key1).not.toBe(keyDifferentStage)
    expect(key1.length).toBe(32)
  })

  it("records an event and generates a unified funnel report", async () => {
    const sessionId = "sess-" + Date.now()
    const now = 1700000100000

    // Step 1: Anonymous viewed
    const e1 = await recordWarehouseEvent({
      surface: "faucet",
      stage: "viewed",
      session_id: sessionId,
      ts: now,
      force: true,
    })
    expect(e1.surface).toBe("faucet")
    expect(e1.stage).toBe("viewed")

    // Step 2: Wallet connected (triggers session stitching)
    const e2 = await recordWarehouseEvent({
      surface: "faucet",
      stage: "wallet_connected",
      wallet: TEST_WALLET_1,
      session_id: sessionId,
      ts: now + 5000,
      force: true,
    })
    expect(e2.wallet).toBe(TEST_WALLET_1)

    // Step 3: Claim started
    await recordWarehouseEvent({
      surface: "faucet",
      stage: "claim_started",
      wallet: TEST_WALLET_1,
      session_id: sessionId,
      ts: now + 10000,
      force: true,
    })

    // Step 4: Claim confirmed
    await recordWarehouseEvent({
      surface: "faucet",
      stage: "claim_confirmed",
      wallet: TEST_WALLET_1,
      session_id: sessionId,
      ts: now + 25000,
      force: true,
    })

    // Funnel computation
    const report = await getUnifiedFunnelAnalytics({
      surface: "faucet",
      now: now + 30000,
    })

    expect(report.surface).toBe("faucet")
    expect(report.stages.length).toBeGreaterThan(0)
    expect(report.stages[0].stage).toBe("viewed")
  })

  it("exports all events associated with a wallet for GDPR Article 20 data portability", async () => {
    const exportResult = await exportAnalyticsForWallet(TEST_WALLET_1)
    expect(exportResult.wallet).toBe(TEST_WALLET_1)
    expect(Array.isArray(exportResult.events)).toBe(true)
    expect(typeof exportResult.exportedAt).toBe("number")
  })

  it("throws when flag is disabled without force flag", async () => {
    process.env.FEATURE_PHASE_176 = "0"
    delete process.env.NEXT_PUBLIC_FEATURE_PHASE_176

    await expect(
      recordWarehouseEvent({
        surface: "faucet",
        stage: "viewed",
        force: false,
      }),
    ).rejects.toThrow(AnalyticsWarehouseError)
  })

  it("audits the warehouse wiring successfully when flag is active", () => {
    process.env.FEATURE_PHASE_176 = "1"
    const audit = auditAnalyticsWarehouseWiring()
    expect(audit.ok).toBe(true)
    expect(audit.note).toContain("[phase-176]")
  })
})
