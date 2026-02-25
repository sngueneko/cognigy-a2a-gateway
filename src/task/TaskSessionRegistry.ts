/**
 * @fileoverview TaskSessionRegistry — tracks in-flight A2A task executions for cancellation.
 */

import { logger } from '../logger';

const log = logger.child({ component: 'TaskSessionRegistry' });

export class TaskSessionRegistry {
  private readonly sessions = new Map<string, AbortController>();

  register(taskId: string, controller: AbortController): void {
    if (this.sessions.has(taskId)) {
      log.warn({ taskId, event: 'registry.duplicate' }, 'TaskSessionRegistry: duplicate taskId registered');
    }
    this.sessions.set(taskId, controller);
    log.debug({ taskId, event: 'registry.registered' }, 'Task registered');
  }

  deregister(taskId: string): void {
    this.sessions.delete(taskId);
    log.debug({ taskId, event: 'registry.deregistered' }, 'Task deregistered');
  }

  cancel(taskId: string): boolean {
    const controller = this.sessions.get(taskId);
    if (!controller) {
      log.debug({ taskId, event: 'registry.cancel.notfound' }, 'cancelTask: task not found in registry');
      return false;
    }
    controller.abort();
    log.info({ taskId, event: 'registry.cancel.signalled' }, 'Task abort signalled');
    return true;
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** Shared singleton */
export const taskSessionRegistry = new TaskSessionRegistry();
