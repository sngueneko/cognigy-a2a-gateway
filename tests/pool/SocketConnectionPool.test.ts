/**
 * @fileoverview Tests for SocketConnectionPool.
 *
 * Coverage targets:
 *   - getOrCreate(): creates new entry, returns existing, throws on DEAD
 *   - getState(): returns state or null
 *   - markSessionStarted(): transitions IDLE → ACTIVE, cancels idle timer
 *   - markSessionEnded(): transitions ACTIVE → IDLE, starts idle timer
 *   - remove(): disconnects and removes from pool
 *   - _resetInstance(): clears all connections
 *   - Idle timeout: auto-closes after IDLE_TIMEOUT_MS
 *   - Reconnect: exponential backoff on disconnect, max attempts → DEAD
 *   - Auth error: immediate DEAD, no retry
 *   - Initial connect failure: throws, not in pool
 */

import { SocketConnectionPool } from '../../src/pool/SocketConnectionPool';
import type { ResolvedAgentConfig } from '../../src/types/agent.types';
import { EventEmitter } from 'events';

// ─── Mock @cognigy/socket-client ─────────────────────────────────────────────

class MockSocketClient extends EventEmitter {
  public connectMock: jest.Mock;
  public disconnectMock: jest.Mock;
  public sendMessageMock: jest.Mock;

  constructor() {
    super();
    this.connectMock = jest.fn().mockResolvedValue(undefined);
    this.disconnectMock = jest.fn().mockReturnThis();
    this.sendMessageMock = jest.fn().mockReturnThis();
  }

  connect(_isReconnect?: boolean): Promise<void> { return this.connectMock(_isReconnect); }
  disconnect(): this { return this.disconnectMock(); }
  sendMessage(text: string, data?: unknown): this { return this.sendMessageMock(text, data); }
}

let mockClientInstances: MockSocketClient[] = [];

jest.mock('@cognigy/socket-client', () => ({
  SocketClient: jest.fn().mockImplementation(() => {
    const instance = new MockSocketClient();
    mockClientInstances.push(instance);
    return instance;
  }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(id = 'agent-1'): ResolvedAgentConfig {
  return {
    id,
    name: 'Test Agent',
    description: 'Test',
    version: '1.0.0',
    endpointType: 'SOCKET',
    endpointUrl: 'wss://test.cognigy.ai/socket',
    urlToken: 'test-token',
    skills: [],
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  mockClientInstances = [];
  SocketConnectionPool._resetInstance();
});

afterEach(() => {
  SocketConnectionPool._resetInstance();
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SocketConnectionPool', () => {

  describe('singleton', () => {
    it('returns the same instance on multiple calls', () => {
      const a = SocketConnectionPool.getInstance();
      const b = SocketConnectionPool.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('getOrCreate()', () => {
    it('creates a new IDLE entry when none exists', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());

      expect(entry.state).toBe('IDLE');
      expect(entry.agentId).toBe('agent-1');
      expect(entry.activeSessions).toBe(0);
      expect(entry.reconnectAttempts).toBe(0);
    });

    it('returns the existing entry on second call', async () => {
      const pool = SocketConnectionPool.getInstance();
      const first = await pool.getOrCreate(makeConfig());
      const second = await pool.getOrCreate(makeConfig());

      expect(first).toBe(second);
      expect(mockClientInstances).toHaveLength(1);
    });

    it('throws when connection is DEAD', async () => {
      const pool = SocketConnectionPool.getInstance();
      const config = makeConfig();

      // Make initial connect fail
      const connectError = new Error('401 Unauthorized');
      jest.mocked(mockClientInstances[0]?.connectMock ?? { mockRejectedValueOnce: () => {} });

      // We need to set up the mock before the call
      // Use jest module mock to make connect fail
      const { SocketClient } = require('@cognigy/socket-client') as { SocketClient: jest.Mock };
      SocketClient.mockImplementationOnce(() => {
        const client = new MockSocketClient();
        client.connectMock.mockRejectedValueOnce(connectError);
        mockClientInstances.push(client);
        return client;
      });

      await expect(pool.getOrCreate(config)).rejects.toThrow('initial connect failed');

      // After failed create, pool should have no entry
      expect(pool.getState('agent-1')).toBeNull();
    });

    it('throws when existing connection is DEAD', async () => {
      const pool = SocketConnectionPool.getInstance();
      const config = makeConfig();

      // Create a normal connection first
      const entry = await pool.getOrCreate(config);
      // Manually mark as DEAD
      entry.state = 'DEAD';

      await expect(pool.getOrCreate(config)).rejects.toThrow('DEAD');
    });
  });

  describe('getState()', () => {
    it('returns null for unknown agentId', () => {
      const pool = SocketConnectionPool.getInstance();
      expect(pool.getState('nonexistent')).toBeNull();
    });

    it('returns IDLE after successful connect', async () => {
      const pool = SocketConnectionPool.getInstance();
      await pool.getOrCreate(makeConfig());
      expect(pool.getState('agent-1')).toBe('IDLE');
    });
  });

  describe('markSessionStarted()', () => {
    it('transitions IDLE → ACTIVE and increments activeSessions', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());

      pool.markSessionStarted('agent-1');

      expect(entry.state).toBe('ACTIVE');
      expect(entry.activeSessions).toBe(1);
    });

    it('increments activeSessions on multiple starts', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());

      pool.markSessionStarted('agent-1');
      pool.markSessionStarted('agent-1');

      expect(entry.activeSessions).toBe(2);
      expect(entry.state).toBe('ACTIVE');
    });

    it('cancels idle timer on session start', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());

      // Idle timer should be set after connect
      expect(entry.idleTimer).not.toBeNull();

      pool.markSessionStarted('agent-1');
      expect(entry.idleTimer).toBeNull();
    });

    it('is a no-op for unknown agentId', () => {
      const pool = SocketConnectionPool.getInstance();
      expect(() => pool.markSessionStarted('nonexistent')).not.toThrow();
    });

    it('is a no-op for DEAD connection', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());
      entry.state = 'DEAD';

      pool.markSessionStarted('agent-1');
      expect(entry.activeSessions).toBe(0);
    });
  });

  describe('markSessionEnded()', () => {
    it('transitions ACTIVE → IDLE when last session ends', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());

      pool.markSessionStarted('agent-1');
      pool.markSessionEnded('agent-1');

      expect(entry.state).toBe('IDLE');
      expect(entry.activeSessions).toBe(0);
    });

    it('starts idle timer when transitioning to IDLE', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());

      // Clear timer from connect
      clearTimeout(entry.idleTimer!);
      entry.idleTimer = null;

      pool.markSessionStarted('agent-1');
      pool.markSessionEnded('agent-1');

      expect(entry.idleTimer).not.toBeNull();
    });

    it('stays ACTIVE when multiple sessions — only one ended', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());

      pool.markSessionStarted('agent-1');
      pool.markSessionStarted('agent-1');
      pool.markSessionEnded('agent-1');

      expect(entry.state).toBe('ACTIVE');
      expect(entry.activeSessions).toBe(1);
    });

    it('does not drop below 0 activeSessions', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());

      pool.markSessionEnded('agent-1');
      pool.markSessionEnded('agent-1');

      expect(entry.activeSessions).toBe(0);
    });
  });

  describe('remove()', () => {
    it('removes entry from pool and calls disconnect', async () => {
      const pool = SocketConnectionPool.getInstance();
      await pool.getOrCreate(makeConfig());

      pool.remove('agent-1');

      expect(pool.getState('agent-1')).toBeNull();
      expect(mockClientInstances[0]?.disconnectMock).toHaveBeenCalled();
    });

    it('is a no-op for unknown agentId', () => {
      const pool = SocketConnectionPool.getInstance();
      expect(() => pool.remove('nonexistent')).not.toThrow();
    });
  });

  describe('Idle timeout', () => {
    it('auto-removes IDLE connection after 5 minutes', async () => {
      const pool = SocketConnectionPool.getInstance();
      await pool.getOrCreate(makeConfig());

      expect(pool.getState('agent-1')).toBe('IDLE');

      // Advance past idle timeout (5 min)
      jest.advanceTimersByTime(5 * 60 * 1000 + 100);

      expect(pool.getState('agent-1')).toBeNull();
      expect(mockClientInstances[0]?.disconnectMock).toHaveBeenCalled();
    });

    it('does NOT auto-remove ACTIVE connection', async () => {
      const pool = SocketConnectionPool.getInstance();
      await pool.getOrCreate(makeConfig());

      pool.markSessionStarted('agent-1');

      jest.advanceTimersByTime(5 * 60 * 1000 + 100);

      expect(pool.getState('agent-1')).toBe('ACTIVE');
    });

    it('restarts idle timer after session ends', async () => {
      const pool = SocketConnectionPool.getInstance();
      await pool.getOrCreate(makeConfig());

      pool.markSessionStarted('agent-1');
      // Partial advance — not enough to trigger idle during ACTIVE
      jest.advanceTimersByTime(3 * 60 * 1000);
      expect(pool.getState('agent-1')).toBe('ACTIVE');

      // End session — idle timer restarts
      pool.markSessionEnded('agent-1');

      // Another 5 min to trigger idle close
      jest.advanceTimersByTime(5 * 60 * 1000 + 100);

      expect(pool.getState('agent-1')).toBeNull();
    });
  });

  describe('Reconnect logic', () => {
    it('enters RECONNECTING state on disconnect event', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());

      // Simulate reconnect succeeding immediately on next connect
      mockClientInstances[0]!.connectMock.mockResolvedValue(undefined);

      // Trigger disconnect event
      mockClientInstances[0]!.emit('disconnect', 'transport error');

      expect(entry.state).toBe('RECONNECTING');
    });

    it('marks DEAD immediately on auth error', async () => {
      const pool = SocketConnectionPool.getInstance();
      await pool.getOrCreate(makeConfig());

      // Trigger error with 401 message
      mockClientInstances[0]!.emit('error', new Error('401 Unauthorized'));

      expect(pool.getState('agent-1')).toBeNull(); // removed from pool
    });

    it('marks DEAD after max reconnect attempts', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());

      // Make reconnect always fail
      mockClientInstances[0]!.connectMock.mockRejectedValue(new Error('network error'));

      // Trigger initial disconnect
      mockClientInstances[0]!.emit('disconnect', 'transport error');

      // Run through all 6 reconnect delays
      for (let i = 0; i < 6; i++) {
        await jest.runAllTimersAsync();
      }

      expect(pool.getState('agent-1')).toBeNull();
      expect(entry.state).toBe('DEAD');
    });

    it('resets reconnect attempts after successful reconnect', async () => {
      const pool = SocketConnectionPool.getInstance();
      const entry = await pool.getOrCreate(makeConfig());

      // First disconnect — succeeds on reconnect
      mockClientInstances[0]!.connectMock.mockResolvedValue(undefined);
      mockClientInstances[0]!.emit('disconnect', 'transport error');

      await jest.runAllTimersAsync();

      expect(entry.reconnectAttempts).toBe(0);
      expect(entry.state).toBe('IDLE');
    });
  });

  describe('_resetInstance()', () => {
    it('disconnects all clients and nulls singleton', async () => {
      const pool = SocketConnectionPool.getInstance();
      await pool.getOrCreate(makeConfig('agent-a'));
      await pool.getOrCreate(makeConfig('agent-b'));

      SocketConnectionPool._resetInstance();

      expect(mockClientInstances[0]?.disconnectMock).toHaveBeenCalled();
      expect(mockClientInstances[1]?.disconnectMock).toHaveBeenCalled();

      // New instance should be fresh
      const newPool = SocketConnectionPool.getInstance();
      expect(newPool.getState('agent-a')).toBeNull();
      expect(newPool.getState('agent-b')).toBeNull();
    });
  });

});
