// @ts-nocheck
/**
 * Security counter registry for the gated-preview / CID-verification work
 * (issues #227, #229, #230, #231).
 *
 * Counters are plain process-local values rather than a metrics library: this
 * repo has no metrics dependency and the existing observability story is
 * structured `console` logging. `snapshotSecurityCounters()` is what a health
 * endpoint or a log line reads; `resetSecurityCounters()` exists for tests.
 *
 * Label values are drawn from closed sets (result codes, operation names).
 * Nothing here is ever labelled by a token id, wallet, or CID — those are
 * unbounded, and a caller could inflate series cardinality just by varying one.
 */

export type SecurityCounterName =
  | "preview_verify_total"
  | "preview_verify_expired"
  | "preview_jti_replay"
  | "preview_token_id_mismatch"
  | "preview_bad_signature"
  | "preview_network_mismatch"
  | "gated_cdn_leak_blocked"
  | "cid_poison_attempts"
  | "cid_mismatch"
  | "cid_verified"
  | "cid_cdn_poison"
  | "metadata_uri_rejected"
  | "wash_trades_flagged"
  | "wash_volume_excluded"
  | "wash_graph_sybil"
  | "market_volume_drift"
  | "distributor_refill_race"
  | "distributor_op_underfunded"
  | "distributor_available_balance_stale"
  | "distributor_pending"
  | "distributor_refill_succeeded"
  | "image_variant_generated"
  | "image_crop_focal_computed"
  | "winback_dormant_detected"
  | "winback_experiment_dispatched"
  | "winback_fatigue_suppressed"
  | "ve_lock_created"
  | "ve_lock_extended"
  | "ve_fee_distributed"
  | "ve_fee_claimed"
  | "gauge_vote_cast"
  | "gauge_epoch_distributed"
  | "qr_generated_receive"
  | "qr_generated_referral"
  | "qr_scanned_success"
  | "qr_scanned_invalid"
  | "qr_camera_denied"
  | "wc_session_restored"
  | "wc_session_expired"
  | "wc_reconnect_success"
  | "wc_reconnect_failed"
  | "wc_chain_mismatch_blocked"
  | "xbull_connect_success"
  | "xbull_sign_success"
  | "xbull_sign_rejected"
  | "xbull_trustline_success";

const counters = new Map<SecurityCounterName, number>()

/** Closed label sets, so a counter cannot grow into unbounded cardinality. */
export const PREVIEW_VERIFY_RESULTS = [
  "ok",
  "expired",
  "replay",
  "token_id_mismatch",
  "bad_signature",
  "network_mismatch",
  "missing_claims",
] as const

export const WASH_FLAG_REASONS = ["self_trade", "circular", "rapid_flip", "sybil_cluster"] as const

/** phase-146 decision labels; every moderation counter maps from one of these. */
export const MODERATION_DECISIONS = ["auto_allow", "human_review", "auto_hold"] as const

export function incSecurityCounter(name: SecurityCounterName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by)
}

export const recordSecurityCounter = incSecurityCounter

export function getSecurityCounter(name: SecurityCounterName): number {
  return counters.get(name) ?? 0
}

export function snapshotSecurityCounters(): Record<SecurityCounterName, number> {
  const out = {} as Record<SecurityCounterName, number>
  for (const [name, value] of counters) out[name] = value
  return out
}

export function resetSecurityCounters(): void {
  counters.clear()
}

/**
 * Map a `verifyViewerSignature` failure code onto the counter that tracks it,
 * so the verify route does not carry a switch statement.
 */
export function recordPreviewVerifyFailure(code: string): void {
  incSecurityCounter("preview_verify_total")
  switch (code) {
    case "expired":
      incSecurityCounter("preview_verify_expired")
      break
    case "replay":
      incSecurityCounter("preview_jti_replay")
      break
    case "bad_signature":
      incSecurityCounter("preview_bad_signature")
      break
    case "network_mismatch":
      incSecurityCounter("preview_network_mismatch")
      break
    case "missing_claims":
    case "malformed":
      incSecurityCounter("preview_token_id_mismatch")
      break
  }
}
