/**
 * @fileoverview TaskStoreFactory — creates TaskStore implementations from environment config.
 *
 * TASK_STORE_TYPE env var selects implementation:
 *   "memory" (default) — InMemoryTaskStore, zero deps, not persistent, single-instance only
 *   "redis"            — RedisTaskStore via ioredis, persistent, shared across instances
 *                        Requires: npm install ioredis
 *                        Config: TASK_STORE_REDIS_URL, TASK_STORE_REDIS_TTL_S, TASK_STORE_REDIS_PREFIX
 */

import { InMemoryTaskStore } from '@a2a-js/sdk/server';
import type { TaskStore } from '@a2a-js/sdk/server';
import type { Task } from '@a2a-js/sdk';
import { logger } from '../logger';

const log = logger.child({ component: 'TaskStoreFactory' });

// ─── Redis Task Store ─────────────────────────────────────────────────────────

/**
 * Redis-backed TaskStore. Uses ioredis loaded dynamically so ioredis is optional.
 * Install it only when TASK_STORE_TYPE=redis.
 */
class RedisTaskStore implements TaskStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private readonly ttl: number;
  private readonly prefix: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(client: any, ttl: number, prefix: string) {
    this.client = client;
    this.ttl = ttl;
    this.prefix = prefix;
  }

  private key(taskId: string): string {
    return `${this.prefix}${taskId}`;
  }

  async save(task: Task): Promise<void> {
    await this.client.set(this.key(task.id), JSON.stringify(task), 'EX', this.ttl);
  }

  async load(taskId: string): Promise<Task | undefined> {
    const raw: string | null = await this.client.get(this.key(taskId));
    if (!raw) return undefined;
    return JSON.parse(raw) as Task;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export class TaskStoreFactory {
  /**
   * Creates a TaskStore based on TASK_STORE_TYPE environment variable.
   */
  static createFromEnv(): TaskStore {
    const storeType = (process.env['TASK_STORE_TYPE'] ?? 'memory').toLowerCase();

    switch (storeType) {
      case 'memory': {
        log.info({ storeType: 'memory', event: 'taskstore.created' }, 'Using InMemoryTaskStore');
        return new InMemoryTaskStore();
      }

      case 'redis': {
        const redisUrl = process.env['TASK_STORE_REDIS_URL'] ?? 'redis://localhost:6379';
        const ttl = parseInt(process.env['TASK_STORE_REDIS_TTL_S'] ?? '3600', 10);
        const prefix = process.env['TASK_STORE_REDIS_PREFIX'] ?? 'a2a:task:';

        log.info({ storeType: 'redis', redisUrl, ttl, prefix, event: 'taskstore.created' }, 'Using RedisTaskStore');

        // Dynamic import to keep ioredis optional
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const Redis = require('ioredis');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = new Redis(redisUrl) as unknown;
        return new RedisTaskStore(client, ttl, prefix);
      }

      default:
        log.warn({ storeType, event: 'taskstore.unknown' }, `Unknown TASK_STORE_TYPE "${storeType}", falling back to memory`);
        return new InMemoryTaskStore();
    }
  }
}
