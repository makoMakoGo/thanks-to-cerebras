# Deployment Readiness Runbook

## Purpose

Use this runbook when a new deployment starts, a container restarts, or traffic
should only be sent to a fully initialized instance.

## Signals

- `/healthz` is liveness only. It returns `200 ok` when the HTTP process is
  alive.
- `/readyz` is readiness. It checks required runtime prerequisites without
  calling Cerebras upstream.
- `x-request-id` is emitted on every response and in the `http_request`
  structured log event.

## Required runtime configuration

- `KEY_ENCRYPTION_SECRET` must be set before reading or writing stored API keys.
- `SETUP_TOKEN` must be set until the first admin password is created.
- `KV_PATH` is optional for local/Docker deployments and controls the local Deno
  KV directory.
- `PORT` is optional locally and defaults to `8339`.

## Triage

1. Check liveness:
   ```sh
   curl -fsS "$BASE_URL/healthz"
   ```
2. Check readiness:
   ```sh
   curl -fsS "$BASE_URL/readyz"
   ```
3. If `/healthz` passes but `/readyz` returns `503`, inspect the JSON `checks`
   object:
   - `keyEncryptionSecret`: set or fix `KEY_ENCRYPTION_SECRET`.
   - `kv`: verify Deno KV availability and local KV path permissions.
   - `config`: verify the KV config shape is compatible.
4. Inspect logs by `requestId` from the failing response.
5. For Docker or VPS, ensure the process was started with `deno task start` and
   the same environment used during initialization.

## Recovery

- Missing secret: set the environment variable and restart.
- Local KV permission error: fix the `KV_PATH` directory ownership/permissions
  and restart.
- Incompatible KV config: stop traffic, back up KV, then clear or migrate the KV
  store before restart.
- Failed DAST after deployment: keep traffic disabled and run
  `deno task dast:check` against the candidate instance.
