FROM denoland/deno:2.6.8

WORKDIR /app

COPY deno.json deno.lock .
COPY main.ts .
COPY src/ ./src/

RUN mkdir -p /app/data

ENV KV_PATH=/app/data

RUN deno cache main.ts

EXPOSE 8339

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD deno eval "const r = await fetch('http://localhost:8339/healthz'); if (!r.ok) Deno.exit(1);"

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "main.ts"]
