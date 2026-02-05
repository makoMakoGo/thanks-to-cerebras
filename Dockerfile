FROM denoland/deno:2.1.0

WORKDIR /app

COPY deno.json .
COPY main.ts .
COPY src/ ./src/

RUN mkdir -p /app/data

ENV KV_PATH=/app/data

RUN deno cache main.ts

EXPOSE 8339

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "main.ts"]
