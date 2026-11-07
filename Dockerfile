FROM oven/bun:1.4.4 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

# exec form: bun is PID 1 and receives SIGTERM directly from `docker stop`.
CMD ["bun", "src/main.ts"]
