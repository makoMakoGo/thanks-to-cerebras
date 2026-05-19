# Upstream Circuit Breaker Runbook

## Purpose

Use this runbook when proxy requests return `503` with `upstream_circuit_open`
or when Cerebras upstream failures spike.

## Behavior

- Network errors, upstream timeouts, and upstream `5xx` responses count as
  circuit-breaker failures.
- Authentication errors, model-not-found responses, and rate limits do not trip
  the breaker.
- After the failure threshold is reached, the breaker opens for the configured
  cooldown.
- While open, proxy requests fail fast with `503` and `Retry-After`.
- After cooldown, one half-open probe is allowed. Success closes the breaker;
  failure reopens it.

## Triage

1. Inspect recent structured logs:
   - `proxy_upstream_fetch_failed`
   - `upstream_circuit_opened`
   - `upstream_circuit_half_open`
   - `upstream_circuit_closed`
2. Check `/api/metrics` with an admin token:
   - `proxy_requests_total.upstream_error`
   - `proxy_requests_total.timeout`
   - `proxy_requests_total.upstream_circuit_open`
   - `upstream_responses_total.5xx`
   - `upstream_responses_total.timeout`
3. Confirm whether Cerebras status or network connectivity is degraded.
4. Verify configured API keys are active and not invalidated separately.

## Recovery

- If upstream is degraded, wait for the `Retry-After` interval and let half-open
  probing recover automatically.
- If failures are due to local networking, fix DNS/firewall/proxy configuration
  and retry after cooldown.
- If only one model is failing with `model_not_found`, update the model pool
  rather than changing the breaker.
- If all keys are invalid or rate-limited, rotate API keys; the circuit breaker
  is not the root cause.

## Escalation data

When reporting an incident, include:

- Example `requestId` values.
- The failing route and status code.
- Recent `upstream_responses_total` and `proxy_requests_total` counters.
- Deployment environment and approximate start time.
