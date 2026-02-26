/**
 * @fileoverview CognigyAgentExecutor — task-aware, streaming A2A AgentExecutor.
 *
 * Streaming strategy (SocketAdapter)
 * ────────────────────────────────────────────────────────────────────────────
 * Each Cognigy `output` event is published to the A2A eventBus immediately as
 * a TaskArtifactUpdateEvent so callers receive partial results progressively:
 *
 *   TaskStatusUpdateEvent { state: 'working',   final: false }
 *   ArtifactUpdateEvent   { output 1 }
 *   ArtifactUpdateEvent   { output 2 }
 *   ...
 *   ArtifactUpdateEvent   { output N }
 *   TaskStatusUpdateEvent { state: 'completed', final: true }
 *   eventBus.finished()
 *
 * Each output gets its OWN artifact (unique artifactId) so rich clients can
 * render them independently (text bubble, quick-replies card, etc).
 * The task is closed with a terminal TaskStatusUpdateEvent — no Message is
 * published for SOCKET agents.
 *
 * Non-streaming (RestAdapter)
 * ────────────────────────────────────────────────────────────────────────────
 * REST returns all outputs at once. No task lifecycle events are needed —
 * we publish a single final Message directly.
 *
 *   Message { parts: [...all outputs...] }
 *   eventBus.finished()
 *
 * Task terminal states
 * ────────────────────────────────────────────────────────────────────────────
 *   Success   →  TaskStatusUpdateEvent { state: 'completed', final: true }
 *   Cancelled →  TaskStatusUpdateEvent { state: 'canceled',  final: true }
 *   Error     →  TaskStatusUpdateEvent { state: 'failed',    final: true }  (SOCKET)
 *              →  Message { error text }                                     (REST)
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
      // SOCKET: publish working status to open the task lifecycle
      // REST: no task lifecycle needed
      if (isSocket) {
        this.publishWorking(eventBus, taskId, contextId);
      }

      const data = this.extractCognigyData(requestContext);

      // Build streaming callback for SocketAdapter.
      // Each Cognigy output event is immediately published as a TaskArtifactUpdateEvent.
      // RestAdapter ignores onOutput — it returns all outputs at once.
      const artifactId = uuidv4();
      let outputCount = 0;
      // Buffer published artifact events so we can mark the last one lastChunk:true
      const publishedArtifacts: TaskArtifactUpdateEvent[] = [];

      const onOutput: OutputCallback = (output: CognigyBaseOutput, index: number) => {
        if (controller.signal.aborted) return;

        const parts = normalizeOutput(output, index);
        if (parts.length === 0) return;

        const event: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId,
          contextId,
          artifact: {
            artifactId: `${artifactId}-${index}`,
            parts: parts as Part[],
          },
          append: false,
          lastChunk: false, // will be corrected for the final artifact below
        };

        eventBus.publish(event);
        publishedArtifacts.push(event);
        outputCount++;

        log.debug(
          { agentId: this.agentId, taskId, index, event: 'artifact.partial' },
          'Published partial artifact',
        );
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
        // Mark the last artifact as lastChunk:true now that we know it's the last one
        const lastArtifact = publishedArtifacts[publishedArtifacts.length - 1];
        if (lastArtifact) {
          const finalArtifact: TaskArtifactUpdateEvent = {
            ...lastArtifact,
            lastChunk: true,
          };
          eventBus.publish(finalArtifact);
          log.debug(
            { agentId: this.agentId, taskId, artifactId: lastArtifact.artifact.artifactId, event: 'artifact.final' },
            'Published final artifact (lastChunk:true)',
          );
        }

        // SOCKET: close the task with a completed status — no Message needed
        this.publishCompleted(eventBus, taskId, contextId);
      } else {
        // REST: publish the complete assembled Message — no task lifecycle
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
          artifactCount: outputCount,
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
        // SOCKET: close the task with failed status
        this.publishFailed(eventBus, taskId, contextId);
      } else {
        // REST: no task to close, publish an error Message
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
      // Task is not in-flight — publish canceled immediately
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
    // If signalled: the execute() path will detect abort and publish canceled itself
  };

  // ─── Private ──────────────────────────────────────────────────────────────

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
