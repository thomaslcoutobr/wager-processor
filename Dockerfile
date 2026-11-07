FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Test image: same runtime plus the test tree. Used by `docker compose run --rm tests`.
FROM deps AS test
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
ENV NODE_ENV=test
CMD ["bun", "run", "test"]

FROM deps AS app
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3000
# exec form: bun is PID 1 and receives SIGTERM directly from `docker stop`.
CMD ["bun", "src/main.ts"]
