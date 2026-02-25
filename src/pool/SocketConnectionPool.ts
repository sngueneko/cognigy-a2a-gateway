/**
 * @fileoverview SocketConnectionPool — manages persistent Cognigy SocketClient connections.
 *
 * One connection per agent (keyed by agentId). Connections are created on-demand
 * and reused for session multiplexing. Idle connections are closed after 5 minutes
 * of inactivity.
 *
 * State machine per connection:
 *   CONNECTING  → initial connect in progress
 *   IDLE        → connected, no active sessions
 *   ACTIVE      → connected, ≥1 active session
 *   RECONNECTING → network error, exponential backoff in progress
 *   DEAD        → permanently failed (auth error, or max retries exceeded)
 *
 * Reconnect policy:
 *   - Auth errors (401/403): immediate DEAD, no retry
 *   - Network errors: exponential backoff with ±20% jitter
 *     Delays: 1s → 2s → 4s → 8s → 16s → 30s (max), up to 6 attempts
 *   - After 6 failed attempts → DEAD → remove from pool → close all sessions
 */

import { SocketClient } from '@cognigy/socket-client';
import { logger } from '../logger';
import type { ResolvedAgentConfig } from '../types/agent.types';

const log = logger.child({ component: 'SocketConnectionPool' });

// ─── Types ────────────────────────────────────────────────────────────────────

/** Connection states in the SocketConnectionPool state machine. */
export type ConnectionState = 'CONNECTING' | 'IDLE' | 'ACTIVE' | 'RECONNECTING' | 'DEAD';

/** Internal record stored per active connection. */
export interface PoolEntry {
  /** The SocketClient instance. */
  readonly client: SocketClient;
  /** Current state. */
  state: ConnectionState;
  /** agentId this connection belongs to. */
  readonly agentId: string;
  /** Number of currently open (active) sessions. */
  activeSessions: number;
  /** Last time any session activity occurred (ms since epoch). */
  lastActivityMs: number;
  /** Current reconnect attempt count (reset on successful connect). */
  reconnectAttempts: number;
  /** NodeJS timer handle for the idle-close timeout. */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Milliseconds of inactivity before an IDLE connection is auto-closed. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Base delay for first reconnect attempt in ms. */
const RECONNECT_BASE_MS = 1_000;

/** Maximum reconnect delay cap in ms. */
const RECONNECT_MAX_MS = 30_000;

/** ±20% jitter fraction applied to reconnect delay. */
const RECONNECT_JITTER = 0.2;

/** Maximum reconnect attempts before declaring a connection DEAD. */
const MAX_RECONNECT_ATTEMPTS = 6;

// ─── Pool ─────────────────────────────────────────────────────────────────────

/**
 * Singleton connection pool for SocketClient instances.
 *
 * Usage:
 *   const pool = SocketConnectionPool.getInstance();
 *   const entry = await pool.getOrCreate(agentConfig);
 *   // use entry.client.sendMessage(...)
 *   pool.markSessionStarted(agentId);
 *   pool.markSessionEnded(agentId);
 */
export class SocketConnectionPool {
  private static instance: SocketConnectionPool | null = null;

  /** Map from agentId → PoolEntry. */
  private readonly pool: Map<string, PoolEntry> = new Map();

  private constructor() {}

  /** Returns the singleton pool instance. */
  static getInstance(): SocketConnectionPool {
    if (!SocketConnectionPool.instance) {
      SocketConnectionPool.instance = new SocketConnectionPool();
    }
    return SocketConnectionPool.instance;
  }

  /** @internal — for testing only: resets the singleton. */
  static _resetInstance(): void {
    if (SocketConnectionPool.instance) {
      const entries = [...SocketConnectionPool.instance.pool.values()];
      for (const entry of entries) {
        SocketConnectionPool.instance.clearIdleTimer(entry);
        try { entry.client.disconnect(); } catch { /* ignore */ }
      }
      SocketConnectionPool.instance.pool.clear();
      SocketConnectionPool.instance = null;
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns the existing PoolEntry for an agent, or creates and connects a new one.
   *
   * @throws If the connection is DEAD or initial connect fails.
   */
  async getOrCreate(config: ResolvedAgentConfig): Promise<PoolEntry> {
    const existing = this.pool.get(config.id);

    if (existing) {
      if (existing.state === 'DEAD') {
        throw new Error(
          `SocketConnectionPool: connection for agent "${config.id}" is DEAD — cannot reuse.`,
        );
      }
      return existing;
    }

    return this.create(config);
  }

  /**
   * Returns the current state of a connection, or null if not in pool.
   */
  getState(agentId: string): ConnectionState | null {
    return this.pool.get(agentId)?.state ?? null;
  }

  /**
   * Marks a session as started for an agent connection.
   * Cancels idle timer and transitions to ACTIVE.
   */
  markSessionStarted(agentId: string): void {
    const entry = this.pool.get(agentId);
    if (!entry || entry.state === 'DEAD') return;

    entry.activeSessions++;
    entry.lastActivityMs = Date.now();
    this.clearIdleTimer(entry);

    if (entry.state === 'IDLE') {
      entry.state = 'ACTIVE';
      log.debug({ agentId, activeSessions: entry.activeSessions, event: 'connection.active' }, 'Connection became active');
    }
  }

  /**
   * Marks a session as ended for an agent connection.
   * When activeSessions reaches 0, transitions to IDLE and starts the idle timer.
   */
  markSessionEnded(agentId: string): void {
    const entry = this.pool.get(agentId);
    if (!entry || entry.state === 'DEAD') return;

    entry.activeSessions = Math.max(0, entry.activeSessions - 1);
    entry.lastActivityMs = Date.now();

    if (entry.activeSessions === 0 && entry.state === 'ACTIVE') {
      entry.state = 'IDLE';
      this.startIdleTimer(entry);
      log.debug({ agentId, event: 'connection.idle' }, 'Connection became idle — idle timer started');
    }
  }

  /**
   * Forcibly removes a connection from the pool and disconnects it.
   */
  remove(agentId: string): void {
    const entry = this.pool.get(agentId);
    if (!entry) return;

    this.clearIdleTimer(entry);
    this.pool.delete(agentId);

    try {
      entry.client.disconnect();
    } catch (err) {
      log.warn({ agentId, err, event: 'connection.disconnect.error' }, 'Error disconnecting client during remove');
    }

    log.info({ agentId, event: 'connection.removed' }, 'Connection removed from pool');
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private async create(config: ResolvedAgentConfig): Promise<PoolEntry> {
    const { id: agentId, endpointUrl, urlToken } = config;

    log.info({ agentId, event: 'connection.creating' }, 'Creating new SocketClient connection');

    const client = new SocketClient(endpointUrl, urlToken, {
      userId: `a2a-pool-${agentId}`,
      sessionId: `a2a-pool-session-${agentId}`,
      channel: 'socket-client',
      reconnection: false,
      reconnectionLimit: 0,
      interval: 0,
      expiresIn: 0,
      resetFlow: false,
      forceWebsockets: true,
      disableWebsockets: false,
      enableInnerSocketHandshake: false,
      testMode: false,
      emitWithAck: false,
    });

    const entry: PoolEntry = {
      client,
      state: 'CONNECTING',
      agentId,
      activeSessions: 0,
      lastActivityMs: Date.now(),
      reconnectAttempts: 0,
      idleTimer: null,
    };

    this.pool.set(agentId, entry);
    this.registerClientListeners(entry);

    try {
      await client.connect();
      entry.state = 'IDLE';
      entry.reconnectAttempts = 0;
      this.startIdleTimer(entry);

      log.info({ agentId, event: 'connection.created' }, 'SocketClient connected and idle');
    } catch (err) {
      log.error({ agentId, err, event: 'connection.connect.failed' }, 'Initial SocketClient connect failed');
      this.pool.delete(agentId);
      this.clearIdleTimer(entry);
      try { client.disconnect(); } catch { /* ignore */ }
      throw new Error(
        `SocketConnectionPool: initial connect failed for agent "${agentId}": ${String(err)}`,
      );
    }

    return entry;
  }

  private registerClientListeners(entry: PoolEntry): void {
    const { client, agentId } = entry;

    client.on('disconnect', (reason: string) => {
      log.warn({ agentId, reason, event: 'socket.disconnect' }, 'SocketClient disconnected');
      if (entry.state !== 'DEAD') {
        void this.handleDisconnect(entry, new Error(`Socket disconnected: ${reason}`));
      }
    });

    client.on('error', (err: unknown) => {
      log.error({ agentId, err, event: 'socket.error' }, 'SocketClient emitted error');
      if (entry.state !== 'DEAD') {
        void this.handleDisconnect(entry, err);
      }
    });
  }

  private async handleDisconnect(entry: PoolEntry, cause: unknown): Promise<void> {
    const { agentId } = entry;

    if (this.isAuthError(cause)) {
      log.error({ agentId, cause, event: 'connection.dead.auth' }, 'Auth error — connection marked DEAD immediately');
      this.markDead(entry);
      return;
    }

    if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.error({ agentId, attempts: entry.reconnectAttempts, event: 'connection.dead.maxRetries' }, 'Max reconnect attempts exceeded — connection marked DEAD');
      this.markDead(entry);
      return;
    }

    entry.state = 'RECONNECTING';
    entry.reconnectAttempts++;

    const baseDelay = Math.min(RECONNECT_BASE_MS * Math.pow(2, entry.reconnectAttempts - 1), RECONNECT_MAX_MS);
    const jitter = baseDelay * RECONNECT_JITTER * (Math.random() * 2 - 1);
    const delay = Math.round(baseDelay + jitter);

    log.info(
      { agentId, attempt: entry.reconnectAttempts, delayMs: delay, event: 'reconnect.attempt' },
      `Reconnect attempt ${entry.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
    );

    await this.sleep(delay);

    if (entry.state !== 'RECONNECTING') {
      return;
    }

    try {
      await entry.client.connect(true);
      entry.state = entry.activeSessions > 0 ? 'ACTIVE' : 'IDLE';
      entry.reconnectAttempts = 0;

      if (entry.activeSessions === 0) {
        this.startIdleTimer(entry);
      }

      log.info({ agentId, event: 'reconnect.success' }, 'Reconnect succeeded');
    } catch (reconnectErr) {
      log.warn({ agentId, attempt: entry.reconnectAttempts, reconnectErr, event: 'reconnect.failed' }, 'Reconnect attempt failed');
      await this.handleDisconnect(entry, reconnectErr);
    }
  }

  private markDead(entry: PoolEntry): void {
    const { agentId } = entry;
    entry.state = 'DEAD';
    this.clearIdleTimer(entry);
    entry.client.emit('poolDead', new Error(`Connection for agent "${agentId}" is permanently dead.`));
    this.pool.delete(agentId);
    log.error({ agentId, event: 'connection.dead' }, 'Connection permanently dead — removed from pool');
  }

  private startIdleTimer(entry: PoolEntry): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      log.info({ agentId: entry.agentId, event: 'connection.idle.close' }, 'Idle timeout — closing connection');
      this.remove(entry.agentId);
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private isAuthError(err: unknown): boolean {
    if (!err) return false;
    const msg = String(err instanceof Error ? err.message : err).toLowerCase();
    return msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
