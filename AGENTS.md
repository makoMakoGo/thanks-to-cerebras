# Repository Instructions

## Scope

These instructions apply to the whole repository. This project is a
Deno/TypeScript Cerebras API proxy with a same-origin admin UI and Deno KV
persistence.

## Architecture

- Keep `main.ts` as the entrypoint: compose startup, KV bootstrap, and the app
  handler only.
- Keep routing and middleware in `src/app.ts`; app code should reach services
  and KV through registered handlers.
- Keep HTTP handlers in `src/handlers/`; handlers validate requests, call
  services/KV helpers, and return sanitized responses.
- Keep upstream/business logic in `src/services/`; services must not import
  handlers, app routing, or UI.
- Keep Deno KV persistence in `src/kv/`; KV modules must not import handlers,
  services, app routing, or UI.
- Keep browser UI rendering in `src/ui/`; UI modules must not import handlers,
  services, KV, or app routing.
- Enforce boundaries with `deno task module-boundaries:check`.

## Validation

Run the focused checks for the files you changed, then run the full gate before
committing:

```sh
deno task fmt:check
deno task lint
deno task naming:check
deno task complexity:check
deno task module-boundaries:check
deno task agents:check
deno task large-files:check
deno task tech-debt:check
deno task duplicate-code:check
deno task unused-deps:check
deno task openapi:check
deno task check
deno task test:ci
deno task coverage:lcov
deno task coverage:check
deno task test:performance
deno task dast:check
```

For DAST, start the app with test-only environment values and point
`DAST_BASE_URL` at that local server.

## Security

- Never commit plaintext Cerebras API keys, proxy keys, admin tokens, or real
  environment values.
- Never log secrets. Logs must stay structured and include only safe metadata.
- Keep upstream and internal errors sanitized in HTTP responses.
- Do not add dependencies unless they are necessary and wired through
  `deno.lock`, CI, and unused-dependency checks.
- Keep API behavior changes reflected in `docs/openapi.json` and verified by
  `deno task openapi:check`.
