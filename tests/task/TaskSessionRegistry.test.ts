import { TaskSessionRegistry, taskSessionRegistry } from '../../src/task/TaskSessionRegistry';

describe('TaskSessionRegistry', () => {
  let registry: TaskSessionRegistry;

  beforeEach(() => {
    registry = new TaskSessionRegistry();
  });

  describe('register / deregister', () => {
    it('registers a task and increments size', () => {
      const ctrl = new AbortController();
      registry.register('task-1', ctrl);
      expect(registry.size).toBe(1);
    });

    it('deregisters a task and decrements size', () => {
      const ctrl = new AbortController();
      registry.register('task-1', ctrl);
      registry.deregister('task-1');
      expect(registry.size).toBe(0);
    });

    it('deregister on unknown taskId does not throw', () => {
      expect(() => registry.deregister('nonexistent')).not.toThrow();
    });

    it('tracks multiple tasks independently', () => {
      registry.register('t1', new AbortController());
      registry.register('t2', new AbortController());
      registry.register('t3', new AbortController());
      expect(registry.size).toBe(3);
      registry.deregister('t2');
      expect(registry.size).toBe(2);
    });
  });

  describe('cancel', () => {
    it('returns false when taskId not registered', () => {
      expect(registry.cancel('unknown-task')).toBe(false);
    });

    it('returns true and aborts controller when task is registered', () => {
      const ctrl = new AbortController();
      registry.register('task-1', ctrl);
      const result = registry.cancel('task-1');
      expect(result).toBe(true);
      expect(ctrl.signal.aborted).toBe(true);
    });

    it('does not throw when cancelling already-aborted controller', () => {
      const ctrl = new AbortController();
      ctrl.abort();
      registry.register('task-1', ctrl);
      expect(() => registry.cancel('task-1')).not.toThrow();
    });

    it('only cancels the specified task, not others', () => {
      const ctrl1 = new AbortController();
      const ctrl2 = new AbortController();
      registry.register('t1', ctrl1);
      registry.register('t2', ctrl2);
      registry.cancel('t1');
      expect(ctrl1.signal.aborted).toBe(true);
      expect(ctrl2.signal.aborted).toBe(false);
    });
  });

  describe('singleton export', () => {
    it('exports a shared singleton instance', () => {
      expect(taskSessionRegistry).toBeInstanceOf(TaskSessionRegistry);
    });
  });
});
