/**
 * @fileoverview Tests for SocketAdapter.
 *
 * Coverage targets:
 *   - send(): happy path — text output → CognigyBaseOutput[]
 *   - send(): finalPing triggers resolution with collected outputs
 *   - send(): structured data outputs (_quickReplies, _gallery, _buttons, _list, _adaptiveCard)
 *   - send(): custom data output (no _cognigy key)
 *   - send(): empty outputs (finalPing with no prior messages)
 *   - send(): timeout → AdapterError
 *   - send(): disconnect before finalPing → AdapterError
 *   - send(): connect failure → AdapterError
 *   - send(): socket error → AdapterError
 *   - type: 'SOCKET' constant
 */

import { SocketAdapter } from '../../src/adapters/SocketAdapter';
import { AdapterError } from '../../src/adapters/IAdapter';
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

  connect(): Promise<void> { return this.connectMock(); }
  disconnect(): this { return this.disconnectMock(); }
  sendMessage(text: string, data?: unknown): this { return this.sendMessageMock(text, data); }
}

let currentMockClient: MockSocketClient;

jest.mock('@cognigy/socket-client', () => ({
  SocketClient: jest.fn().mockImplementation(() => {
    currentMockClient = new MockSocketClient();
    return currentMockClient;
  }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAdapter(): SocketAdapter {
  return new SocketAdapter('test-agent', 'wss://test.cognigy.ai/socket', 'test-token');
}

function makeParams(overrides?: object) {
  return {
    text: 'Hello',
    sessionId: 'session-1',
    userId: 'user-1',
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SocketAdapter', () => {

  it('has type === "SOCKET"', () => {
    expect(makeAdapter().type).toBe('SOCKET');
  });

  describe('send() — happy path', () => {
    it('resolves with text output after finalPing', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve(); // let connect() resolve
      await Promise.resolve();

      currentMockClient.emit('output', { text: 'Hello from Cognigy', data: {} });
      currentMockClient.emit('finalPing', {});

      const result = await sendPromise;

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ text: 'Hello from Cognigy' });
    });

    it('resolves with empty array when finalPing arrives with no outputs', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve();
      await Promise.resolve();

      currentMockClient.emit('finalPing', {});

      const result = await sendPromise;
      expect(result).toHaveLength(0);
    });

    it('collects multiple outputs before finalPing', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve();
      await Promise.resolve();

      currentMockClient.emit('output', { text: 'First' });
      currentMockClient.emit('output', { text: 'Second' });
      currentMockClient.emit('finalPing', {});

      const result = await sendPromise;
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ text: 'First' });
      expect(result[1]).toMatchObject({ text: 'Second' });
    });

    it('sends the user message via sendMessage after connect', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams({ text: 'Test message' }));

      await Promise.resolve();
      await Promise.resolve();

      expect(currentMockClient.sendMessageMock).toHaveBeenCalledWith('Test message', undefined);

      currentMockClient.emit('finalPing', {});
      await sendPromise;
    });

    it('disconnects the client after finalPing', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve();
      await Promise.resolve();

      currentMockClient.emit('finalPing', {});
      await sendPromise;

      expect(currentMockClient.disconnectMock).toHaveBeenCalled();
    });
  });

  describe('send() — structured data outputs', () => {
    it('extracts _quickReplies from output', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve();
      await Promise.resolve();

      const quickReplies = {
        type: 'quick_replies' as const,
        text: 'Choose one:',
        quickReplies: [{ id: 1, title: 'Yes', payload: 'yes', contentType: 'postback', imageAltText: undefined, imageUrl: undefined }],
      };
      currentMockClient.emit('output', {
        text: null,
        data: { _cognigy: { _default: { _quickReplies: quickReplies } } },
      });
      currentMockClient.emit('finalPing', {});

      const result = await sendPromise;
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toBeNull();
      expect((result[0]!.data as any)?._cognigy?._default?._quickReplies).toEqual(quickReplies);
    });

    it('extracts _gallery from output', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve();
      await Promise.resolve();

      const gallery = { type: 'carousel' as const, items: [{ id: 1, title: 'Item', subtitle: 'Sub', imageUrl: 'http://img.png', buttons: null, imageAltText: undefined }] };
      currentMockClient.emit('output', {
        text: null,
        data: { _cognigy: { _default: { _gallery: gallery } } },
      });
      currentMockClient.emit('finalPing', {});

      const result = await sendPromise;
      expect(result).toHaveLength(1);
      expect((result[0]!.data as any)?._cognigy?._default?._gallery).toEqual(gallery);
    });

    it('extracts custom data (no _cognigy key)', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve();
      await Promise.resolve();

      currentMockClient.emit('output', {
        text: null,
        data: { customKey: 'customValue' },
      });
      currentMockClient.emit('finalPing', {});

      const result = await sendPromise;
      expect(result).toHaveLength(1);
      expect((result[0]!.data as any)?.customKey).toBe('customValue');
    });
  });

  describe('send() — errors', () => {
    it('rejects with AdapterError on timeout', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve();
      await Promise.resolve();

      // Advance past session timeout (60s)
      jest.advanceTimersByTime(60_001);

      await expect(sendPromise).rejects.toThrow(AdapterError);
      await expect(sendPromise).rejects.toMatchObject({ adapterType: 'SOCKET' });
    });

    it('rejects with AdapterError on disconnect before finalPing', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve();
      await Promise.resolve();

      currentMockClient.emit('disconnect', 'transport close');

      await expect(sendPromise).rejects.toThrow(AdapterError);
    });

    it('rejects with AdapterError on socket error', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve();
      await Promise.resolve();

      currentMockClient.emit('error', new Error('socket error'));

      await expect(sendPromise).rejects.toThrow(AdapterError);
    });

    it('rejects with AdapterError when connect() fails', async () => {
      const { SocketClient } = require('@cognigy/socket-client') as { SocketClient: jest.Mock };
      SocketClient.mockImplementationOnce(() => {
        const client = new MockSocketClient();
        client.connectMock.mockRejectedValueOnce(new Error('Connection refused'));
        currentMockClient = client;
        return client;
      });

      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      await expect(sendPromise).rejects.toThrow(AdapterError);
      await expect(sendPromise).rejects.toMatchObject({ adapterType: 'SOCKET' });
    });

    it('does not reject twice on second event after finalPing', async () => {
      const adapter = makeAdapter();
      const sendPromise = adapter.send(makeParams());

      await Promise.resolve();
      await Promise.resolve();

      currentMockClient.emit('finalPing', {});
      currentMockClient.emit('disconnect', 'transport close'); // should be ignored

      const result = await sendPromise;
      expect(result).toHaveLength(0); // finalPing resolved first
    });
  });
});
