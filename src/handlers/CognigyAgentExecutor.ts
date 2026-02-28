/**
 * @fileoverview CognigyAgentExecutor — task-aware, streaming A2A AgentExecutor.
 *
 * ## Event routing strategy
 *
 * The executor routes each Cognigy output to the correct A2A event type based
 * on the `NormalizedOutput.kind` produced by OutputNormalizer:
 *
 * ### `status-message` outputs (text, quick replies, buttons, lists, galleries, cards)
 * → Published as `TaskStatusUpdateEvent { state: 'working', message: { parts } }`
 * These are intermediate conversational outputs that carry message content.
 * An LLM agent reading the stream always gets the full human-readable TextPart.
 * A rich UI client additionally reads the DataPart for structured rendering.
 *
 * ### `artifact` outputs (image, audio, video)
 * → Published as `TaskArtifactUpdateEvent` with `FilePart { uri, mimeType, name }`
 * These are binary media files. The artifact name and MIME type come from the
 * pre-computed `ArtifactOutput.name` and `ArtifactOutput.mimeType` fields.
 * A short TextPart `[Image: url]` / `[Audio: url]` / `[Video: url]` is included
 * as a fallback so LLM agents can reference the file in their reasoning.
 *
 * ## Full event sequences
 *
 * ### SOCKET adapter (streaming)
 * ```
 * TaskStatusUpdateEvent { state: 'working',   final: false }           ← task opened
 * TaskStatusUpdateEvent { state: 'working',   final: false, message }  ← per text/UI output
 * TaskArtifactUpdateEvent { FilePart image/audio/video }               ← per media output
 * ...
 * TaskStatusUpdateEvent { state: 'completed', final: true }            ← task closed
 * eventBus.finished()
 * ```
 *
 * ### REST adapter (synchronous)
 * ```
 * Message { parts: [...all outputs flattened...] }                     ← single response
 * eventBus.finished()
 * ```
 * REST has no task lifecycle — a single Message carries all parts.
 * Media outputs in REST are included inline as FilePart + TextPart.
 *
 * ## Terminal states (SOCKET only)
 * | Scenario          | state       |
 * |-------------------|-------------|
 * | Normal completion | `completed` |
 * | Task cancelled    | `canceled`  |
 * | Adapter error     | `failed`    |
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentExecutor, ExecutionEventBus } from '@a2a-js/sdk/server';
import { RequestContext } from '@a2a-js/sdk/server';
import type { Message, Part, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '@a2a-js/sdk';
import type { IAdapter, OutputCallback } from '../adapters/IAdapter';
import { AdapterError } from '../adapters/IAdapter';
import { RestAdapter } from '../adapters/RestAdapter';
import { SocketAdapter } from '../adapters/SocketAdapter';
import { normalizeOutput, normalizeOutputs } from '../normalizer/OutputNormalizer';
import type { NormalizedOutput } from '../normalizer/OutputNormalizer';
import type { CognigyBaseOutput } from '../types/cognigy.types';
import type { ResolvedAgentConfig } from '../types/agent.types';
import { taskSessionRegistry } from '../task/TaskSessionRegistry';
import { logger } from '../logger';

const log = logger.child({ component: 'CognigyAgentExecutor' });

export class CognigyAgentExecutor implements AgentExecutor {
  private readonly adapter: IAdapter;
  private readonly agentId: string;

  constructor(config: ResolvedAgentConfig) {
    this.agentId = config.id;
    this.adapter = this.createAdapter(config);
    log.info(
      { agentId: this.agentId, adapterType: this.adapter.type, event: 'executor.created' },
      `CognigyAgentExecutor created with ${this.adapter.type} adapter`,
    );
  }

  execute = async (requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> => {
    const { contextId, taskId } = requestContext;
    const text = this.extractText(requestContext);
    const userId = `a2a-user-${contextId}`;
    const startMs = Date.now();
    const isSocket = this.adapter.type === 'SOCKET';

    const controller = new AbortController();
    taskSessionRegistry.register(taskId, controller);

    log.info(
      { agentId: this.agentId, sessionId: contextId, taskId, adapterType: this.adapter.type, event: 'session.started' },
      'Executing A2A request',
    );

    try {
      if (isSocket) {
        // Open the task lifecycle with a working status (no message yet)
        this.publishWorking(eventBus, taskId, contextId);
      }

      const data = this.extractCognigyData(requestContext);
      let statusMessageCount = 0;
      let artifactCount = 0;

      /**
       * SocketAdapter streaming callback.
       *
       * Called once per Cognigy output event as it arrives, before finalPing.
       * Routes the output to the correct A2A event type:
       *   - status-message → TaskStatusUpdateEvent { state:'working', message }
       *   - artifact       → TaskArtifactUpdateEvent { FilePart }
       *
       * RestAdapter ignores this callback — it returns all outputs at once.
       */
      const onOutput: OutputCallback = (output: CognigyBaseOutput, index: number) => {
        if (controller.signal.aborted) return;

        let normalized: NormalizedOutput;
        try {
          normalized = normalizeOutput(output, index);
        } catch (err) {
          log.error({ agentId: this.agentId, taskId, index, err }, 'normalizeOutput threw — skipping output');
          return;
        }

        if (normalized.kind === 'status-message') {
          // Conversational / UI output → working status with message
          const event: TaskStatusUpdateEvent = {
            kind: 'status-update',
            taskId,
            contextId,
            status: {
              state: 'working',
              timestamp: new Date().toISOString(),
              message: {
                kind: 'message',
                messageId: uuidv4(),
                role: 'agent',
                parts: normalized.parts as Part[],
                contextId,
                taskId,
              },
            },
            final: false,
          };
          eventBus.publish(event);
          statusMessageCount++;

          log.debug(
            { agentId: this.agentId, taskId, index, partCount: normalized.parts.length, event: 'status.message.published' },
            'Published working status with message',
          );
        } else {
          // Binary media output → artifact update
          const event: TaskArtifactUpdateEvent = {
            kind: 'artifact-update',
            taskId,
            contextId,
            artifact: {
              artifactId: uuidv4(),
              name: normalized.name,
              parts: normalized.parts as Part[],
            },
            append: false,
            lastChunk: true, // each media file is its own complete artifact
          };
          eventBus.publish(event);
          artifactCount++;

          log.debug(
            { agentId: this.agentId, taskId, index, mimeType: normalized.mimeType, name: normalized.name, event: 'artifact.published' },
            'Published media artifact',
          );
        }
      };

      const outputs = await this.adapter.send({
        text,
        sessionId: contextId,
        userId,
        ...(data !== undefined ? { data } : {}),
        onOutput,
      });

      // Check abort after adapter returns
      if (controller.signal.aborted) {
        this.publishCanceled(eventBus, taskId, contextId);
        eventBus.finished();
        log.info({ agentId: this.agentId, taskId, event: 'task.canceled' }, 'Task canceled');
        return;
      }

      if (isSocket) {
        // Close the task with completed status
        this.publishCompleted(eventBus, taskId, contextId);
      } else {
        // REST: publish single Message with all parts flattened
        const allParts = normalizeOutputs(outputs);
        const responseMessage: Message = {
          kind: 'message',
          messageId: uuidv4(),
          role: 'agent',
          parts: allParts as Part[],
          contextId,
          taskId,
        };
        eventBus.publish(responseMessage);
      }

      eventBus.finished();

      log.info(
        {
          agentId: this.agentId,
          sessionId: contextId,
          durationMs: Date.now() - startMs,
          statusMessageCount,
          artifactCount,
          adapterType: this.adapter.type,
          event: 'session.ended',
        },
        'A2A request completed',
      );
    } catch (err) {
      log.error(
        {
          agentId: this.agentId,
          sessionId: contextId,
          durationMs: Date.now() - startMs,
          err,
          isAdapterError: err instanceof AdapterError,
          event: 'session.error',
        },
        'Error during A2A execution',
      );

      if (isSocket) {
        this.publishFailed(eventBus, taskId, contextId);
      } else {
        const errorMessage: Message = {
          kind: 'message',
          messageId: uuidv4(),
          role: 'agent',
          parts: [{ kind: 'text', text: 'An error occurred while processing your request.' } as Part],
          contextId,
          taskId,
        };
        eventBus.publish(errorMessage);
      }

      eventBus.finished();
    } finally {
      taskSessionRegistry.deregister(taskId);
    }
  };

  cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    const signalled = taskSessionRegistry.cancel(taskId);
    log.debug(
      { agentId: this.agentId, taskId, signalled, event: 'task.cancel' },
      signalled ? 'cancelTask: abort signalled' : 'cancelTask: task not in flight',
    );

    if (!signalled) {
      const event: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId,
        contextId: taskId,
        status: { state: 'canceled', timestamp: new Date().toISOString() },
        final: true,
      };
      eventBus.publish(event);
      eventBus.finished();
    }
  };

  // ─── Private helpers ──────────────────────────────────────────────────────

  private createAdapter(config: ResolvedAgentConfig): IAdapter {
    switch (config.endpointType) {
      case 'REST':
        return new RestAdapter(config.id, config.endpointUrl, config.urlToken);
      case 'SOCKET':
        return new SocketAdapter(config.id, config.endpointUrl, config.urlToken);
    }
  }

  private extractText(requestContext: RequestContext): string {
    const parts = requestContext.userMessage?.parts;
    if (!parts) return '';
    for (const part of parts) {
      if (part.kind === 'text') {
        return (part as { kind: 'text'; text: string }).text ?? '';
      }
    }
    return '';
  }

  // ─── Public helpers (exposed for tests) ──────────────────────────────────

  extractCognigyData(requestContext: RequestContext): Record<string, unknown> | undefined {
    const task = requestContext.task;
    if (!task?.metadata) return undefined;
    const cognigyData = task.metadata['cognigyData'];
    if (typeof cognigyData === 'object' && cognigyData !== null && !Array.isArray(cognigyData)) {
      return cognigyData as Record<string, unknown>;
    }
    return undefined;
  }

  publishWorking(eventBus: ExecutionEventBus, taskId: string, contextId: string): void {
    const event: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    };
    eventBus.publish(event);
  }

  publishCompleted(eventBus: ExecutionEventBus, taskId: string, contextId: string): void {
    const event: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'completed', timestamp: new Date().toISOString() },
      final: true,
    };
    eventBus.publish(event);
  }

  publishCanceled(eventBus: ExecutionEventBus, taskId: string, contextId: string): void {
    const event: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'canceled', timestamp: new Date().toISOString() },
      final: true,
    };
    eventBus.publish(event);
  }

  publishFailed(eventBus: ExecutionEventBus, taskId: string, contextId: string): void {
    const event: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'failed', timestamp: new Date().toISOString() },
      final: true,
    };
    eventBus.publish(event);
  }
}
