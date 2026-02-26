# 🤖 Cognigy A2A Gateway

A **production-grade Agent-to-Agent (A2A) protocol gateway** that exposes [Cognigy.AI](https://cognigy.com/) conversational flows as fully compliant A2A agents. Any A2A-compatible client — Azure AI Foundry, Microsoft Copilot Studio, LangChain, AutoGen, or any custom agent — can discover and call your Cognigy bots without writing a single line of Cognigy-specific integration code.

Built with **TypeScript 5**, **Express 5**, **@a2a-js/sdk 0.3.10**, and **@cognigy/socket-client 4.9**.

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Architecture](#-architecture)
- [Project Structure](#-project-structure)
- [Configuration](#-configuration)
- [Environment Variables](#-environment-variables)
- [HTTP API Reference](#-http-api-reference)
- [REST vs SOCKET: Message vs Task](#-rest-vs-socket-message-vs-task)
- [Adapters In Depth](#-adapters-in-depth)
  - [IAdapter — Strategy Interface](#iadapter--strategy-interface)
  - [RestAdapter](#restadapter)
  - [SocketAdapter](#socketadapter)
  - [SocketConnectionPool](#socketconnectionpool)
- [Output Normalization](#-output-normalization)
- [Request Lifecycle](#-request-lifecycle)
- [Getting Started](#-getting-started)
- [Build](#-build)
- [Running](#-running)
- [🐳 Docker Deployment](#-docker-deployment)
- [Testing](#-testing)
- [Azure AI Foundry Integration](#-azure-ai-foundry-integration)
- [Extending the Gateway](#-extending-the-gateway)
- [Logging](#-logging)
- [Roadmap](#-roadmap)

---

## 🌐 Overview

The gateway sits between **any A2A client** and **Cognigy.AI**, translating the open A2A JSON-RPC protocol into Cognigy's proprietary REST or Socket communication.

```
┌──────────────────────────┐        A2A JSON-RPC (HTTP)        ┌─────────────────────────────────────┐
│   Any A2A Client         │ ────────────────────────────────► │                                     │
│                          │                                    │     Cognigy A2A Gateway             │
│  • Azure AI Foundry      │ ◄──────────────────────────────── │                                     │
│  • Copilot Studio        │        A2A JSON-RPC Response       │  AgentRegistry → AgentExecutor      │
│  • LangChain / AutoGen   │                                    │       ↓                ↓            │
│  • Custom curl / app     │                                    │  RestAdapter    SocketAdapter       │
└──────────────────────────┘                                    │       ↓                ↓            │
                                                                │  Cognigy REST   Cognigy Socket      │
                                                                │  Endpoint       Endpoint            │
                                                                └─────────────────────────────────────┘
```

### ✨ Key Features

- **Dual transport** — REST (synchronous) and Socket.IO (async/agentic, streaming, multi-turn) endpoints
- **Multi-agent** — configure N independent agents, each with its own endpoint and skills
- **Full A2A compliance** — AgentCard discovery, JSON-RPC 2.0 message protocol, `TaskArtifactUpdateEvent` streaming, task lifecycle events, spec v0.3.0
- **Task-aware execution** — tracks in-flight tasks with `TaskSessionRegistry`; correct event sequences per adapter type; supports task cancellation
- **Output normalization** — all Cognigy rich output types (quick replies, gallery, buttons, lists, Adaptive Cards) are automatically converted to A2A `Part` objects, always with a human-readable `TextPart`
- **Internal metadata filtering** — Cognigy's `_cognigy` metadata entries are stripped transparently
- **Socket connection pool** — persistent Socket.IO connections with exponential-backoff reconnect, idle-close, and per-session isolation
- **Structured logging** — pino JSON logs with AWS CloudWatch-compatible format
- **ENV substitution** — secrets never in config files; all values resolved from environment variables at startup
- **Docker-ready** — multi-stage production `Dockerfile` + `docker-compose.yml` with Redis profile

---

## 🏗 Architecture

### Component Map

```
src/
├── index.ts                    # Express bootstrap — registers all routes
├── registry/
│   └── AgentRegistry.ts        # Loads config, builds AgentCards, O(1) lookup
├── config/
│   └── loader.ts               # Reads agents.config.json, resolves ${ENV} vars
├── handlers/
│   └── CognigyAgentExecutor.ts # A2A AgentExecutor — task-aware, streaming, orchestrates send + normalize
├── task/
│   ├── TaskSessionRegistry.ts  # In-flight task tracker (AbortController per taskId)
│   └── TaskStoreFactory.ts     # Task store factory (memory default, Redis optional)
├── adapters/
│   ├── IAdapter.ts             # Strategy interface + OutputCallback for streaming
│   ├── RestAdapter.ts          # HTTP POST via axios → Cognigy REST endpoint
│   └── SocketAdapter.ts        # Socket.IO per-session client → streams via OutputCallback
├── pool/
│   └── SocketConnectionPool.ts # Persistent connection lifecycle manager
├── normalizer/
│   └── OutputNormalizer.ts     # Cognigy outputStack[] → A2A Part[]
├── types/
│   ├── agent.types.ts          # Config schema types + A2A AgentCard types
│   └── cognigy.types.ts        # Cognigy output types + internal-entry guards
└── logger.ts                   # pino structured logger
```

### Data Flow (per request)

#### REST adapter — synchronous (no streaming)

```
POST /agents/{id}/
        │
        ▼
  @a2a-js/sdk jsonRpcHandler          ← validates JSON-RPC envelope
        │
        ▼
  CognigyAgentExecutor.execute()
        │
        └─ RestAdapter.send()
                │  POST <endpointUrl>/<urlToken>
                │  ← CognigyRestResponse { outputStack[] }
                │  filter isCognigyInternalEntry()
                └─► CognigyBaseOutput[]
        │
        ▼
  normalizeOutputs(outputs)            ← OutputNormalizer (all outputs at once)
        ▼
  Message { parts: Part[] }            ──► eventBus.publish()
  eventBus.finished()
```

#### SOCKET adapter — true streaming

```
POST /agents/{id}/
        │
        ▼
  @a2a-js/sdk jsonRpcHandler
        │
        ▼
  CognigyAgentExecutor.execute()
        │
        ├─ TaskStatusUpdateEvent { state:'working', final:false }  ──► eventBus
        │
        └─ SocketAdapter.send({ onOutput })
                │  connect → sendMessage
                │
                │  Cognigy 'output' event 1 → onOutput(output, 0) → normalizeOutput
                │    └─► ArtifactUpdateEvent { id-0 } ──► eventBus  ← client sees immediately
                │
                │  Cognigy 'output' event N → onOutput(output, N-1) → normalizeOutput
                │    └─► ArtifactUpdateEvent { id-N } ──► eventBus  ← client sees immediately
                │
                └─ Cognigy 'finalPing' → Promise resolves
        │
        ▼
  TaskStatusUpdateEvent { state:'completed', final:true }  ──► eventBus
  eventBus.finished()
```

**A2A event sequence for SOCKET agents:**

| # | Event | `final` | Description |
|---|---|---|---|
| 1 | `TaskStatusUpdateEvent` `working` | `false` | Task started |
| 2…N | `TaskArtifactUpdateEvent` | — | One per Cognigy output, streamed as they arrive |
| N+1 | `TaskStatusUpdateEvent` `completed` | `true` | Task finished — stream closed |

No `Message` is published for SOCKET agents. The `completed` status with `final:true` closes the task.

**Terminal status states:**

| Scenario | `state` |
|---|---|
| Flow completed normally | `completed` |
| Task cancelled | `canceled` |
| Adapter error / exception | `failed` |

---

## 📁 Project Structure

```
cognigy-a2a-gateway/
├── src/
│   ├── adapters/
│   │   ├── IAdapter.ts
│   │   ├── RestAdapter.ts
│   │   └── SocketAdapter.ts
│   ├── config/
│   │   └── loader.ts
│   ├── handlers/
│   │   └── CognigyAgentExecutor.ts
│   ├── task/
│   │   ├── TaskSessionRegistry.ts
│   │   └── TaskStoreFactory.ts
│   ├── normalizer/
│   │   └── OutputNormalizer.ts
│   ├── pool/
│   │   └── SocketConnectionPool.ts
│   ├── registry/
│   │   └── AgentRegistry.ts
│   ├── types/
│   │   ├── agent.types.ts
│   │   └── cognigy.types.ts
│   ├── index.ts
│   └── logger.ts
├── tests/                               # Mirrors src/ structure
├── agents.config.json                   # Agent definitions
├── .env.example                         # Environment variable template
├── Dockerfile                           # Multi-stage production image
├── docker-compose.yml                   # Compose: gateway + optional Redis
├── jest.config.ts
├── package.json
└── tsconfig.json
```

---

## ⚙️ Configuration

### `agents.config.json`

This file is the **single source of truth** for all agents served by the gateway. It is loaded once at startup. All string values support `${ENV_VAR}` substitution — secrets are never hardcoded.

```json
{
  "agents": [
    {
      "id": "faq-agent",
      "name": "FAQ Assistant",
      "description": "Answers frequently asked questions using a synchronous Cognigy REST endpoint.",
      "version": "1.0.0",
      "endpointType": "REST",
      "endpointUrl": "${COGNIGY_FAQ_URL}",
      "urlToken": "${COGNIGY_FAQ_TOKEN}",
      "skills": [
        {
          "id": "faq",
          "name": "FAQ",
          "description": "Answer product and service questions",
          "tags": ["faq", "support", "knowledge-base"]
        }
      ]
    },
    {
      "id": "booking-agent",
      "name": "Booking Assistant",
      "description": "Handles flight and hotel bookings using an agentic Cognigy flow.",
      "version": "1.0.0",
      "endpointType": "SOCKET",
      "endpointUrl": "${COGNIGY_BOOKING_URL}",
      "urlToken": "${COGNIGY_BOOKING_TOKEN}",
      "skills": [
        {
          "id": "booking",
          "name": "Travel Booking",
          "description": "Book flights, hotels, and rental cars",
          "tags": ["booking", "travel", "flights", "hotels"]
        }
      ]
    }
  ]
}
```

#### Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Unique agent identifier. Used in URL paths (`/agents/{id}/`). Must be URL-safe. |
| `name` | `string` | ✅ | Human-readable display name included in the AgentCard. |
| `description` | `string` | ✅ | Agent description included in the AgentCard. |
| `version` | `string` | ✅ | Agent version string (e.g. `"1.0.0"`). |
| `endpointType` | `"REST" \| "SOCKET"` | ✅ | Determines which adapter handles requests for this agent. |
| `endpointUrl` | `string` | ✅ | Cognigy endpoint base URL (e.g. `https://endpoint.cognigy.ai`). |
| `urlToken` | `string` | ✅ | Cognigy URL token. Appended as a path segment: `<endpointUrl>/<urlToken>`. |
| `skills[].id` | `string` | ✅ | Skill identifier used by A2A orchestrators to route requests. |
| `skills[].name` | `string` | ✅ | Human-readable skill name. |
| `skills[].description` | `string` | ✅ | Skill description used by AI clients for intent routing. |
| `skills[].tags` | `string[]` | ✅ | Searchable tags for skill discovery. |

> 💡 **How `urlToken` is used:** For `REST`, the final request URL is `POST <endpointUrl>/<urlToken>`. For `SOCKET`, the token is passed as the second argument to `new SocketClient(endpointUrl, urlToken, ...)`.

---

## 🔐 Environment Variables

Copy `.env.example` to `.env` and fill in your values before running locally.

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | ❌ | `3000` | HTTP port the Express server listens on. |
| `LOG_LEVEL` | ❌ | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`. |
| `LOG_PRETTY` | ❌ | `false` | Set to `true` for colored human-readable logs (development only). |
| `NODE_ENV` | ❌ | `development` | Included in all log entries for environment context. |
| `AGENTS_CONFIG_PATH` | ❌ | `./agents.config.json` | Absolute or relative path to the agents config file. |
| `TASK_STORE_TYPE` | ❌ | `memory` | Task store backend. `memory` (default) or `redis`. |
| `TASK_STORE_REDIS_URL` | ❌* | `redis://localhost:6379` | Redis connection URL. Required when `TASK_STORE_TYPE=redis`. |
| `TASK_STORE_REDIS_TTL_S` | ❌ | `3600` | Task TTL in Redis (seconds). |
| `TASK_STORE_REDIS_PREFIX` | ❌ | `a2a:task:` | Key prefix for task entries in Redis. |
| `COGNIGY_FAQ_URL` | ✅* | — | Referenced by `agents.config.json` via `${COGNIGY_FAQ_URL}`. |
| `COGNIGY_FAQ_TOKEN` | ✅* | — | Referenced by `agents.config.json` via `${COGNIGY_FAQ_TOKEN}`. |
| `COGNIGY_BOOKING_URL` | ✅* | — | Referenced by `agents.config.json` via `${COGNIGY_BOOKING_URL}`. |
| `COGNIGY_BOOKING_TOKEN` | ✅* | — | Referenced by `agents.config.json` via `${COGNIGY_BOOKING_TOKEN}`. |

> ✅* = required if your `agents.config.json` references that variable. Any `${VAR}` placeholder that resolves to an empty or missing env var causes a `ConfigurationError` at startup — the gateway refuses to start rather than run with a broken URL.

---

## 🌍 HTTP API Reference

Once running, the gateway exposes the following endpoints:

### Discovery

| Method | Path | Description |
|---|---|---|
| `GET` | `/.well-known/agents.json` | Returns an array of all registered AgentCards. Used by orchestrators to discover all available agents. |
| `GET` | `/agents` | Alias for `/.well-known/agents.json`. REST-convention discovery endpoint. |
| `GET` | `/agents/:id/.well-known/agent-card.json` | Returns the single AgentCard for a specific agent. This is the A2A spec §3.1 canonical discovery URL. |

### Invocation

| Method | Path | Description |
|---|---|---|
| `POST` | `/agents/:id/` | A2A JSON-RPC 2.0 endpoint. Send messages, receive agent responses. |

### Utility

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check. Returns `{ "status": "healthy", "agents": N, "timestamp": "..." }`. Use for load-balancer probes. |

### Example A2A Request / Response

**Request:**
```http
POST /agents/faq-agent/
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "message/send",
  "id": "req-001",
  "params": {
    "message": {
      "kind": "message",
      "messageId": "msg-uuid-1234",
      "role": "user",
      "contextId": "session-abc-xyz",
      "parts": [
        { "kind": "text", "text": "What is your return policy?" }
      ]
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "result": {
    "kind": "message",
    "messageId": "resp-uuid-5678",
    "role": "agent",
    "contextId": "session-abc-xyz",
    "parts": [
      { "kind": "text", "text": "You can return items within 30 days of purchase with a receipt." }
    ]
  }
}
```

> 💡 **Multi-turn conversations:** Keep `contextId` stable across all turns. The gateway maps `contextId` → `sessionId` in Cognigy, so Cognigy maintains conversation context automatically.

---

## 📬 REST vs SOCKET: Message vs Task

This is a fundamental design distinction in the gateway. The two adapter types produce **different A2A response patterns**.

### REST → delivers a `Message` directly

REST is synchronous and instant. You send a request, Cognigy processes it, and you get all outputs back in one HTTP response. There is nothing to stream and nothing to cancel. The A2A protocol `Message` is sufficient — no task lifecycle needed.

```
Client sends request
    │
    ▼
Gateway calls Cognigy REST  ──── waits ────►  all outputs returned at once
    │
    ▼
Message { parts: [output1, output2, ...] }   ← single complete response
```

The client receives exactly **1 event**: the final `Message`.

### SOCKET → wraps everything in a `Task`

SOCKET is asynchronous. Cognigy may stream back multiple outputs over several seconds. The flow could be cancelled mid-execution. This is exactly what the A2A **Task** concept was designed for — long-running, cancellable, streaming work.

```
Client sends request
    │
    ▼
Gateway opens Socket session
    │
    ▼
TaskStatusUpdateEvent { state: 'working',   final: false }  ← task has started
TaskArtifactUpdateEvent { output 1 }                       ← arrives immediately
TaskArtifactUpdateEvent { output 2 }                       ← arrives immediately
TaskArtifactUpdateEvent { output N }                       ← arrives immediately
TaskStatusUpdateEvent { state: 'completed', final: true }  ← task is done, stream closed
```

The client receives **N+2 events**: a `working` status, one artifact per Cognigy output (streamed progressively), then a `completed` status that closes the task. No `Message` is published.

If the task is cancelled the terminal status is `canceled`. If an error occurs it is `failed`.

### Quick comparison

| | REST | SOCKET |
|---|---|---|
| **Use for** | FAQ, lookup, simple Q&A | Booking, workflows, agentic flows |
| **Response model** | `Message` only | `Task` with artifact streaming |
| **A2A events sent** | `Message` | `working` → `ArtifactUpdate` × N → `completed` |
| **Streaming** | ❌ No | ✅ Yes, per Cognigy output |
| **Cancellable** | ❌ No | ✅ Yes, via `TaskSessionRegistry` |
| **Max wait time** | 8 seconds | 60 seconds |

---

## 🔌 Adapters In Depth

The gateway uses the **Strategy Pattern** for Cognigy communication. Both adapters implement the same `IAdapter` interface, and `CognigyAgentExecutor` selects the correct one at construction time based on `endpointType`.

### IAdapter — Strategy Interface

```typescript
/** Called by SocketAdapter for each Cognigy output event as it arrives, before finalPing. */
export type OutputCallback = (output: CognigyBaseOutput, index: number) => void;

interface IAdapter {
  readonly type: 'REST' | 'SOCKET';
  send(params: AdapterSendParams): Promise<ReadonlyArray<CognigyBaseOutput>>;
}

interface AdapterSendParams {
  readonly text: string;                    // User message
  readonly sessionId: string;               // Conversation session ID (=A2A contextId)
  readonly userId: string;                  // Stable user identifier
  readonly data?: Record<string, unknown>;  // Optional custom data payload
  readonly onOutput?: OutputCallback;       // Streaming callback (SocketAdapter only)
}
```

Both adapters throw `AdapterError` on failure, carrying `adapterType` and the original `cause`.

---

### RestAdapter

**Use when:** Your Cognigy flow is a standard synchronous REST endpoint. Best for FAQs, simple Q&A, lookup flows where response time is under 8 seconds.

#### Timeout & Error Handling

| Scenario | Behavior |
|---|---|
| Response received within 8s | ✅ Returns filtered `outputStack[]` |
| No response within 8s | ❌ `AdapterError`: "timed out after 8000ms" |
| HTTP 4xx/5xx | ❌ `AdapterError`: "failed with HTTP {status}" |
| Network failure | ❌ `AdapterError`: "failed with unexpected error" |

---

### SocketAdapter

**Use when:** Your Cognigy flow is an **agentic / multi-step** flow that requires streaming outputs or longer processing times. Best for booking assistants, complex workflows.

#### Session Lifecycle & Timeout

```
connect() ──► sendMessage() ──► [output events...] ──► finalPing ──► disconnect()
                                      │
                              60s timeout guard
```

| Event | Behavior |
|---|---|
| `finalPing` | ✅ Resolves with all collected outputs, disconnects client |
| `disconnect` (before finalPing) | ❌ `AdapterError`: "disconnected unexpectedly" |
| 60s timeout | ❌ `AdapterError`: "session timed out after 60000ms" |

---

### SocketConnectionPool

A **singleton** that manages long-lived agent-level `SocketClient` connections with exponential-backoff reconnect and 5-minute idle disconnect.

#### Reconnect Policy

| Attempt | Delay (with ±20% jitter) |
|---|---|
| 1 | ~1s |
| 2 | ~2s |
| 3 | ~4s |
| 4 | ~8s |
| 5 | ~16s |
| 6 | ~30s (max) |

After 6 failed attempts → **DEAD**. Auth errors (401/403) → **immediate DEAD**, no retries.

---

## 🔄 Output Normalization

`OutputNormalizer` converts every Cognigy output to A2A `Part[]`. The golden rule:

> **Every output always produces at least one `TextPart`**, even for rich structured content. This ensures text-only A2A clients always get a readable response, while rich clients can additionally use the `DataPart`.

### Normalization Rules

| Cognigy Output Type | TextPart content | DataPart type |
|---|---|---|
| Plain text | `output.text` | *(none)* |
| `_quickReplies` | `output.text` + rendered list of titles | `quick_replies` |
| `_gallery` | List of `- title: subtitle` | `carousel` |
| `_buttons` | `output.text` + rendered list of titles | `buttons` |
| `_list` | Header + rendered list of `- title: subtitle` | `list` |
| `_adaptiveCard` | Extracted `TextBlock.text` values from `body[]` | `AdaptiveCard` |
| Custom data with `_fallbackText` | `_fallbackText` value | `cognigy/data` |
| Custom data without `_fallbackText` | *(no TextPart)* | `cognigy/data` |

---

## 🚀 Getting Started

### Prerequisites

| Tool | Minimum Version |
|---|---|
| Node.js | **22.x** |
| npm | **10.x** |
| A Cognigy.AI account | — |

### Step 1 — Clone and install

```bash
git clone https://github.com/your-org/cognigy-a2a-gateway.git
cd cognigy-a2a-gateway/gateway
npm install
```

### Step 2 — Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your Cognigy endpoint URLs and tokens.

> 🔑 Find your endpoint URL in Cognigy.AI under **Deploy → Endpoints → {your endpoint} → Endpoint URL**. The URL looks like `https://endpoint.cognigy.ai/abc123` — the base URL is `https://endpoint.cognigy.ai` and `abc123` is the token.

### Step 3 — Start in development mode

```bash
npm run dev
```

### Step 4 — Verify

```bash
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/agents.json
```

---

## 🔨 Build

```bash
# Type-check only (fast CI check — no output files)
npm run build:check

# Full compile to dist/
npm run build

# Clean + rebuild
npm run clean && npm run build
```

---

## ▶️ Running

### Development (hot-reload)

```bash
npm run dev
```

### Production (Node.js)

```bash
npm run build
node dist/index.js
```

### Production (Docker)

See the [Docker Deployment](#-docker-deployment) section below.

### Environment tips

| Environment | `LOG_PRETTY` | `LOG_LEVEL` |
|---|---|---|
| Local dev | `true` | `debug` |
| CI/CD | `false` | `info` |
| Production | `false` | `info` / `warn` |

---

## 🐳 Docker Deployment

The gateway ships with a production-grade multi-stage `Dockerfile` and a `docker-compose.yml` supporting two deployment modes:

| Mode | Command | When to use |
|---|---|---|
| Gateway only (memory store) | `docker compose up` | Single instance, dev/staging |
| Gateway + Redis | `docker compose --profile redis up` | Multi-replica, persistent task state |

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 24+
- Docker Compose v2 (`docker compose`, not `docker-compose`)

---

### Step 1 — Create your env file

```bash
cp .env.example .env.docker
```

Edit `.env.docker` with your real values — this file is never committed:

```env
# ─── Server ───────────────────────────────────────────────────────────────────
PORT=3000
LOG_LEVEL=info
LOG_PRETTY=false

# ─── Task store ───────────────────────────────────────────────────────────────
TASK_STORE_TYPE=memory
# TASK_STORE_REDIS_URL=redis://redis:6379   # uncomment when using --profile redis

# ─── Cognigy credentials ──────────────────────────────────────────────────────
# Add one pair per agent defined in agents.config.json
COGNIGY_BOOKING_URL=https://endpoint-trial.cognigy.ai/socket/YOUR_WORKSPACE/YOUR_ENDPOINT
COGNIGY_BOOKING_TOKEN=your-booking-token-here
COGNIGY_FAQ_URL=https://endpoint-trial.cognigy.ai/YOUR_WORKSPACE/YOUR_ENDPOINT
COGNIGY_FAQ_TOKEN=your-faq-token-here
```

---

### Step 2 — Verify your agents.config.json

Make sure every `endpointUrl` and `urlToken` uses `${VAR}` placeholders that match the variables in `.env.docker`:

```json
{
  "agents": [
    {
      "id": "booking-agent",
      "endpointType": "SOCKET",
      "endpointUrl": "${COGNIGY_BOOKING_URL}",
      "urlToken": "${COGNIGY_BOOKING_TOKEN}",
      "..."
    }
  ]
}
```

The config file is mounted into the container as **read-only**. You never need to rebuild the image to change agent configuration — just edit the file and restart the container.

---

### Step 3 — Build and start

#### Option A — Gateway only (memory task store)

```bash
docker compose --env-file .env.docker up --build
```

Detached (background):

```bash
docker compose --env-file .env.docker up --build -d
```

#### Option B — Gateway + Redis (persistent task store)

Set `TASK_STORE_TYPE=redis` and uncomment `TASK_STORE_REDIS_URL` in `.env.docker`, then:

```bash
docker compose --env-file .env.docker --profile redis up --build -d
```

Redis data is persisted in a named Docker volume (`redis-data`) — task state survives container restarts.

---

### Step 4 — Verify

```bash
# Health check
curl http://localhost:3000/health
# Expected: {"status":"healthy","agents":2,"timestamp":"..."}

# Discover all agents
curl http://localhost:3000/.well-known/agents.json

# Send a test message
curl -X POST http://localhost:3000/agents/faq-agent/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "test-1",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "msg-1",
        "role": "user",
        "contextId": "test-session-001",
        "parts": [{"kind": "text", "text": "Hello!"}]
      }
    }
  }'
```

---

### Common commands

```bash
# View live logs
docker compose --env-file .env.docker logs -f gateway

# Restart gateway only (e.g. after agents.config.json change)
docker compose --env-file .env.docker restart gateway

# Rebuild image after source code change
docker compose --env-file .env.docker up --build -d

# Stop all containers
docker compose --env-file .env.docker down

# Stop and remove Redis volume (wipes all task state)
docker compose --env-file .env.docker --profile redis down -v

# Check running containers and health
docker compose --env-file .env.docker ps
```

---

### Build and push standalone image

For CI/CD pipelines that build and push separately:

```bash
# Build
docker build -t cognigy-a2a-gateway:latest .

# Tag for a registry
docker tag cognigy-a2a-gateway:latest registry.example.com/cognigy-a2a-gateway:1.0.0

# Push
docker push registry.example.com/cognigy-a2a-gateway:1.0.0

# Run from pushed image (no build needed)
docker run -d \
  -p 3000:3000 \
  --env-file .env.docker \
  -v $(pwd)/agents.config.json:/app/agents.config.json:ro \
  --name cognigy-a2a-gateway \
  registry.example.com/cognigy-a2a-gateway:1.0.0
```

---

### Startup error: missing environment variable

If a `${VAR}` placeholder in `agents.config.json` has no matching env var, the gateway **refuses to start** and logs:

```
ConfigurationError: Missing required environment variable "COGNIGY_BOOKING_TOKEN"
  referenced in config field "agents[0].urlToken"
```

Check that every `${VAR}` in your config has a corresponding line in `.env.docker`.

---

## 🧪 Testing

### Run all tests

```bash
npm test
```

### Run with coverage report

```bash
npm run test:coverage
```

### Watch mode

```bash
npm run test:watch
```

### Test structure

| Test file | What it covers |
|---|---|
| `tests/adapters/RestAdapter.test.ts` | URL construction, internal entry filtering, timeout, HTTP errors, request body |
| `tests/adapters/SocketAdapter.test.ts` | Per-session isolation, output streaming, finalPing, timeout, disconnect |
| `tests/normalizer/OutputNormalizer.test.ts` | All output types → Part conversion, text rendering, DataPart structure |
| `tests/pool/SocketConnectionPool.test.ts` | State machine transitions, reconnect backoff, idle timeout, auth errors |
| `tests/registry/AgentRegistry.test.ts` | AgentCard generation, multi-agent lookup, URL construction |
| `tests/config/loader.test.ts` | ENV substitution, missing variable errors, JSON parse errors, duplicate IDs |
| `tests/task/TaskSessionRegistry.test.ts` | Register/deregister tasks, abort in-flight tasks, concurrent tracking |
| `tests/task/TaskStoreFactory.test.ts` | Memory store (default), Redis store selection via `TASK_STORE_TYPE` |
| `tests/handlers/CognigyAgentExecutor.test.ts` | REST vs SOCKET event sequences, cancel, error, terminal status events |

---

## ☁️ Azure AI Foundry Integration

Azure AI Foundry supports A2A natively — it can call external agents using the same A2A protocol your gateway speaks.

### Architecture

```
User
 │
 ▼
Azure AI Foundry Agent  (GPT-4o, your system prompt)
 │  A2A JSON-RPC
 ▼
Azure API Management  (exposes internal gateway to Azure)
 │  HTTP forward (VNet)
 ▼
Cognigy A2A Gateway
 │
 ▼
Cognigy.AI
```

### Setup steps

1. Deploy the gateway (Docker or Node.js)
2. Expose it via **Azure API Management** (VNet integration) — or use `ngrok` for quick testing
3. In **Azure AI Foundry** → your project → **Agents** → **Connected agents** → paste the AgentCard URL:
   ```
   https://your-apim.azure-api.net/agents/faq-agent/.well-known/agent-card.json
   ```
4. Foundry fetches the card, reads the skills, and registers Cognigy as a callable sub-agent

---

## 🧩 Extending the Gateway

### Adding a new agent

Add a new entry to `agents.config.json` and provide the matching env vars. No code changes needed.

### Adding authentication

Insert an Express middleware before the JSON-RPC handler in `index.ts`:

```typescript
app.use(`/agents/${agentId}/`, (req, res, next) => {
  if (req.headers['x-api-key'] !== process.env['GATEWAY_API_KEY']) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}, jsonRpcHandler({ ... }));
```

---

## 📊 Logging

All logs are **structured JSON** using [pino](https://getpino.io/):

```json
{
  "level": "info",
  "time": "2025-01-01T12:00:00.000Z",
  "service": "cognigy-a2a-gateway",
  "env": "production",
  "component": "RestAdapter",
  "agentId": "faq-agent",
  "sessionId": "session-abc-123",
  "durationMs": 342,
  "event": "rest.request.success",
  "msg": "REST request completed"
}
```

Set `LOG_PRETTY=true` and `LOG_LEVEL=debug` for development:

```
12:00:00 INFO  [Server] Cognigy A2A Gateway listening on port 3000
12:00:01 INFO  [RestAdapter] REST request completed { durationMs: 342, outputCount: 1 }
```

---

## 🗺 Roadmap

- [x] **Phase 1** — TypeScript project setup, config schema, ENV substitution, agent type system
- [x] **Phase 2** — Express server, AgentRegistry, AgentCard generation, RestAdapter, OutputNormalizer
- [x] **Phase 3** — SocketAdapter, SocketConnectionPool, reconnect logic, per-session isolation
- [x] **Phase 3.1** — Bug fixes: urlToken in RestAdapter, internal entry filtering, `_cognigy` metadata stripping
- [x] **Phase 3.2** — Task-aware execution: `TaskSessionRegistry`, `TaskStoreFactory`, task lifecycle status events
- [x] **Phase 3.3** — True A2A streaming: `OutputCallback`, `TaskArtifactUpdateEvent` per output, correct terminal states
- [x] **Phase 3.4** — Production Dockerfile (multi-stage, node:22-alpine), `docker-compose.yml` with Redis profile
- [ ] **Phase 5** — AWS CDK stacks (NetworkStack, DataStack, ComputeStack, ObservabilityStack)
- [ ] **Phase 6** — GitLab CI/CD pipeline (build → test → docker → deploy)
- [ ] **Phase 7** — Route 53 + WAF, auto scaling, go-live

---

## 📄 License

MIT — see [LICENSE](../LICENSE) for details.
