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
  - [Event Routing: StatusMessage vs Artifact](#event-routing-statusmessage-vs-artifact)
  - [Human Text Generation](#human-text-generation)
  - [DataPart Preservation](#datapart-preservation)
  - [MIME Type Inference](#mime-type-inference)
  - [Adaptive Card Extraction](#adaptive-card-extraction)
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
- **Full A2A compliance** — AgentCard discovery, JSON-RPC 2.0 message protocol, task lifecycle events, spec v0.3.0
- **Task-aware execution** — tracks in-flight tasks with `TaskSessionRegistry`; correct event sequences per adapter type; supports task cancellation
- **Output normalization** — all Cognigy rich output types (quick replies, gallery, buttons, lists, Adaptive Cards, image, audio, video) are automatically converted to A2A events with correct routing per type
- **Dual A2A event routing** — conversational outputs → `TaskStatusUpdateEvent` with human-readable `TextPart` + structured `DataPart`; media outputs → `TaskArtifactUpdateEvent` with `FilePart` + MIME type
- **MIME type inference** — image/audio/video MIME types automatically inferred from URL extension
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
│   └── CognigyAgentExecutor.ts # A2A AgentExecutor — task-aware, routes NormalizedOutput to correct event type
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
│   └── OutputNormalizer.ts     # Cognigy outputStack[] → NormalizedOutput (StatusMessage | Artifact)
├── types/
│   ├── agent.types.ts          # Config schema types + A2A AgentCard types
│   └── cognigy.types.ts        # Cognigy output types + type guards (incl. image/audio/video)
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
  normalizeOutputs(outputs)            ← flattens all NormalizedOutput.parts into Part[]
        ▼
  Message { parts: Part[] }            ──► eventBus.publish()
  eventBus.finished()
```

#### SOCKET adapter — true streaming with event routing

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
                │  Cognigy 'output' event → onOutput(output, i) → normalizeOutput(output)
                │
                │    if NormalizedOutput.kind === 'status-message':
                │      └─► TaskStatusUpdateEvent { state:'working', message:{parts} } ──► eventBus
                │
                │    if NormalizedOutput.kind === 'artifact':
                │      └─► TaskArtifactUpdateEvent { artifact:{FilePart, TextPart} } ──► eventBus
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
| 1 | `TaskStatusUpdateEvent` `working` (no message) | `false` | Task opened |
| 2…N | `TaskStatusUpdateEvent` `working` + `message` | `false` | Per conversational output (text, quick replies, etc.) |
| 2…N | `TaskArtifactUpdateEvent` | — | Per media output (image, audio, video) |
| N+1 | `TaskStatusUpdateEvent` `completed` | `true` | Task closed — stream ends |

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

> ✅* = required if your `agents.config.json` references that variable. Any `${VAR}` placeholder that resolves to an empty or missing env var causes a `ConfigurationError` at startup.

---

## 🌍 HTTP API Reference

Once running, the gateway exposes the following endpoints:

### Discovery

| Method | Path | Description |
|---|---|---|
| `GET` | `/.well-known/agents.json` | Returns an array of all registered AgentCards. |
| `GET` | `/agents` | Alias for `/.well-known/agents.json`. |
| `GET` | `/agents/:id/.well-known/agent-card.json` | Returns the AgentCard for a specific agent (A2A spec §3.1). |

### Invocation

| Method | Path | Description |
|---|---|---|
| `POST` | `/agents/:id/` | A2A JSON-RPC 2.0 endpoint. Send messages, receive agent responses. |

### Utility

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check. Returns `{ "status": "healthy", "agents": N, "timestamp": "..." }`. |

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

REST is synchronous. You send a request, Cognigy processes it, all outputs come back at once. The A2A `Message` is sufficient — no task lifecycle needed.

The client receives exactly **1 event**: the final `Message` containing all parts flattened together (including any FilePart for media outputs, since streaming is not available on REST).

### SOCKET → wraps everything in a `Task` with event routing

SOCKET is asynchronous and streaming. The executor routes each `NormalizedOutput` to the correct A2A event type as it arrives:

```
TaskStatusUpdateEvent { state:'working', final:false }     ← task opened

  — conversational outputs get status-update events with message parts —
TaskStatusUpdateEvent { state:'working', message:{parts}, final:false }   ← text / quick replies / buttons / etc.

  — media outputs get artifact-update events —
TaskArtifactUpdateEvent { artifact:{ FilePart, TextPart } }               ← image / audio / video

TaskStatusUpdateEvent { state:'completed', final:true }    ← task closed
```

### Quick comparison

| | REST | SOCKET |
|---|---|---|
| **Use for** | FAQ, lookup, simple Q&A | Booking, workflows, agentic flows |
| **Response model** | `Message` only | `Task` with status + artifact streaming |
| **Conversational outputs** | `Message.parts[]` | `TaskStatusUpdateEvent` + `message.parts[]` |
| **Media outputs** | `Message.parts[]` (inline FilePart) | `TaskArtifactUpdateEvent` with FilePart |
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
  readonly text: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly data?: Record<string, unknown>;
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

The SocketAdapter unwraps Cognigy's `data._cognigy._default.<type>` envelope so OutputNormalizer receives the payload at the top level. It also detects media data fields (`_image`, `_audio`, `_video`) in `message.data` and emits them as separate outputs.

#### Session Lifecycle & Timeout

```
connect() ──► sendMessage() ──► [output events...] ──► finalPing ──► disconnect()
                                      │
                              60s timeout guard
```

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

`OutputNormalizer` converts every Cognigy output into a typed `NormalizedOutput` discriminated union, and `CognigyAgentExecutor` routes it to the correct A2A event type.

### Event Routing: StatusMessage vs Artifact

The normalizer returns one of two shapes:

```typescript
// Conversational output → rides in TaskStatusUpdateEvent.status.message
interface StatusMessageOutput {
  kind: 'status-message';
  parts: Part[];           // [TextPart, DataPart?]
}

// Binary media output → rides in TaskArtifactUpdateEvent.artifact
interface ArtifactOutput {
  kind: 'artifact';
  parts: Part[];           // [FilePart, TextPart]
  mimeType: string;        // inferred from URL extension
  name: string;            // filename extracted from URL
  fileUrl: string;
}
```

The executor checks `normalized.kind` and publishes accordingly:

```
kind === 'status-message'
  → TaskStatusUpdateEvent { state:'working', message:{ parts } }

kind === 'artifact'
  → TaskArtifactUpdateEvent { artifact:{ name, parts:[FilePart, TextPart] } }
```

### Human Text Generation

Every output type always produces at least one `TextPart` — ensuring text-only A2A clients (including pure LLM agents) always get a readable response, regardless of the Cognigy output type.

| Cognigy Output Type | TextPart content |
|---|---|
| Plain text | `output.text` verbatim |
| `_quickReplies` | Label + `- <title> ![image](<imageUrl>)` per option (imageUrl if non-empty) |
| `_buttons` | Label + `- <title>` / `- <title>: <url>` for `web_url` type buttons |
| `_list` | Header + `- <title>: <subtitle> ![image](<imageUrl>)` per item (imageUrl if non-empty) |
| `_gallery` | `output.text` (or "Here are some options:") + `- <title>: <subtitle> ![image](<imageUrl>)` per card |
| `_adaptiveCard` | All TextBlocks + FactSet rows + Input labels + Action titles (see below) |
| Custom data with `_fallbackText` | `_fallbackText` value |
| Custom data without `_fallbackText` | *(empty TextPart)* |
| Image | `[Image: <url>]` |
| Audio | `[Audio: <url>]` |
| Video | `[Video: <url>]` |

#### Gallery intro sentence

Gallery outputs use `output.text` as the intro sentence when present. When `output.text` is null (Cognigy sends `text: null` alongside the gallery payload), the intro defaults to `"Here are some options:"`. This ensures LLM agents always receive a complete, grammatically correct description.

### DataPart Preservation

For all structured types, the original Cognigy payload is preserved verbatim in a `DataPart`. Downstream agents that understand Cognigy formats can read the full payload; agents that don't simply ignore it.

```json
{
  "kind": "data",
  "data": {
    "type": "quick_replies",
    "payload": {
      "text": "Choose your topic",
      "quickReplies": [
        { "title": "Billing", "payload": "billing" },
        { "title": "Technical Support", "payload": "tech" }
      ]
    }
  }
}
```

| Cognigy Type | DataPart `type` field |
|---|---|
| `_quickReplies` | `quick_replies` |
| `_gallery` | `carousel` |
| `_buttons` | `buttons` |
| `_list` | `list` |
| `_adaptiveCard` | `AdaptiveCard` |
| Custom data | `cognigy/data` |
| Image / Audio / Video | *(no DataPart — `FilePart` instead)* |

Cognigy-internal keys (`_fallbackText`, `_cognigy`) are stripped before the DataPart is created.

### MIME Type Inference

Image, audio, and video outputs include a `FilePart` with the media URL and an inferred MIME type based on the URL file extension:

| Category | Supported extensions |
|---|---|
| Image | `jpg`, `jpeg`, `png`, `gif`, `webp`, `svg`, `bmp`, `ico` |
| Audio | `mp3`, `ogg`, `wav`, `m4a`, `aac`, `flac`, `webm` |
| Video | `mp4`, `webm`, `ogg`, `avi`, `mov`, `mkv`, `m4v` |

Unknown extensions fall back to `image/jpeg`, `audio/mpeg`, or `video/mp4` respectively. Query strings are stripped before extension detection.

### Adaptive Card Extraction

The Adaptive Card renderer performs a **recursive deep extraction** across all known card element types, producing a single readable text block that an LLM agent can interpret without knowledge of the Adaptive Card schema:

| Element type | Extracted content |
|---|---|
| `TextBlock` | `.text` value |
| `FactSet` | `"<title>: <value>"` per fact |
| `Input.Text`, `Input.Date`, `Input.Number`, `Input.Time` | Label + placeholder |
| `Input.ChoiceSet` | Label + `"- <title>"` per choice |
| `Input.Toggle` | `.title` text |
| `ColumnSet` | Recurses into `columns[].items` |
| `Container` | Recurses into `items` |
| `Action.*` | `"[Action: <title>]"` |

This means an LLM agent reading the TextPart from an Adaptive Card can see both the card's displayed content (TextBlocks) and understand what inputs/choices it is presenting to the user (Input fields, choices, actions).

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

---

## 🐳 Docker Deployment

The gateway ships with a production-grade multi-stage `Dockerfile` and a `docker-compose.yml` supporting two deployment modes:

| Mode | Command | When to use |
|---|---|---|
| Gateway only (memory store) | `docker compose up` | Single instance, dev/staging |
| Gateway + Redis | `docker compose --profile redis up` | Multi-replica, persistent task state |

### Step 1 — Create your env file

```bash
cp .env.example .env.docker
```

Edit `.env.docker` with your real values:

```env
PORT=3000
LOG_LEVEL=info
LOG_PRETTY=false
TASK_STORE_TYPE=memory
COGNIGY_BOOKING_URL=https://endpoint-trial.cognigy.ai/socket/YOUR_WORKSPACE/YOUR_ENDPOINT
COGNIGY_BOOKING_TOKEN=your-booking-token-here
COGNIGY_FAQ_URL=https://endpoint-trial.cognigy.ai/YOUR_WORKSPACE/YOUR_ENDPOINT
COGNIGY_FAQ_TOKEN=your-faq-token-here
```

### Step 2 — Build and start

```bash
# Gateway only
docker compose --env-file .env.docker up --build

# Gateway + Redis
docker compose --env-file .env.docker --profile redis up --build -d
```

### Step 3 — Verify

```bash
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/agents.json
```

### Common commands

```bash
docker compose --env-file .env.docker logs -f gateway
docker compose --env-file .env.docker restart gateway
docker compose --env-file .env.docker up --build -d
docker compose --env-file .env.docker down
```

---

## 🧪 Testing

```bash
npm test                  # run all tests
npm run test:coverage     # with coverage report
npm run test:watch        # watch mode
```

### Test structure

| Test file | What it covers |
|---|---|
| `tests/adapters/RestAdapter.test.ts` | URL construction, internal entry filtering, timeout, HTTP errors, request body |
| `tests/adapters/SocketAdapter.test.ts` | Per-session isolation, output streaming, finalPing, timeout, disconnect |
| `tests/normalizer/OutputNormalizer.test.ts` | All output types → NormalizedOutput, TextPart content, DataPart structure, MIME inference, Adaptive Card extraction |
| `tests/pool/SocketConnectionPool.test.ts` | State machine transitions, reconnect backoff, idle timeout, auth errors |
| `tests/registry/AgentRegistry.test.ts` | AgentCard generation, multi-agent lookup, URL construction |
| `tests/config/loader.test.ts` | ENV substitution, missing variable errors, JSON parse errors, duplicate IDs |
| `tests/task/TaskSessionRegistry.test.ts` | Register/deregister tasks, abort in-flight tasks, concurrent tracking |
| `tests/task/TaskStoreFactory.test.ts` | Memory store (default), Redis store selection via `TASK_STORE_TYPE` |
| `tests/handlers/CognigyAgentExecutor.test.ts` | REST vs SOCKET event sequences, status-message vs artifact routing, cancel, error, terminal states |

---

## ☁️ Azure AI Foundry Integration

In **Azure AI Foundry** → your project → **Agents** → **Connected agents** → paste the AgentCard URL:

```
https://your-apim.azure-api.net/agents/faq-agent/.well-known/agent-card.json
```

Foundry fetches the card, reads the skills, and registers Cognigy as a callable sub-agent.

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
  "component": "CognigyAgentExecutor",
  "agentId": "booking-agent",
  "taskId": "task-uuid",
  "statusMessageCount": 3,
  "artifactCount": 1,
  "durationMs": 4200,
  "event": "session.ended",
  "msg": "A2A request completed"
}
```

Set `LOG_PRETTY=true` and `LOG_LEVEL=debug` for development.

---

## 🗺 Roadmap

- [x] **Phase 1** — TypeScript project setup, config schema, ENV substitution, agent type system
- [x] **Phase 2** — Express server, AgentRegistry, AgentCard generation, RestAdapter, OutputNormalizer
- [x] **Phase 3** — SocketAdapter, SocketConnectionPool, reconnect logic, per-session isolation
- [x] **Phase 3.1** — Bug fixes: urlToken in RestAdapter, internal entry filtering, `_cognigy` metadata stripping
- [x] **Phase 3.2** — Task-aware execution: `TaskSessionRegistry`, `TaskStoreFactory`, task lifecycle status events
- [x] **Phase 3.3** — True A2A streaming: `OutputCallback`, `TaskArtifactUpdateEvent` per output, correct terminal states
- [x] **Phase 3.4** — Production Dockerfile (multi-stage, node:22-alpine), `docker-compose.yml` with Redis profile
- [x] **Phase 3.5** — Output normalization refactor: `NormalizedOutput` discriminated union, `StatusMessageOutput` → `TaskStatusUpdateEvent`, `ArtifactOutput` → `TaskArtifactUpdateEvent`, MIME type inference, full Adaptive Card extraction, image/audio/video type guards
- [ ] **Phase 5** — AWS CDK stacks (NetworkStack, DataStack, ComputeStack, ObservabilityStack)
- [ ] **Phase 6** — GitLab CI/CD pipeline (build → test → docker → deploy)
- [ ] **Phase 7** — Route 53 + WAF, auto scaling, go-live

---

## 📄 License

MIT — see [LICENSE](../LICENSE) for details.
