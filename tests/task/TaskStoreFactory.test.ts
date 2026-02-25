import { TaskStoreFactory } from '../../src/task/TaskStoreFactory';
import { InMemoryTaskStore } from '@a2a-js/sdk/server';

describe('TaskStoreFactory', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('createFromEnv', () => {
    it('returns InMemoryTaskStore when TASK_STORE_TYPE is unset', () => {
      delete process.env['TASK_STORE_TYPE'];
      const store = TaskStoreFactory.createFromEnv();
      expect(store).toBeInstanceOf(InMemoryTaskStore);
    });

    it('returns InMemoryTaskStore when TASK_STORE_TYPE=memory', () => {
      process.env['TASK_STORE_TYPE'] = 'memory';
      const store = TaskStoreFactory.createFromEnv();
      expect(store).toBeInstanceOf(InMemoryTaskStore);
    });

    it('returns InMemoryTaskStore when TASK_STORE_TYPE=MEMORY (case-insensitive)', () => {
      process.env['TASK_STORE_TYPE'] = 'MEMORY';
      const store = TaskStoreFactory.createFromEnv();
      expect(store).toBeInstanceOf(InMemoryTaskStore);
    });

    it('falls back to InMemoryTaskStore for unknown TASK_STORE_TYPE', () => {
      process.env['TASK_STORE_TYPE'] = 'unknown_store';
      const store = TaskStoreFactory.createFromEnv();
      expect(store).toBeInstanceOf(InMemoryTaskStore);
    });

    it('InMemoryTaskStore can save and load tasks', async () => {
      delete process.env['TASK_STORE_TYPE'];
      const store = TaskStoreFactory.createFromEnv();

      const task = {
        id: 'task-abc',
        contextId: 'ctx-1',
        kind: 'task' as const,
        status: { state: 'working' as const, timestamp: new Date().toISOString() },
      };

      await store.save(task);
      const loaded = await store.load('task-abc');
      expect(loaded).toMatchObject({ id: 'task-abc', contextId: 'ctx-1' });
    });

    it('InMemoryTaskStore returns undefined for unknown taskId', async () => {
      const store = TaskStoreFactory.createFromEnv();
      const result = await store.load('nonexistent-task');
      expect(result).toBeUndefined();
    });
  });
});
