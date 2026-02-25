import { CognigyAgentExecutor } from '../../src/handlers/CognigyAgentExecutor';
import { taskSessionRegistry } from '../../src/task/TaskSessionRegistry';
import type { ResolvedAgentConfig } from '../../src/types/agent.types';
import type { ExecutionEventBus } from '@a2a-js/sdk/server';
import { RequestContext } from '@a2a-js/sdk/server';
import type { Message, Part, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '@a2a-js/sdk';
import type { AdapterSendParams } from '../../src/adapters/IAdapter';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// RestAdapter mock: ignores onOutput, returns two outputs at once
jest.mock('../../src/adapters/RestAdapter', () => ({
  RestAdapter: jest.fn().mockImplementation(() => ({
    type: 'REST',
    send: jest.fn().mockResolvedValue([
      { text: 'Hello from Cognigy', data: undefined },
      { text: 'Second output', data: undefined },
    ]),
  })),
}));

// SocketAdapter mock: calls onOutput for each output synchronously, then resolves
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
    it('publishes only a final Message — no status-update, no artifact-update', async () => {
      const executor = new CognigyAgentExecutor(restConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const events = eventBus.publish.mock.calls.map(c => c[0] as { kind: string });

      // Exactly one event: the final Message
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('message');
      expect(events.some(e => e.kind === 'status-update')).toBe(false);
      expect(events.some(e => e.kind === 'artifact-update')).toBe(false);

      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });

    it('final Message contains all normalised parts from all outputs', async () => {
      const executor = new CognigyAgentExecutor(restConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const msg = eventBus.publish.mock.calls[0]?.[0] as Message;
      expect(msg.kind).toBe('message');
      expect(msg.parts.length).toBeGreaterThanOrEqual(2); // one per output
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
    });
  });

  // ── SOCKET adapter ────────────────────────────────────────────────────────

  describe('SOCKET adapter — Task lifecycle with streaming', () => {
    it('event sequence: working → artifact(s) → completed', async () => {
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const events = eventBus.publish.mock.calls.map(c => c[0] as { kind: string });

      // First: working status
      expect(events[0]?.kind).toBe('status-update');
      expect((events[0] as TaskStatusUpdateEvent).status.state).toBe('working');
      expect((events[0] as TaskStatusUpdateEvent).final).toBe(false);

      // Middle: artifact-updates
      const artifacts = events.filter(e => e.kind === 'artifact-update');
      expect(artifacts.length).toBeGreaterThan(0);

      // Last: completed status
      const last = events[events.length - 1] as TaskStatusUpdateEvent;
      expect(last.kind).toBe('status-update');
      expect(last.status.state).toBe('completed');
      expect(last.final).toBe(true);

      // No Message published
      expect(events.some(e => e.kind === 'message')).toBe(false);

      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });

    it('publishes one artifact-update per Cognigy output (3 outputs → 3 artifacts)', async () => {
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const artifacts = eventBus.publish.mock.calls
        .map(c => c[0] as TaskArtifactUpdateEvent)
        .filter(e => e.kind === 'artifact-update');

      expect(artifacts).toHaveLength(3);
    });

    it('all artifacts have lastChunk:false (stream end signalled by completed status)', async () => {
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const artifacts = eventBus.publish.mock.calls
        .map(c => c[0] as TaskArtifactUpdateEvent)
        .filter(e => e.kind === 'artifact-update');

      artifacts.forEach(a => expect(a.lastChunk).toBe(false));
    });

    it('each artifact has a unique artifactId', async () => {
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const artifacts = eventBus.publish.mock.calls
        .map(c => c[0] as TaskArtifactUpdateEvent)
        .filter(e => e.kind === 'artifact-update');

      const ids = artifacts.map(a => a.artifact.artifactId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('publishes failed status on adapter error — no Message', async () => {
      const { SocketAdapter } = jest.requireMock('../../src/adapters/SocketAdapter') as { SocketAdapter: jest.Mock };
      SocketAdapter.mockImplementationOnce(() => ({
        type: 'SOCKET',
        send: jest.fn().mockRejectedValue(new Error('Socket timeout')),
      }));
      const executor = new CognigyAgentExecutor(socketConfig);
      const eventBus = makeEventBus();
      await executor.execute(makeRequestContext(), eventBus);

      const events = eventBus.publish.mock.calls.map(c => c[0] as { kind: string });

      // working → failed (no Message)
      expect(events[0]?.kind).toBe('status-update');
      expect((events[0] as TaskStatusUpdateEvent).status.state).toBe('working');

      const last = events[events.length - 1] as TaskStatusUpdateEvent;
      expect(last.kind).toBe('status-update');
      expect(last.status.state).toBe('failed');
      expect(last.final).toBe(true);

      expect(events.some(e => e.kind === 'message')).toBe(false);
      expect(eventBus.finished).toHaveBeenCalledTimes(1);
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
    it('publishWorking emits non-final working status', () => {
      const eventBus = makeEventBus();
      new CognigyAgentExecutor(restConfig).publishWorking(eventBus, 't1', 'c1');
      const ev = eventBus.publish.mock.calls[0]?.[0] as TaskStatusUpdateEvent;
      expect(ev.status.state).toBe('working');
      expect(ev.final).toBe(false);
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
