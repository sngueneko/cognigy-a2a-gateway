# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║           Cognigy A2A Gateway — Production Dockerfile                       ║
# ║                                                                              ║
# ║  Multi-stage build:                                                          ║
# ║    Stage 1 (builder) — install all deps + compile TypeScript to /dist        ║
# ║    Stage 2 (runner)  — copy only dist + prod deps, run as non-root user      ║
# ║                                                                              ║
# ║  Build:                                                                      ║
# ║    docker build -t cognigy-a2a-gateway:latest .                              ║
# ║                                                                              ║
# ║  Run (minimal):                                                              ║
# ║    docker run -p 3000:3000 \                                                 ║
# ║      -v $(pwd)/agents.config.json:/app/agents.config.json:ro \               ║
# ║      cognigy-a2a-gateway:latest                                              ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /build

# Copy manifests first for layer caching — npm ci only re-runs when these change
COPY package.json package-lock.json ./

# Install ALL dependencies (including devDependencies needed for tsc)
RUN npm ci --ignore-scripts

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build


# ── Stage 2: Production runner ────────────────────────────────────────────────
FROM node:22-alpine AS runner

# ── Labels ────────────────────────────────────────────────────────────────────
LABEL org.opencontainers.image.title="Cognigy A2A Gateway"
LABEL org.opencontainers.image.description="A2A protocol gateway bridging A2A consumers to Cognigy.AI endpoints"
LABEL org.opencontainers.image.source="https://github.com/sngueneko/cognigy-a2a-gateway"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled output from builder stage
COPY --from=builder /build/dist ./dist

# ── Non-root user ─────────────────────────────────────────────────────────────
# Run as an unprivileged user — never run Node.js servers as root in production
RUN addgroup -S gateway && adduser -S -G gateway gateway
USER gateway

# ── Environment variables ─────────────────────────────────────────────────────
#
# All variables are listed here with their defaults and descriptions.
# Override at runtime via -e / --env-file / Kubernetes ConfigMap+Secret.
#
# ─── Server ───────────────────────────────────────────────────────────────────
#
# PORT
#   TCP port the Express server listens on inside the container.
#   Map to host with -p <host_port>:3000
ENV PORT=3000

# NODE_ENV
#   Node.js environment. Must be "production" in production.
#   Controls Express behaviour (error detail, caching) and log base field.
ENV NODE_ENV=production

# ─── Logging ──────────────────────────────────────────────────────────────────
#
# LOG_LEVEL
#   Pino log level. One of: trace | debug | info | warn | error
#   Use "info" in production. Use "debug" only when diagnosing issues.
ENV LOG_LEVEL=info

# LOG_PRETTY
#   Set to "true" to enable pino-pretty human-readable output.
#   ALWAYS leave as "false" in production — structured JSON is required
#   for log aggregators (CloudWatch, Datadog, Loki, etc.).
ENV LOG_PRETTY=false

# ─── Agent configuration ──────────────────────────────────────────────────────
#
# AGENTS_CONFIG_PATH
#   Absolute or relative (to /app) path to the agents.config.json file.
#   In production, mount the file as a read-only volume or ConfigMap:
#     -v /host/path/agents.config.json:/app/agents.config.json:ro
#   The config file may use ${ENV_VAR} placeholders — they are resolved
#   at startup from the container environment (see Cognigy credentials below).
ENV AGENTS_CONFIG_PATH=/app/agents.config.json

# ─── Task store ───────────────────────────────────────────────────────────────
#
# TASK_STORE_TYPE
#   Backend used to persist A2A task state.
#   "memory" — in-process, no deps, zero latency. Not suitable for
#              multi-replica deployments (tasks are not shared between pods).
#   "redis"  — Redis-backed, persistent, shared across replicas.
#              Requires ioredis: npm install ioredis (add to dependencies first).
ENV TASK_STORE_TYPE=memory

# TASK_STORE_REDIS_URL
#   Redis connection URL. Only used when TASK_STORE_TYPE=redis.
#   Format: redis[s]://[[username]:password@]host[:port][/db]
#   Example with TLS (ElastiCache, Redis Cloud): rediss://host:6380
# ENV TASK_STORE_REDIS_URL=redis://localhost:6379

# TASK_STORE_REDIS_TTL_S
#   TTL in seconds for task entries stored in Redis.
#   Tasks older than this are automatically evicted.
#   Default: 3600 (1 hour). Increase for long-running flows.
# ENV TASK_STORE_REDIS_TTL_S=3600

# TASK_STORE_REDIS_PREFIX
#   Key prefix for all task entries in Redis.
#   Useful when sharing a Redis instance across multiple services.
#   Default: "a2a:task:"
# ENV TASK_STORE_REDIS_PREFIX=a2a:task:

# ─── Cognigy credentials ──────────────────────────────────────────────────────
#
# These variables are referenced inside agents.config.json via ${VAR_NAME}
# placeholders and are resolved at gateway startup.
#
# Add one block per agent defined in your agents.config.json.
# Inject at runtime — NEVER bake secrets into the image.
#
# Example — booking agent (Socket endpoint):
# ENV COGNIGY_BOOKING_URL=https://endpoint-trial.cognigy.ai/socket/WORKSPACE_ID/ENDPOINT_ID
# ENV COGNIGY_BOOKING_TOKEN=your-url-token-here
#
# Example — FAQ agent (REST endpoint):
# ENV COGNIGY_FAQ_URL=https://endpoint-trial.cognigy.ai/WORKSPACE_ID/ENDPOINT_ID
# ENV COGNIGY_FAQ_TOKEN=your-url-token-here

# ─── Observability (optional) ─────────────────────────────────────────────────
#
# METRICS_NAMESPACE
#   Namespace prefix for custom CloudWatch / Datadog metrics (future use).
# ENV METRICS_NAMESPACE=CognigyA2AGateway

# ── Health check ──────────────────────────────────────────────────────────────
# Docker / Kubernetes will probe GET /health every 30 s.
# The gateway exits with a non-zero code if /health returns non-2xx.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

# ── Expose & start ────────────────────────────────────────────────────────────
EXPOSE ${PORT}

CMD ["node", "dist/index.js"]
