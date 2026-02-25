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
- **Task-aware execution** — tracks in-flight tasks with `TaskSessionRegistry`; publishes `working` → `artifact-update` → final `Message` event sequence; supports task cancellation
- **Output normalization** — all Cognigy rich output types (quick replies, gallery, buttons, lists, Adaptive Cards) are automatically converted to A2A `Part` objects, always with a human-readable `TextPart`
- **Internal metadata filtering** — Cognigy's `_cognigy` metadata entries are stripped transparently
- **Socket connection pool** — persistent Socket.IO connections with exponential-backoff reconnect, idle-close, and per-session isolation
- **Structured logging** — pino JSON logs with AWS CloudWatch-compatible format
- **ENV substitution** — secrets never in config files; all values resolved from environment variables at startup

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
        ├─ TaskStatusUpdateEvent { state:'working', final:false }  ──► eventBus
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
                │  Cognigy 'output' event 1
                │    └─► onOutput(output, 0) → normalizeOutput
                │             └─► ArtifactUpdateEvent { id-0, lastChunk:false } ──► eventBus  ← client sees immediately
                │
                │  Cognigy 'output' event 2
                │    └─► onOutput(output, 1) → normalizeOutput
                │             └─► ArtifactUpdateEvent { id-1, lastChunk:false } ──► eventBus  ← client sees immediately
                │
                │  ... (N outputs streamed)
                │
                └─ Cognigy 'finalPing' → Promise resolves with outputs[]
        │
        ▼
  Re-publish last artifact with lastChunk:true ──► eventBus  ← signals stream end
        ▼
  normalizeOutputs(outputs)            ← all outputs assembled
        ▼
  Message { parts: Part[] }            ──► eventBus.publish()
  eventBus.finished()
```

**A2A event sequence for SOCKET agents:**

| # | Event | `final` | Description |
|---|---|---|---|
| 1 | `TaskStatusUpdateEvent` `working` | `false` | Task started |
| 2…N | `TaskArtifactUpdateEvent` | — | One per Cognigy output, streamed as they arrive |
| N+1 | `TaskStatusUpdateEvent` `completed` | `true` | Task finished — stream ended |

No `Message` is published for SOCKET agents. The `completed` status with `final:true` closes the task. A2A clients using `message/stream` see each artifact update in real time.

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
│   │   ├── IAdapter.ts                    # Strategy interface + OutputCallback + AdapterError
│   │   ├── RestAdapter.ts                 # Synchronous HTTP adapter
│   │   └── SocketAdapter.ts               # Async Socket.IO adapter with streaming callback
│   ├── config/
│   │   └── loader.ts                      # Config file loading + ENV resolution
│   ├── handlers/
│   │   └── CognigyAgentExecutor.ts        # A2A AgentExecutor — task-aware + streaming
│   ├── task/
│   │   ├── TaskSessionRegistry.ts         # In-flight task AbortController registry
│   │   └── TaskStoreFactory.ts            # Task store factory (memory / Redis)
│   ├── normalizer/
│   │   └── OutputNormalizer.ts            # Cognigy outputs → A2A Parts
│   ├── pool/
│   │   └── SocketConnectionPool.ts        # Socket connection lifecycle
│   ├── registry/
│   │   └── AgentRegistry.ts               # AgentCard generation + lookup
│   ├── types/
│   │   ├── agent.types.ts                 # Config + AgentCard types
│   │   └── cognigy.types.ts               # Cognigy output types + guards
│   ├── index.ts                           # Express server entry point
│   └── logger.ts                          # pino structured logger
├── tests/
│   ├── adapters/
│   │   └── RestAdapter.test.ts
│   ├── config/
│   │   └── loader.test.ts
│   ├── handlers/
│   │   └── CognigyAgentExecutor.test.ts
│   ├── normalizer/
│   │   └── OutputNormalizer.test.ts
│   ├── pool/
│   │   └── SocketConnectionPool.test.ts
│   ├── registry/
│   │   └── AgentRegistry.test.ts
│   └── task/
│       ├── TaskSessionRegistry.test.ts
│       └── TaskStoreFactory.test.ts
├── agents.config.json                     # Agent definitions (gitignored in prod)
├── .env.example                           # Environment variable template
├── jest.config.ts                         # Jest + ts-jest configuration
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
| `GATEWAY_BASE_URL` | ✅ | — | Public base URL of this gateway. Used in AgentCard `url` field. Example: `https://gateway.example.com` |
| `LOG_LEVEL` | ❌ | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`. |
| `LOG_PRETTY` | ❌ | `false` | Set to `true` for colored human-readable logs (development only). |
| `NODE_ENV` | ❌ | `development` | Included in all log entries for environment context. |
| `AGENTS_CONFIG_PATH` | ❌ | `./agents.config.json` | Absolute or relative path to the agents config file. |
| `TASK_STORE_TYPE` | ❌ | `memory` | Task store backend. `memory` (default) or `redis`. |
| `REDIS_URL` | ❌* | — | Redis connection URL. Required when `TASK_STORE_TYPE=redis`. Example: `redis://localhost:6379`. |
| `COGNIGY_FAQ_URL` | ✅* | — | Referenced by `agents.config.json` via `${COGNIGY_FAQ_URL}`. |
| `COGNIGY_FAQ_TOKEN` | ✅* | — | Referenced by `agents.config.json` via `${COGNIGY_FAQ_TOKEN}`. |
| `COGNIGY_BOOKING_URL` | ✅* | — | Referenced by `agents.config.json` via `${COGNIGY_BOOKING_URL}`. |
| `COGNIGY_BOOKING_TOKEN` | ✅* | — | Referenced by `agents.config.json` via `${COGNIGY_BOOKING_TOKEN}`. |

> ✅* = required if your `agents.config.json` references that variable. Any `${VAR}` placeholder in the config that resolves to an empty/missing environment variable will cause a `ConfigurationError` at startup — the gateway will refuse to start rather than silently use a broken URL.

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
| `GET` | `/health` | Health check. Returns `{ "status": "healthy", "agents": N, "timestamp": "..." }`. Use for ALB/load-balancer probes. |

### Example AgentCard Response

```json
{
  "name": "FAQ Assistant",
  "description": "Answers frequently asked questions using a synchronous Cognigy REST endpoint.",
  "protocolVersion": "0.3.0",
  "version": "1.0.0",
  "url": "https://gateway.example.com/agents/faq-agent/",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": false
  },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"],
  "skills": [
    {
      "id": "faq",
      "name": "FAQ",
      "description": "Answer product and service questions",
      "tags": ["faq", "support", "knowledge-base"]
    }
  ]
}
```

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
  readonly onOutput?: OutputCallback;       // NEW: streaming callback (SocketAdapter only)
}
```

The `onOutput` callback is the key to streaming. `SocketAdapter` invokes it once per `output` socket event as messages arrive from Cognigy — **before** `finalPing`. `CognigyAgentExecutor` uses it to publish a `TaskArtifactUpdateEvent` to the A2A event bus immediately, so A2A streaming clients see each output as it arrives. `RestAdapter` ignores `onOutput` entirely.

Both adapters throw `AdapterError` (which extends `Error`) on failure. `AdapterError` carries:
- `adapterType: 'REST' | 'SOCKET'`
- `cause?: unknown` — the original underlying error

---

### RestAdapter

**Use when:** Your Cognigy flow is a standard synchronous REST endpoint. Best for FAQs, simple Q&A, lookup flows where response time is under 8 seconds.

#### How it works

```
Client ──► CognigyAgentExecutor
                  │
                  ▼
          RestAdapter.send()
                  │
          axios.post(<endpointUrl>/<urlToken>, {
            userId,
            sessionId,
            text,
            data?
          })
                  │
          ◄── CognigyRestResponse {
                outputStack: [
                  { text: "Hello", data: { _cognigy: { _messageId: "..." } } },
                  { text: "",  data: { _cognigy: { _messageId: "...", _finishReason: "stop" } } }
                ]
              }
                  │
          filter isCognigyInternalEntry() ──► removes internal entries
                  │
          ◄── CognigyBaseOutput[]   (only real bot messages)
```

#### URL Construction

The Cognigy REST endpoint URL always follows this pattern:

```
POST https://<endpointUrl>/<urlToken>
```

The `urlToken` is appended as a path segment (not a query parameter). The adapter automatically strips any trailing slash from `endpointUrl` before appending to prevent double-slash URLs.

```typescript
// endpointUrl: "https://endpoint.cognigy.ai"
// urlToken:    "abc123def456"
// → baseURL:   "https://endpoint.cognigy.ai/abc123def456"
```

#### Request Body

```json
{
  "userId": "a2a-user-<contextId>",
  "sessionId": "<contextId>",
  "text": "User message text",
  "data": { "optional": "custom payload" }
}
```

The `data` field is omitted entirely when not provided (not sent as `null`).

#### Internal Entry Filtering

Cognigy appends internal metadata entries to `outputStack[]` that must never be forwarded to A2A clients. The adapter automatically removes them using `isCognigyInternalEntry()`.

A Cognigy-internal entry is defined as: **text is empty/null AND every top-level key in `data` is `_cognigy`**.

Two known variants:
```json
// Variant 1 — messageId-only (mid-stack)
{ "text": "", "data": { "_cognigy": { "_messageId": "d74b316c-..." } } }

// Variant 2 — finish marker (last entry)
{ "text": "", "data": { "_cognigy": { "_messageId": "d74b316c-...", "_finishReason": "stop" } } }
```

Real bot messages with `_cognigy` metadata are **not** filtered because they have non-empty `text`:
```json
// This is NOT filtered — text is present
{ "text": "Hello!", "data": { "_cognigy": { "_messageId": "..." } } }
```

#### Timeout & Error Handling

| Scenario | Behavior |
|---|---|
| Response received within 8s | ✅ Returns filtered `outputStack[]` |
| No response within 8s | ❌ `AdapterError`: "timed out after 8000ms" |
| HTTP 4xx/5xx | ❌ `AdapterError`: "failed with HTTP {status}" |
| Network failure | ❌ `AdapterError`: "failed with unexpected error" |
| Auth error (401/403) | ❌ `AdapterError`: "failed with HTTP 401/403" |

---

### SocketAdapter

**Use when:** Your Cognigy flow is an **agentic / multi-step** flow that requires a persistent connection, streaming outputs, or longer processing times. Best for booking assistants, complex workflows, flows that produce multiple messages.

#### How it works

```
Client ──► CognigyAgentExecutor
                  │
                  ▼
          SocketAdapter.send({ ..., onOutput })
                  │
          new SocketClient(endpointUrl, urlToken, {
            userId,
            sessionId,
            channel: 'socket-client',
            reconnection: false,
            forceWebsockets: true,
            ...
          })
                  │
          client.connect() → client.sendMessage(text, data)
                  │
          ◄── 'output' event 1
                  │  buildOutputsFromMessage() → CognigyBaseOutput[]
                  │  onOutput(output, 0)  ←── executor publishes ArtifactUpdateEvent immediately
                  │
          ◄── 'output' event 2
                  │  onOutput(output, 1)  ←── executor publishes ArtifactUpdateEvent immediately
                  │
          ◄── 'finalPing' event  ← signals flow is complete
                  │
          client.disconnect()
                  │
          ◄── CognigyBaseOutput[]  (full array — executor builds final Message)
```

#### Per-Session Client Isolation

Each `send()` call creates a **dedicated `SocketClient`** bound to the specific `userId` + `sessionId`. This is a deliberate design decision:

- `SocketClient` binds `userId` and `sessionId` at construction time
- A shared connection would cause **cross-session output pollution** (Session A receiving Session B's messages)
- Creating one client per session guarantees complete isolation
- The client is disconnected immediately after `finalPing` — no resource leaks

#### Output Collection and Streaming

The private `buildOutputsFromMessage()` method converts each socket `IMessage` into one or more `CognigyBaseOutput` objects. Each is immediately passed to `onOutput` before the next socket event arrives:

```
Socket 'output' event payload (IMessage):
├── message.text          → CognigyBaseOutput { text }         → onOutput(output, i)
├── message.data._cognigy._default._quickReplies               → onOutput(output, i)
├── message.data._cognigy._default._gallery                    → onOutput(output, i)
├── message.data._cognigy._default._buttons                    → onOutput(output, i)
├── message.data._cognigy._default._list                       → onOutput(output, i)
├── message.data._cognigy._default._adaptiveCard               → onOutput(output, i)
└── message.data (non-_cognigy, no text)                       → onOutput(output, i)
```

All outputs are also buffered internally so the adapter can return the full `CognigyBaseOutput[]` array when the Promise resolves after `finalPing`. `CognigyAgentExecutor` uses this to assemble the complete final `Message`.

#### Session Lifecycle & Timeout

```
connect() ──► sendMessage() ──► [output events...] ──► finalPing ──► disconnect()
                                      │
                              60s timeout guard
                              (AdapterError if finalPing never arrives)
```

| Event | Behavior |
|---|---|
| `finalPing` | ✅ Resolves with all collected outputs, disconnects client |
| `disconnect` (before finalPing) | ❌ `AdapterError`: "disconnected unexpectedly (reason: ...)" |
| `error` event | ❌ `AdapterError`: "socket error — ..." |
| 60s timeout | ❌ `AdapterError`: "session timed out after 60000ms" |
| `connect()` failure | ❌ `AdapterError`: "connect failed — ..." |

---

### SocketConnectionPool

The `SocketConnectionPool` is a **singleton** that manages long-lived `SocketClient` connections for health monitoring and future connection reuse. While `SocketAdapter` creates per-session clients for actual message exchange, the pool maintains agent-level connections for connection health tracking and discovery.

#### State Machine

Each connection in the pool transitions through these states:

```
                    ┌──────────────┐
                    │  CONNECTING  │  ← initial connect in progress
                    └──────┬───────┘
                 success   │   failure
                           ▼
                    ┌──────────────┐
              ┌────►│     IDLE     │  ← connected, no active sessions
              │     └──────┬───────┘   starts 5-min idle timer
              │  sessions  │ session
              │  ended=0   │ started
              │            ▼
              │     ┌──────────────┐
              └─────│    ACTIVE    │  ← connected, ≥1 active session
                    └──────┬───────┘   idle timer cancelled
                    error/ │ disconnect
                    network│
                           ▼
                    ┌──────────────┐
                    │ RECONNECTING │  ← exponential backoff wait
                    └──────┬───────┘
               success     │   max retries exceeded
                           │   or auth error
                           ▼
                    ┌──────────────┐
                    │     DEAD     │  ← permanent failure, removed from pool
                    └──────────────┘   emits 'poolDead' event
```

#### Reconnect Policy

| Attempt | Base delay | With ±20% jitter |
|---|---|---|
| 1 | 1s | 0.8s – 1.2s |
| 2 | 2s | 1.6s – 2.4s |
| 3 | 4s | 3.2s – 4.8s |
| 4 | 8s | 6.4s – 9.6s |
| 5 | 16s | 12.8s – 19.2s |
| 6 | 30s *(capped)* | 24s – 36s |

After 6 failed attempts → **DEAD**. Auth errors (HTTP 401/403, "unauthorized", "forbidden" in error message) → **immediate DEAD**, no retries.

#### Idle Connection Management

An IDLE connection that has had no session activity for **5 minutes** is automatically disconnected and removed from the pool. This prevents stale connections from accumulating.

#### Public API

```typescript
const pool = SocketConnectionPool.getInstance();

// Get or create a connection for an agent
const entry = await pool.getOrCreate(agentConfig);  // throws if DEAD

// Track session lifecycle (for ACTIVE/IDLE transitions)
pool.markSessionStarted('my-agent-id');
pool.markSessionEnded('my-agent-id');

// Query connection state
const state = pool.getState('my-agent-id');  // 'CONNECTING' | 'IDLE' | 'ACTIVE' | 'RECONNECTING' | 'DEAD' | null

// Force remove a connection
pool.remove('my-agent-id');
```

---

## 🔄 Output Normalization

`OutputNormalizer` converts every Cognigy output to A2A `Part[]`. The golden rule:

> **Every output always produces at least one `TextPart`**, even for rich structured content. This ensures text-only A2A clients (like CLI tools or basic chatbots) always get a readable response, while rich clients can additionally use the `DataPart`.

### Normalization Rules

| Cognigy Output Type | TextPart content | DataPart type |
|---|---|---|
| Plain text | `output.text` | *(none)* |
| `_quickReplies` | `output.text` + rendered list of titles | `quick_replies` |
| `_gallery` | List of `- title: subtitle` | `carousel` |
| `_buttons` | `output.text` + rendered list of titles | `buttons` |
| `_list` | Header + rendered list of `- title: subtitle` | `list` |
| `_adaptiveCard` | Extracted `TextBlock.text` values from `body[]` | `AdaptiveCard` |
| Custom data with `_fallbackText` | `_fallbackText` value | `cognigy/data` (with `_cognigy` + `_fallbackText` stripped) |
| Custom data without `_fallbackText` | *(no TextPart)* | `cognigy/data` (with `_cognigy` stripped) |
| Empty output | Empty string `""` | *(none, with a warning log)* |

### TextPart Rendering Examples

**Quick replies:**
```
What can I help you with?
- Book a flight
- Check my order
- Contact support
```

**Buttons:**
```
Please choose an option:
- Yes, confirm
- No, cancel
```

**List:**
```
Available products:
- Product A: Premium quality item
- Product B: Budget-friendly option
```

**Gallery:**
```
- Paris Package: 7 nights, flights included
- Rome Package: 5 nights, hotel only
```

**AdaptiveCard:**
```
Welcome to our service
Please fill in your details below
```

### DataPart Structure Examples

**Quick replies:**
```json
{
  "kind": "data",
  "data": {
    "type": "quick_replies",
    "payload": {
      "type": "quick_replies",
      "text": "What can I help you with?",
      "quickReplies": [
        { "contentType": "postback", "title": "Book a flight", "payload": "book_flight" }
      ]
    }
  }
}
```

**Custom data (after stripping `_cognigy` and `_fallbackText`):**
```json
{
  "kind": "data",
  "data": {
    "type": "cognigy/data",
    "payload": {
      "bookingId": "BK-12345",
      "status": "confirmed"
    }
  }
}
```

---

## 🚀 Getting Started

### Prerequisites

| Tool | Minimum Version | Notes |
|---|---|---|
| Node.js | **24.x** | Specified in `engines.node` in `package.json` |
| npm | **10.x** | Comes with Node.js 22+ |
| A Cognigy.AI account | — | You need at least one configured REST or Socket endpoint |

### Step 1 — Clone and install

```bash
git clone https://gitlab.com/your-org/cognigy-a2a-gateway.git
cd cognigy-a2a-gateway/gateway
npm install
```

### Step 2 — Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Gateway
PORT=3000
GATEWAY_BASE_URL=http://localhost:3000
LOG_LEVEL=debug
LOG_PRETTY=true
NODE_ENV=development

# Cognigy — REST agent example
COGNIGY_FAQ_URL=https://endpoint.cognigy.ai
COGNIGY_FAQ_TOKEN=your-faq-url-token-here

# Cognigy — Socket agent example
COGNIGY_BOOKING_URL=https://endpoint.cognigy.ai
COGNIGY_BOOKING_TOKEN=your-booking-url-token-here
```

> 🔑 Find your `endpointUrl` and `urlToken` in Cognigy.AI under **Deploy → Endpoints → {your endpoint} → Endpoint URL**. The URL looks like `https://endpoint.cognigy.ai/abc123def456` — the base URL is `https://endpoint.cognigy.ai` and `abc123def456` is the token.

### Step 3 — Configure agents

Edit `agents.config.json` to match your Cognigy endpoints:

```json
{
  "agents": [
    {
      "id": "my-bot",
      "name": "My Cognigy Bot",
      "description": "Customer support",
      "version": "1.0.0",
      "endpointType": "REST",
      "endpointUrl": "${COGNIGY_FAQ_URL}",
      "urlToken": "${COGNIGY_FAQ_TOKEN}",
      "skills": [
        {
          "id": "support",
          "name": "Support",
          "description": "Handles customer queries",
          "tags": ["support"]
        }
      ]
    }
  ]
}
```

### Step 4 — Start in development mode

```bash
npm run dev
```

You should see output like:
```
[12:00:00] INFO  AgentRegistry loaded 1 agent(s) { agentIds: ['my-bot'] }
[12:00:00] INFO  Registered agent: my-bot { endpointType: 'REST' }
[12:00:00] INFO  Cognigy A2A Gateway listening on port 3000
```

### Step 5 — Verify

```bash
# Health check
curl http://localhost:3000/health

# Discover all agents
curl http://localhost:3000/.well-known/agents.json

# Get specific agent card
curl http://localhost:3000/agents/my-bot/.well-known/agent-card.json

# Send a message
curl -X POST http://localhost:3000/agents/my-bot/ \
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
        "parts": [{ "kind": "text", "text": "Hello!" }]
      }
    }
  }'
```

---

## 🔨 Build

```bash
# Type-check only (no output files — fast CI check)
npm run build:check

# Full build (outputs compiled JS to dist/)
npm run build

# Clean build artifacts
npm run clean && npm run build
```

The `dist/` directory mirrors `src/` with compiled JavaScript. The entry point is `dist/index.js`.

---

## ▶️ Running

### Development (hot-reload)

```bash
npm run dev
```

Uses `nodemon` to watch `src/` and restart on any `.ts` file change. `ts-node` compiles on-the-fly — no build step needed.

### Production

```bash
npm run build
node dist/index.js
```

Or with PM2:
```bash
npm run build
pm2 start dist/index.js --name cognigy-a2a-gateway
```

Or with Docker (once Dockerfile is added in Phase 4):
```bash
docker build -t cognigy-a2a-gateway .
docker run -p 3000:3000 --env-file .env cognigy-a2a-gateway
```

### Environment-specific tips

| Environment | `LOG_PRETTY` | `LOG_LEVEL` | Notes |
|---|---|---|---|
| Local dev | `true` | `debug` | Human-readable colored logs |
| CI/CD | `false` | `info` | JSON logs for log aggregators |
| Production | `false` | `info` / `warn` | JSON logs, AWS CloudWatch compatible |

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

Coverage output:
```
All files  | ~95% stmts | ~85% branches | 100% funcs | ~97% lines
```

### Watch mode (during development)

```bash
npm run test:watch
```

### Run a single test file

```bash
npx jest tests/adapters/RestAdapter.test.ts
```

### Test structure

| Test file | What it covers |
|---|---|
| `tests/adapters/RestAdapter.test.ts` | URL construction, urlToken appending, internal entry filtering, timeout, HTTP errors, request body |
| `tests/adapters/SocketAdapter.test.ts` | Per-session client creation, output collection, finalPing, timeout, disconnect handling |
| `tests/normalizer/OutputNormalizer.test.ts` | All output types → Part conversion, text rendering, DataPart structure, empty guard |
| `tests/pool/SocketConnectionPool.test.ts` | State machine transitions, reconnect backoff, idle timeout, auth error handling |
| `tests/registry/AgentRegistry.test.ts` | AgentCard generation, multi-agent lookup, URL construction |
| `tests/config/loader.test.ts` | ENV substitution, missing variable errors, JSON parse errors, duplicate ID detection |
| `tests/task/TaskSessionRegistry.test.ts` | Register/deregister tasks, abort in-flight tasks, concurrent task tracking |
| `tests/task/TaskStoreFactory.test.ts` | Memory store (default), Redis store selection via `TASK_STORE_TYPE` |
| `tests/handlers/CognigyAgentExecutor.test.ts` | REST non-streaming path, SOCKET per-output artifact events, `lastChunk` signalling, task lifecycle, cancellation, error fallback |

### Writing new tests

All tests use **Jest + ts-jest**. REST adapter tests use `axios-mock-adapter` for HTTP mocking. Socket tests mock `@cognigy/socket-client` via Jest module mocking.

```typescript
// Example: test a new adapter scenario
import { RestAdapter } from '../../src/adapters/RestAdapter';
import MockAdapter from 'axios-mock-adapter';
import axios from 'axios';

const mock = new MockAdapter(axios);

it('handles my new scenario', async () => {
  mock.onPost('https://endpoint.cognigy.ai/mytoken').reply(200, {
    outputStack: [{ text: 'Hello', data: undefined }]
  });

  const adapter = new RestAdapter('agent-id', 'https://endpoint.cognigy.ai', 'mytoken');
  const result = await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' });

  expect(result).toHaveLength(1);
  expect(result[0]?.text).toBe('Hello');
});
```

---

## ☁️ Azure AI Foundry Integration

Azure AI Foundry supports A2A natively — it can call external agents using the same A2A protocol your gateway speaks.

### Architecture

```
User
 │
 ▼
Azure AI Foundry Agent  (GPT-4o, your system prompt)
 │
 │  A2A JSON-RPC
 ▼
Azure API Management  (exposes internal gateway to Azure)
 │
 │  HTTP forward (VNet)
 ▼
Cognigy A2A Gateway  (internal network)
 │
 ▼
Cognigy.AI
```

### Step 1 — Expose the gateway via Azure API Management

Since your gateway runs on an internal network, Azure AI Foundry (a cloud service) cannot reach it directly. Use **Azure API Management** as a bridge:

1. Create an APIM instance in the Azure Portal
2. Enable **VNet integration** so APIM can reach your internal host
3. Add a new API → HTTP type → set **Web Service URL** to `http://<internal-gateway-host>:3000`
4. Add two Operations:

| Name | Method | URL template |
|---|---|---|
| Get AgentCard | `GET` | `/agents/{agentId}/.well-known/agent-card.json` |
| A2A RPC | `POST` | `/agents/{agentId}/` |

Your public APIM URL will be something like `https://your-apim.azure-api.net`.

> 💡 **Dev/test only:** Skip APIM and use `ngrok http 3000` to get a temporary public URL for quick testing.

### Step 2 — Register the agent in Azure AI Foundry

1. Go to **Azure AI Foundry** → your project → **Agents** → **New Agent**
2. Choose your model (GPT-4o recommended)
3. Under **Connected agents** → **Add** → paste the AgentCard URL:
   ```
   https://your-apim.azure-api.net/agents/faq-agent/.well-known/agent-card.json
   ```
4. Foundry fetches the card, reads the skills, registers Cognigy as a callable sub-agent

### Step 3 — Configure the system prompt

```
You are a helpful assistant. When the user asks questions about products, 
policies, support, or FAQs, delegate to the FAQ skill.
Do not answer FAQ questions from your own knowledge — always route them 
to the faq skill for accurate, up-to-date answers.
```

### Step 4 — Verify connectivity

```bash
# Verify AgentCard is reachable from outside
curl https://your-apim.azure-api.net/agents/faq-agent/.well-known/agent-card.json

# Test A2A call end-to-end
curl -X POST https://your-apim.azure-api.net/agents/faq-agent/ \
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
        "parts": [{ "kind": "text", "text": "What is your return policy?" }]
      }
    }
  }'
```

If this `curl` returns a valid Cognigy response, Azure AI Foundry will work identically.

### Responsibility Matrix

| Concern | Your Gateway | Azure AI Foundry |
|---|---|---|
| A2A protocol | ✅ Server (already built) | ✅ Client (built-in) |
| Session ID (`contextId`) | Passes through to Cognigy | Generates per conversation |
| Auth | None (add APIM subscription key if needed) | Calls via APIM |
| Routing logic | Fixed by `agentId` in URL | Uses AgentCard skills to choose which agent |
| Cognigy communication | REST or Socket per `endpointType` | Transparent |

---

## 🧩 Extending the Gateway

### Adding a new agent

Simply add a new entry to `agents.config.json` and add the corresponding env vars. No code changes needed.

### Adding a new adapter type

1. Create `src/adapters/MyAdapter.ts` implementing `IAdapter`
2. Add `'MYTYPE'` to `CognigyEndpointType` in `agent.types.ts`
3. Add a `case 'MYTYPE':` in `CognigyAgentExecutor.createAdapter()`
4. Add validation in `config/loader.ts` → `VALID_ENDPOINT_TYPES`

### Adding a new Cognigy output type

1. Define the type interface in `cognigy.types.ts`
2. Add a type guard function (e.g. `isMyNewData(data)`)
3. Add a render function in `OutputNormalizer.ts`
4. Add the `else if (isMyNewData(data))` branch in `normalizeOutput()`
5. Add tests in `OutputNormalizer.test.ts`

### Adding authentication

The current gateway uses no auth. To add API key authentication, insert an Express middleware before the JSON-RPC handler in `index.ts`:

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

All logs are **structured JSON** using [pino](https://getpino.io/). Each log entry includes:

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

### Key log events

| `event` | Component | Meaning |
|---|---|---|
| `server.started` | Server | Gateway is up and listening |
| `agent.registered` | Server | An agent was successfully registered |
| `session.started` | Executor | A2A request received, processing started |
| `session.ended` | Executor | Response sent to A2A client |
| `session.error` | Executor | Error during processing, fallback message sent |
| `rest.request.start` | RestAdapter | HTTP POST to Cognigy initiated |
| `rest.request.success` | RestAdapter | HTTP response received |
| `rest.request.error` | RestAdapter | HTTP error or timeout |
| `session.started` | SocketAdapter | Socket session opened |
| `session.ended` | SocketAdapter | finalPing received, session closed |
| `session.error` | SocketAdapter | Error or timeout during session |
| `connection.creating` | SocketConnectionPool | New pool entry being created |
| `connection.created` | SocketConnectionPool | Pool connection established |
| `connection.dead` | SocketConnectionPool | Connection permanently dead |
| `reconnect.attempt` | SocketConnectionPool | Reconnect attempt with delay info |
| `reconnect.success` | SocketConnectionPool | Reconnect succeeded |
| `normalizer.empty_output` | OutputNormalizer | Cognigy output produced no Parts |

### Development logs

Set `LOG_PRETTY=true` and `LOG_LEVEL=debug` for colored, human-readable output:

```
12:00:00 INFO  [Server] Cognigy A2A Gateway listening on port 3000
12:00:01 INFO  [RestAdapter] Sending REST request to Cognigy { agentId: 'faq-agent', sessionId: 'abc' }
12:00:01 INFO  [RestAdapter] REST request completed { durationMs: 342, outputCount: 1 }
```

---

## 🗺 Roadmap

- [x] **Phase 1** — TypeScript project setup, config schema, ENV substitution, agent type system
- [x] **Phase 2** — Express server, AgentRegistry, AgentCard generation, RestAdapter, OutputNormalizer
- [x] **Phase 3** — SocketAdapter, SocketConnectionPool, reconnect logic, per-session isolation
- [x] **Phase 3.1** — Bug fixes: urlToken in RestAdapter, internal entry filtering, `_cognigy` metadata stripping
- [x] **Phase 3.2** — Task-aware execution: `TaskSessionRegistry`, `TaskStoreFactory`, `working` / `canceled` task lifecycle status events
- [x] **Phase 3.3** — True A2A streaming: `OutputCallback` in `IAdapter`, `SocketAdapter` fires callback per `output` event before `finalPing`, `CognigyAgentExecutor` publishes `TaskArtifactUpdateEvent` per output with `lastChunk` signalling
- [ ] **Phase 4** — Jest coverage to 100%, multi-stage Dockerfile, `.env.example`
- [ ] **Phase 5** — AWS CDK stacks (NetworkStack, DataStack, ComputeStack, ObservabilityStack)
- [ ] **Phase 6** — GitLab CI/CD pipeline (build → test → docker → deploy)
- [ ] **Phase 7** — Redis session store, Route 53 + WAF, auto scaling, go-live

---

## 📄 License

MIT — see [LICENSE](../LICENSE) for details.
