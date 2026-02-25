/**
 * @fileoverview Tests for RestAdapter.
 *
 * Strategy: RestAdapter creates its own private axios instance internally.
 * We inject a controlled instance via the optional 4th constructor parameter
 * so MockAdapter intercepts requests on the exact same instance the adapter uses.
 */

import axios, { AxiosError, type AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { RestAdapter } from '../../src/adapters/RestAdapter';
import { AdapterError } from '../../src/adapters/IAdapter';
import type { CognigyBaseOutput } from '../../src/types/cognigy.types';

// ── Test helpers ──────────────────────────────────────────────────────────────

const ENDPOINT_URL = 'https://endpoint.cognigy.example';
const URL_TOKEN = 'abc123def456';
const AGENT_ID = 'test-agent';

/**
 * Create a fresh axios instance + MockAdapter pair.
 * The instance is injected into RestAdapter so MockAdapter intercepts
 * the exact same instance the adapter posts to.
 */
function makeInjectedAdapter(): { adapter: RestAdapter; mock: MockAdapter; instance: AxiosInstance } {
  const instance = axios.create();
  const mock = new MockAdapter(instance);
  const adapter = new RestAdapter(AGENT_ID, ENDPOINT_URL, URL_TOKEN, instance);
  return { adapter, mock, instance };
}

function makeOutput(text: string): CognigyBaseOutput {
  return { text, data: undefined } as unknown as CognigyBaseOutput;
}

/**
 * Cognigy internal entry: only _messageId (no _finishReason).
 * Seen mid-stack — causes a spurious "cognigy/data" DataPart if not filtered.
 */
const INTERNAL_MESSAGE_ID_ONLY: CognigyBaseOutput = {
  text: '',
  data: { _cognigy: { _messageId: 'd74b316c-7bf1-4ad4-96b6-ce2789010c71' } } as unknown as undefined,
} as unknown as CognigyBaseOutput;

/** Cognigy internal finish marker — data as object */
const FINISH_MARKER_OBJECT: CognigyBaseOutput = {
  text: '',
  data: { _cognigy: { _messageId: 'test-msg-id', _finishReason: 'stop' } } as unknown as undefined,
} as unknown as CognigyBaseOutput;

/** Cognigy internal finish marker — data as JSON string (some Cognigy versions) */
const FINISH_MARKER_STRING: CognigyBaseOutput = {
  text: '',
  data: '{"_cognigy":{"_messageId":"test-msg-id","_finishReason":"stop"}}' as unknown as undefined,
} as unknown as CognigyBaseOutput;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RestAdapter', () => {

  it('has type === "REST"', () => {
    expect(new RestAdapter(AGENT_ID, ENDPOINT_URL, URL_TOKEN).type).toBe('REST');
  });

  // ── URL construction ───────────────────────────────────────────────────────

  describe('constructor — URL construction', () => {

    it('posts to <endpointUrl>/<urlToken>', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      let capturedUrl: string | undefined;

      mock.onPost().reply((config) => {
        capturedUrl = config.baseURL ?? config.url;
        return [200, { outputStack: [] }];
      });

      await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' });

      expect(capturedUrl).toBeDefined();
    });

    it('strips trailing slash from endpointUrl before appending urlToken', async () => {
      const instance = axios.create();
      const mock = new MockAdapter(instance);
      // Adapter with trailing slash — should still resolve correctly
      const adapter = new RestAdapter(AGENT_ID, `${ENDPOINT_URL}/`, URL_TOKEN, instance);

      mock.onPost().reply(200, { outputStack: [] });

      await expect(adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' })).resolves.toEqual([]);
    });
  });

  // ── Cognigy internal entry filtering ──────────────────────────────────────

  describe('send() — Cognigy internal entry filtering', () => {

    it('filters entries where data contains only _cognigy._messageId (no _finishReason)', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      mock.onPost().reply(200, {
        outputStack: [makeOutput('Hello'), INTERNAL_MESSAGE_ID_ONLY, FINISH_MARKER_OBJECT],
      });

      const result = await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' });

      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe('Hello');
    });

    it('filters entries where data contains _cognigy._finishReason (finish marker, object data)', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      mock.onPost().reply(200, {
        outputStack: [makeOutput('Hello'), makeOutput('World'), FINISH_MARKER_OBJECT],
      });

      const result = await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' });

      expect(result).toHaveLength(2);
      expect(result[0]?.text).toBe('Hello');
      expect(result[1]?.text).toBe('World');
    });

    it('filters finish marker when data is a JSON string', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      mock.onPost().reply(200, {
        outputStack: [makeOutput('Hello'), FINISH_MARKER_STRING],
      });

      const result = await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' });

      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe('Hello');
    });

    it('returns empty array when outputStack contains only internal entries', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      mock.onPost().reply(200, {
        outputStack: [INTERNAL_MESSAGE_ID_ONLY, FINISH_MARKER_OBJECT],
      });

      const result = await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' });

      expect(result).toEqual([]);
    });

    it('does NOT filter empty-text entries that have non-_cognigy data (real bot output)', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      const realEmptyText = { text: '', data: { someKey: 'someValue' } } as unknown as CognigyBaseOutput;
      mock.onPost().reply(200, {
        outputStack: [realEmptyText, FINISH_MARKER_OBJECT],
      });

      const result = await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' });

      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe('');
    });

    it('does NOT filter entries that have real text even if _cognigy data is present', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      const realOutput = { text: 'Real message', data: { _cognigy: { _messageId: 'abc' } } } as unknown as CognigyBaseOutput;
      mock.onPost().reply(200, { outputStack: [realOutput] });

      const result = await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' });

      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe('Real message');
    });
  });

  // ── Response handling ──────────────────────────────────────────────────────

  describe('send() — response handling', () => {

    it('returns empty array when outputStack is missing', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      mock.onPost().reply(200, {});
      expect(await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' })).toEqual([]);
    });

    it('returns empty array when outputStack is null', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      mock.onPost().reply(200, { outputStack: null });
      expect(await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' })).toEqual([]);
    });

    it('forwards optional data field in request body', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      let capturedBody: unknown;
      mock.onPost().reply((config) => {
        capturedBody = JSON.parse(config.data as string);
        return [200, { outputStack: [] }];
      });

      await adapter.send({ text: 'Query', sessionId: 's1', userId: 'u1', data: { context: 'vip' } });

      expect(capturedBody).toMatchObject({ text: 'Query', sessionId: 's1', userId: 'u1', data: { context: 'vip' } });
    });

    it('omits data field when not provided', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      let capturedBody: Record<string, unknown>;
      mock.onPost().reply((config) => {
        capturedBody = JSON.parse(config.data as string) as Record<string, unknown>;
        return [200, { outputStack: [] }];
      });

      await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' });

      expect(capturedBody!).not.toHaveProperty('data');
    });

    it('throws AdapterError on HTTP 500', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      mock.onPost().reply(500);
      await expect(adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' })).rejects.toThrow(AdapterError);
    });

    it('throws AdapterError on HTTP 401', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      mock.onPost().reply(401);
      const err = await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' }).catch(e => e);
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).adapterType).toBe('REST');
    });

    it('throws AdapterError on network failure', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      mock.onPost().networkError();
      await expect(adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' })).rejects.toThrow(AdapterError);
    });

    it('throws AdapterError on timeout', async () => {
      // Inject a mock instance that rejects with the exact AxiosError axios produces on timeout.
      // axios-mock-adapter's .timeout() does not reliably set code:'ECONNABORTED'.
      const timeoutErr = new AxiosError('timeout of 8000ms exceeded', 'ECONNABORTED');
      const mockInstance = { post: jest.fn().mockRejectedValueOnce(timeoutErr) } as unknown as AxiosInstance;

      const err = await new RestAdapter(AGENT_ID, ENDPOINT_URL, URL_TOKEN, mockInstance)
        .send({ text: 'Hi', sessionId: 's', userId: 'u' }).catch(e => e);

      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).message).toContain('timed out');
    });

    it('preserves original error as cause on AdapterError', async () => {
      const { adapter, mock } = makeInjectedAdapter();
      mock.onPost().reply(503);
      const err = await adapter.send({ text: 'Hi', sessionId: 's', userId: 'u' }).catch(e => e);
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).cause).toBeDefined();
    });
  });
});
