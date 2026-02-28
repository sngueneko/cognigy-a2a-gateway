/**
 * @fileoverview Tests for CognigyAgentExecutor.
 *
 * Event routing rules under test:
 *
 * SOCKET adapter:
 *   - text/UI outputs → TaskStatusUpdateEvent { state:'working', message: { parts } }
 *   - media outputs   → TaskArtifactUpdateEvent { FilePart }
 *   - lifecycle:      working (open) → [working+message / artifact]... → completed (close)
 *   - on error:       working (open) → failed (close)
 *
 * REST adapter:
 *   - all outputs → single Message { parts: [...all flattened...] }
 *   - no task lifecycle events (no status-update)
 *   - on error: single error Message
 */

import { CognigyAgentExecutor } from '../../src/handlers/CognigyAgentExecutor';
import { taskSessionRegistry } from '../../src/task/TaskSessionRegistry';
import type { ResolvedAgentConfig } from '../../src/types/agent.types';
import type { ExecutionEventBus } from '@a2a-js/sdk/server';
import { RequestContext } from '@a2a-js/sdk/server';
import type { Message, Part, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '@a2a-js/sdk';
import type { AdapterSendParams } from '../../src/adapters/IAdapter';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// RestAdapter: returns two plain text outputs
jest.mock('../../src/adapters/RestAdapter', () => ({
  RestAdapter: jest.fn().mockImplementation(() => ({
    type: 'REST',
    send: jest.fn().mockResolvedValue([
      { text: 'Hello from Cognigy', data: undefined },
      { text: 'Second output', data: undefined },
    ]),
  })),
}));

// SocketAdapter: streams three plain text outputs then resolves
jest.mock('../../src/adapters/SocketAdapter', () => ({
  SocketAdapter: jest.fn().mockImplementation(() => ({
    type: 'SOCKET',
    send: jest.fn().mockImplementation(async (params: AdapterSendParams) => {
      const outputs = [
        { text: 'Streaming part 1', data: undefined },
        { text: 'Streaming part 2', data: undefined },
        { text: 'Streaming part 3', data: undefined },
      ];
      if (params.onOutput) {
        outputs.forEach((o, i) => params.onOutput!(o, i));
      }
      return outputs;
    }),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const restConfig: ResolvedAgentConfig = {
  id: 'test-agent',
  name: 'Test Agent',
  description: 'Test',
  version: '1.0.0',
  endpointType: 'REST',
  endpointUrl: 'https://endpoint.cognigy.ai',
  urlToken: 'abc123',
  skills: [{ id: 'skill-1', name: 'Skill', description: 'Test skill', tags: ['test'] }],
};

const socketConfig: ResolvedAgentConfig = { ...restConfig, endpointType: 'SOCKET' };

function makeRequestContext(overrides: {
  taskId?: string;
  contextId?: string;
  text?: string;
  task?: object;
} = {}): RequestContext {
  const taskId = overrides.taskId ?? 'task-001';
  const contextId = overrides.contextId ?? 'ctx-001';
  const text = overrides.text ?? 'Hello';

  const userMessage: Message = {
    kind: 'message',
    messageId: 'msg-1',
    role: 'user',
    parts: [{ kind: 'text', text } as Part],
    contextId,
    taskId,
  };

  return new RequestContext(
    userMessage,
    taskId,
    contextId,
    overrides.task as never,
    undefined,
  );
}

function makeEventBus(): jest.Mocked<ExecutionEventBus> {
  return {
    publish: jest.fn(),
    finished: jest.fn(),
  } as unknown as jest.Mocked<ExecutionEventBus>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CognigyAgentExecutor', () => {
  afterEach(() => { jest.clearAllMocks(); });

  // ── REST adapter ──────────────────────────────────────────────────────────

  describe('REST adapter — Message only (no task lifecycle)', () => {
    it('publishes exactly one event: the final Message', async () => {
      const executor = new CognigyAgentExecutor(restConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const events = eventBus.publish.mock.calls.map(c => c[0] as { kind: string });

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('message');
      expect(events.some(e => e.kind === 'status-update')).toBe(false);
      expect(events.some(e => e.kind === 'artifact-update')).toBe(false);
      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });

    it('Message contains all normalised parts from all outputs (one TextPart per output)', async () => {
      const executor = new CognigyAgentExecutor(restConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const msg = eventBus.publish.mock.calls[0]?.[0] as Message;
      expect(msg.kind).toBe('message');
      // Two outputs → two TextParts
      expect(msg.parts).toHaveLength(2);
      expect((msg.parts[0] as { kind: string; text: string }).text).toBe('Hello from Cognigy');
      expect((msg.parts[1] as { kind: string; text: string }).text).toBe('Second output');
    });

    it('publishes error Message on adapter failure — no task events', async () => {
      const { RestAdapter } = jest.requireMock('../../src/adapters/RestAdapter') as { RestAdapter: jest.Mock };
      RestAdapter.mockImplementationOnce(() => ({
        type: 'REST',
        send: jest.fn().mockRejectedValue(new Error('Connection refused')),
      }));
      const executor = new CognigyAgentExecutor(restConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const events = eventBus.publish.mock.calls.map(c => c[0] as { kind: string });
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('message');
      const part = (events[0] as Message).parts[0] as { kind: string; text: string };
      expect(part.text).toContain('error');
      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });
  });

  // ── SOCKET adapter — text/UI outputs ─────────────────────────────────────

  describe('SOCKET adapter — text outputs → TaskStatusUpdateEvent with message', () => {
    it('event sequence: working (open) → working+message × N → completed (close)', async () => {
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const events = eventBus.publish.mock.calls.map(c => c[0] as { kind: string });

      // First event: working open (no message)
      expect(events[0]?.kind).toBe('status-update');
      const openEvent = events[0] as TaskStatusUpdateEvent;
      expect(openEvent.status.state).toBe('working');
      expect(openEvent.final).toBe(false);
      expect(openEvent.status.message).toBeUndefined();

      // Middle events: working with message (one per text output)
      const workingWithMessage = events.filter(e => {
        if (e.kind !== 'status-update') return false;
        const ev = e as TaskStatusUpdateEvent;
        return ev.status.state === 'working' && ev.status.message !== undefined;
      });
      expect(workingWithMessage.length).toBe(3); // 3 text outputs

      // Last event: completed (final)
      const last = events[events.length - 1] as TaskStatusUpdateEvent;
      expect(last.kind).toBe('status-update');
      expect(last.status.state).toBe('completed');
      expect(last.final).toBe(true);

      // No Message, no artifact-update
      expect(events.some(e => e.kind === 'message')).toBe(false);
      expect(events.some(e => e.kind === 'artifact-update')).toBe(false);

      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });

    it('each working+message event has correct TextPart content', async () => {
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const messageEvents = eventBus.publish.mock.calls
        .map(c => c[0] as TaskStatusUpdateEvent)
        .filter(e => e.kind === 'status-update' && e.status.message !== undefined);

      expect(messageEvents).toHaveLength(3);
      const texts = messageEvents.map(e => (e.status.message?.parts[0] as { text: string }).text);
      expect(texts).toEqual(['Streaming part 1', 'Streaming part 2', 'Streaming part 3']);
    });

    it('each working+message has role:agent and valid messageId', async () => {
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const messageEvents = eventBus.publish.mock.calls
        .map(c => c[0] as TaskStatusUpdateEvent)
        .filter(e => e.kind === 'status-update' && e.status.message !== undefined);

      for (const ev of messageEvents) {
        expect(ev.status.message?.role).toBe('agent');
        expect(ev.status.message?.messageId).toBeTruthy();
        expect(ev.status.message?.kind).toBe('message');
      }
    });

    it('publishes failed status on adapter error — no artifact-update, no Message', async () => {
      const { SocketAdapter } = jest.requireMock('../../src/adapters/SocketAdapter') as { SocketAdapter: jest.Mock };
      SocketAdapter.mockImplementationOnce(() => ({
        type: 'SOCKET',
        send: jest.fn().mockRejectedValue(new Error('Socket timeout')),
      }));
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const events = eventBus.publish.mock.calls.map(c => c[0] as { kind: string });

      expect(events[0]?.kind).toBe('status-update');
      expect((events[0] as TaskStatusUpdateEvent).status.state).toBe('working');

      const last = events[events.length - 1] as TaskStatusUpdateEvent;
      expect(last.kind).toBe('status-update');
      expect(last.status.state).toBe('failed');
      expect(last.final).toBe(true);

      expect(events.some(e => e.kind === 'message')).toBe(false);
      expect(events.some(e => e.kind === 'artifact-update')).toBe(false);
      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });
  });

  // ── SOCKET adapter — media outputs ────────────────────────────────────────

  describe('SOCKET adapter — media outputs → TaskArtifactUpdateEvent', () => {
    function makeSocketWithMedia() {
      const { SocketAdapter } = jest.requireMock('../../src/adapters/SocketAdapter') as { SocketAdapter: jest.Mock };
      SocketAdapter.mockImplementationOnce(() => ({
        type: 'SOCKET',
        send: jest.fn().mockImplementation(async (params: AdapterSendParams) => {
          const outputs = [
            { text: 'Here is an image', data: undefined },
            { text: null, data: { _image: { type: 'image', imageUrl: 'https://cdn.example.com/photo.png' } } },
            { text: null, data: { _audio: { type: 'audio', audioUrl: 'https://cdn.example.com/song.mp3' } } },
            { text: null, data: { _video: { type: 'video', videoUrl: 'https://cdn.example.com/clip.mp4' } } },
          ];
          if (params.onOutput) {
            outputs.forEach((o, i) => params.onOutput!(o, i));
          }
          return outputs;
        }),
      }));
    }

    it('image output → TaskArtifactUpdateEvent with FilePart', async () => {
      makeSocketWithMedia();
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const artifacts = eventBus.publish.mock.calls
        .map(c => c[0] as TaskArtifactUpdateEvent)
        .filter(e => e.kind === 'artifact-update');

      expect(artifacts.length).toBeGreaterThanOrEqual(1);

      const imgArtifact = artifacts.find(a =>
        a.artifact.parts.some(p => p.kind === 'file' && (p as { kind: string; file: { mimeType: string } }).file.mimeType.startsWith('image/')),
      );
      expect(imgArtifact).toBeDefined();
      const filePart = imgArtifact?.artifact.parts.find(p => p.kind === 'file') as { kind: string; file: { uri: string; mimeType: string; name: string } };
      expect(filePart?.file.uri).toBe('https://cdn.example.com/photo.png');
      expect(filePart?.file.mimeType).toBe('image/png');
      expect(filePart?.file.name).toBe('photo.png');
    });

    it('audio output → TaskArtifactUpdateEvent with audio/mpeg FilePart', async () => {
      makeSocketWithMedia();
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const artifacts = eventBus.publish.mock.calls
        .map(c => c[0] as TaskArtifactUpdateEvent)
        .filter(e => e.kind === 'artifact-update');

      const audioArtifact = artifacts.find(a =>
        a.artifact.parts.some(p => p.kind === 'file' && (p as { kind: string; file: { mimeType: string } }).file.mimeType.startsWith('audio/')),
      );
      expect(audioArtifact).toBeDefined();
    });

    it('video output → TaskArtifactUpdateEvent with video/mp4 FilePart', async () => {
      makeSocketWithMedia();
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const artifacts = eventBus.publish.mock.calls
        .map(c => c[0] as TaskArtifactUpdateEvent)
        .filter(e => e.kind === 'artifact-update');

      const videoArtifact = artifacts.find(a =>
        a.artifact.parts.some(p => p.kind === 'file' && (p as { kind: string; file: { mimeType: string } }).file.mimeType.startsWith('video/')),
      );
      expect(videoArtifact).toBeDefined();
    });

    it('each artifact has lastChunk:true and unique artifactId', async () => {
      makeSocketWithMedia();
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const artifacts = eventBus.publish.mock.calls
        .map(c => c[0] as TaskArtifactUpdateEvent)
        .filter(e => e.kind === 'artifact-update');

      expect(artifacts.length).toBe(3); // image + audio + video
      artifacts.forEach(a => expect(a.lastChunk).toBe(true));
      const ids = artifacts.map(a => a.artifact.artifactId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('text output and media in same turn: status-update + artifact-update both emitted', async () => {
      makeSocketWithMedia();
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const events = eventBus.publish.mock.calls.map(c => c[0] as { kind: string });

      const statusMessages = events.filter(e => {
        if (e.kind !== 'status-update') return false;
        return (e as TaskStatusUpdateEvent).status.message !== undefined;
      });
      const artifactUpdates = events.filter(e => e.kind === 'artifact-update');

      expect(statusMessages.length).toBe(1);    // "Here is an image"
      expect(artifactUpdates.length).toBe(3);   // image + audio + video
    });
  });

  // ── SOCKET — structured outputs (quick replies) ───────────────────────────

  describe('SOCKET adapter — structured outputs → status-update with TextPart + DataPart', () => {
    it('quick replies output → status-update with message containing TextPart and DataPart', async () => {
      const { SocketAdapter } = jest.requireMock('../../src/adapters/SocketAdapter') as { SocketAdapter: jest.Mock };
      SocketAdapter.mockImplementationOnce(() => ({
        type: 'SOCKET',
        send: jest.fn().mockImplementation(async (params: AdapterSendParams) => {
          const outputs = [{
            text: null,
            data: {
              _quickReplies: {
                type: 'quick_replies',
                text: 'Choose an option',
                quickReplies: [{ title: 'Option A' }, { title: 'Option B' }],
              },
            },
          }];
          if (params.onOutput) outputs.forEach((o, i) => params.onOutput!(o, i));
          return outputs;
        }),
      }));

      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const statusMsg = eventBus.publish.mock.calls
        .map(c => c[0] as TaskStatusUpdateEvent)
        .find(e => e.kind === 'status-update' && e.status.message !== undefined);

      expect(statusMsg).toBeDefined();
      const parts = statusMsg?.status.message?.parts ?? [];
      expect(parts.length).toBe(2);

      const tp = parts[0] as { kind: string; text: string };
      expect(tp.kind).toBe('text');
      expect(tp.text).toContain('Choose an option');
      expect(tp.text).toContain('- Option A');
      expect(tp.text).toContain('- Option B');

      const dp = parts[1] as { kind: string; data: { type: string } };
      expect(dp.kind).toBe('data');
      expect(dp.data.type).toBe('quick_replies');

      // Must not produce artifact-update
      const artifacts = eventBus.publish.mock.calls.filter(c => (c[0] as { kind: string }).kind === 'artifact-update');
      expect(artifacts).toHaveLength(0);
    });
  });

  // ── Task lifecycle ────────────────────────────────────────────────────────

  describe('task lifecycle', () => {
    it('deregisters task from registry after completion (REST)', async () => {
      const executor = new CognigyAgentExecutor(restConfig);
      await executor.execute(makeRequestContext({ taskId: 'task-cleanup-rest' }), makeEventBus());
      expect(taskSessionRegistry.cancel('task-cleanup-rest')).toBe(false);
    });

    it('deregisters task from registry after completion (SOCKET)', async () => {
      const executor = new CognigyAgentExecutor(socketConfig);
      await executor.execute(makeRequestContext({ taskId: 'task-cleanup-socket' }), makeEventBus());
      expect(taskSessionRegistry.cancel('task-cleanup-socket')).toBe(false);
    });

    it('deregisters task even on adapter error', async () => {
      const { RestAdapter } = jest.requireMock('../../src/adapters/RestAdapter') as { RestAdapter: jest.Mock };
      RestAdapter.mockImplementationOnce(() => ({
        type: 'REST',
        send: jest.fn().mockRejectedValue(new Error('Network failure')),
      }));
      const executor = new CognigyAgentExecutor(restConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext({ taskId: 'task-error' }), eventBus);
      expect(eventBus.finished).toHaveBeenCalledTimes(1);
      expect(taskSessionRegistry.cancel('task-error')).toBe(false);
    });
  });

  // ── cancelTask ────────────────────────────────────────────────────────────

  describe('cancelTask', () => {
    it('signals abort when task is in-flight', async () => {
      let resolveAdapter!: () => void;
      const { RestAdapter } = jest.requireMock('../../src/adapters/RestAdapter') as { RestAdapter: jest.Mock };
      RestAdapter.mockImplementationOnce(() => ({
        type: 'REST',
        send: jest.fn().mockReturnValue(new Promise<never>(r => { resolveAdapter = () => r([] as never); })),
      }));
      const executor = new CognigyAgentExecutor(restConfig);
      const eventBus = makeEventBus();
      const execPromise = executor.execute(makeRequestContext({ taskId: 'task-cancel' }), eventBus);
      await new Promise(r => setTimeout(r, 10));
      expect(taskSessionRegistry.cancel('task-cancel')).toBe(true);
      resolveAdapter();
      await execPromise;
    });

    it('publishes canceled status when task not in-flight', async () => {
      const executor = new CognigyAgentExecutor(restConfig);
      const eventBus = makeEventBus();
      await executor.cancelTask('task-not-in-flight', eventBus);
      const ev = eventBus.publish.mock.calls[0]?.[0] as TaskStatusUpdateEvent;
      expect(ev.kind).toBe('status-update');
      expect(ev.status.state).toBe('canceled');
      expect(ev.final).toBe(true);
      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });
  });

  // ── Helper methods ────────────────────────────────────────────────────────

  describe('extractCognigyData', () => {
    it('returns undefined with no task', () => {
      expect(new CognigyAgentExecutor(restConfig).extractCognigyData(makeRequestContext())).toBeUndefined();
    });

    it('returns cognigyData from task metadata', () => {
      const ctx = makeRequestContext({
        task: {
          id: 't1', contextId: 'c1', kind: 'task',
          status: { state: 'working', timestamp: new Date().toISOString() },
          metadata: { cognigyData: { lang: 'en' } },
        },
      });
      expect(new CognigyAgentExecutor(restConfig).extractCognigyData(ctx)).toEqual({ lang: 'en' });
    });

    it('returns undefined when cognigyData is not an object', () => {
      const ctx = makeRequestContext({
        task: {
          id: 't1', contextId: 'c1', kind: 'task',
          status: { state: 'working', timestamp: new Date().toISOString() },
          metadata: { cognigyData: 'string-value' },
        },
      });
      expect(new CognigyAgentExecutor(restConfig).extractCognigyData(ctx)).toBeUndefined();
    });
  });

  describe('status helpers', () => {
    it('publishWorking emits non-final working status without message', () => {
      const eventBus = makeEventBus();
      new CognigyAgentExecutor(restConfig).publishWorking(eventBus, 't1', 'c1');
      const ev = eventBus.publish.mock.calls[0]?.[0] as TaskStatusUpdateEvent;
      expect(ev.status.state).toBe('working');
      expect(ev.final).toBe(false);
      expect(ev.status.message).toBeUndefined();
    });

    it('publishCompleted emits final completed status', () => {
      const eventBus = makeEventBus();
      new CognigyAgentExecutor(restConfig).publishCompleted(eventBus, 't1', 'c1');
      const ev = eventBus.publish.mock.calls[0]?.[0] as TaskStatusUpdateEvent;
      expect(ev.status.state).toBe('completed');
      expect(ev.final).toBe(true);
    });

    it('publishCanceled emits final canceled status', () => {
      const eventBus = makeEventBus();
      new CognigyAgentExecutor(restConfig).publishCanceled(eventBus, 't1', 'c1');
      const ev = eventBus.publish.mock.calls[0]?.[0] as TaskStatusUpdateEvent;
      expect(ev.status.state).toBe('canceled');
      expect(ev.final).toBe(true);
    });

    it('publishFailed emits final failed status', () => {
      const eventBus = makeEventBus();
      new CognigyAgentExecutor(restConfig).publishFailed(eventBus, 't1', 'c1');
      const ev = eventBus.publish.mock.calls[0]?.[0] as TaskStatusUpdateEvent;
      expect(ev.status.state).toBe('failed');
      expect(ev.final).toBe(true);
    });
  });
});
