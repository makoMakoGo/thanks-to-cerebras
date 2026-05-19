import {
  UPSTREAM_CIRCUIT_FAILURE_THRESHOLD,
  UPSTREAM_CIRCUIT_OPEN_MS,
} from "../constants.ts";
import { logger } from "../logger.ts";
import { state } from "../state.ts";

export type CircuitPermit =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number };

export function getUpstreamCircuitPermit(now = Date.now()): CircuitPermit {
  if (state.upstreamCircuitOpenedUntil <= now) {
    if (state.upstreamCircuitOpenedUntil > 0) {
      if (state.upstreamCircuitHalfOpenInFlight) {
        return { allowed: false, retryAfterSec: 1 };
      }
      state.upstreamCircuitHalfOpenInFlight = true;
      logger.info("upstream_circuit_half_open");
    }
    return { allowed: true };
  }

  return {
    allowed: false,
    retryAfterSec: Math.max(
      1,
      Math.ceil((state.upstreamCircuitOpenedUntil - now) / 1000),
    ),
  };
}

export function recordUpstreamSuccess(): void {
  const wasRecovering = state.upstreamCircuitOpenedUntil > 0 ||
    state.upstreamCircuitHalfOpenInFlight ||
    state.upstreamCircuitFailureCount > 0;

  state.upstreamCircuitFailureCount = 0;
  state.upstreamCircuitOpenedUntil = 0;
  state.upstreamCircuitHalfOpenInFlight = false;

  if (wasRecovering) logger.info("upstream_circuit_closed");
}

export function recordUpstreamFailure(now = Date.now()): void {
  state.upstreamCircuitHalfOpenInFlight = false;
  state.upstreamCircuitFailureCount += 1;
  if (
    state.upstreamCircuitFailureCount < UPSTREAM_CIRCUIT_FAILURE_THRESHOLD &&
    state.upstreamCircuitOpenedUntil <= now
  ) {
    return;
  }

  state.upstreamCircuitOpenedUntil = now + UPSTREAM_CIRCUIT_OPEN_MS;
  logger.warn("upstream_circuit_opened", {
    failureCount: state.upstreamCircuitFailureCount,
    retryAfterSec: Math.ceil(UPSTREAM_CIRCUIT_OPEN_MS / 1000),
  });
}

export function resetUpstreamCircuitForTests(): void {
  state.upstreamCircuitFailureCount = 0;
  state.upstreamCircuitOpenedUntil = 0;
  state.upstreamCircuitHalfOpenInFlight = false;
}
