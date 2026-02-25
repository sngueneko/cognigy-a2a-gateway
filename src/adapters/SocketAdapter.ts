/**
 * @fileoverview SocketAdapter — IAdapter implementation for Cognigy Socket Endpoints.
 *
 * Streaming behaviour
 * ──────────────────
 * When AdapterSendParams.onOutput is provided, each Cognigy `output` event is
 * forwarded to the caller immediately via the callback as it arrives from the
 * socket — before finalPing is received. This lets CognigyAgentExecutor publish
 * a TaskArtifactUpdateEvent per output so A2A clients receive partial results
 * progressively (true streaming).
 *
 * When onOutput is not provided the adapter falls back to the original behaviour:
 * it buffers all outputs and resolves with the full array on finalPing.
 *
 * In both cases the returned Promise resolves with ALL outputs on finalPing so
 * the executor still has the complete set to build the final Message.
 *
 * Architecture note: Creates a dedicated per-session SocketClient (bound to the
 * session's userId+sessionId) to avoid cross-session output pollution.
 */

import { SocketClient } from '@cognigy/socket-client';
import type { IAdapter, AdapterSendParams } from './IAdapter';
import { AdapterError } from './IAdapter';
import type { CognigyBaseOutput } from '../types/cognigy.types';
import type { IMessage } from '@cognigy/socket-client/lib/interfaces/messageData';
import { logger } from '../logger';

const log = logger.child({ component: 'SocketAdapter' });

const SESSION_TIMEOUT_MS = 60_000;

export class SocketAdapter implements IAdapter {
  readonly type = 'SOCKET' as const;

  private readonly agentId: string;
  private readonly endpointUrl: string;
  private readonly urlToken: string;

  constructor(agentId: string, endpointUrl: string, urlToken: string) {
    this.agentId = agentId;
    this.endpointUrl = endpointUrl;
    this.urlToken = urlToken;
  }

  async send(params: AdapterSendParams): Promise<ReadonlyArray<CognigyBaseOutput>> {
    const { text, sessionId, userId, data, onOutput } = params;
    const startMs = Date.now();

    log.info(
      { agentId: this.agentId, sessionId, streaming: !!onOutput, event: 'session.started' },
      'SocketAdapter: starting session',
    );

    const client = new SocketClient(this.endpointUrl, this.urlToken, {
      userId,
      sessionId,
      channel: 'socket-client',
      reconnection: false,
      reconnectionLimit: 0,
      interval: 0,
      expiresIn: 0,
      resetFlow: false,
      forceWebsockets: true,
      disableWebsockets: false,
      enableInnerSocketHandshake: false,
      testMode: false,
      emitWithAck: false,
    });

    return new Promise<ReadonlyArray<CognigyBaseOutput>>((resolve, reject) => {
      const outputs: CognigyBaseOutput[] = [];
      let outputIndex = 0;
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timeoutHandle);
        try { client.disconnect(); } catch { /* ignore */ }
      };

      const settle = (value: CognigyBaseOutput[] | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();

        const durationMs = Date.now() - startMs;
        if (error) {
          log.error(
            { agentId: this.agentId, sessionId, durationMs, error, event: 'session.error' },
            'SocketAdapter session error',
          );
          reject(error);
        } else {
          log.info(
            { agentId: this.agentId, sessionId, durationMs, outputCount: value!.length, event: 'session.ended' },
            'SocketAdapter session completed',
          );
          resolve(value!);
        }
      };

      const timeoutHandle = setTimeout(() => {
        settle(null, new AdapterError(
          `SocketAdapter: session timed out after ${SESSION_TIMEOUT_MS}ms`,
          'SOCKET',
        ));
      }, SESSION_TIMEOUT_MS);

      // ── Output handler ────────────────────────────────────────────────────
      client.on('output', (message: IMessage) => {
        if (settled) return;

        const builtOutputs = this.buildOutputsFromMessage(message);

        for (const output of builtOutputs) {
          outputs.push(output);

          // Stream each output to executor immediately if callback provided
          if (onOutput) {
            try {
              onOutput(output, outputIndex);
            } catch (err) {
              log.warn(
                { agentId: this.agentId, sessionId, outputIndex, err, event: 'output.callback.error' },
                'SocketAdapter: onOutput callback threw',
              );
            }
          }

          outputIndex++;
        }

        log.debug(
          { agentId: this.agentId, sessionId, outputIndex, event: 'output.received' },
          'SocketAdapter: output received',
        );
      });

      // ── finalPing = session end ───────────────────────────────────────────
      client.on('finalPing', () => {
        log.debug(
          { agentId: this.agentId, sessionId, totalOutputs: outputs.length, event: 'finalping.received' },
          'SocketAdapter: finalPing received',
        );
        settle(outputs);
      });

      // ── Error / disconnect ────────────────────────────────────────────────
      client.on('disconnect', (reason: string) => {
        if (!settled) {
          settle(null, new AdapterError(
            `SocketAdapter: session disconnected unexpectedly (reason: ${reason})`,
            'SOCKET',
          ));
        }
      });

      client.on('error', (err: unknown) => {
        if (!settled) {
          settle(null, new AdapterError(
            `SocketAdapter: socket error — ${String(err)}`,
            'SOCKET',
          ));
        }
      });

      // ── Connect and send ──────────────────────────────────────────────────
      client.connect()
        .then(() => {
          if (settled) return;
          client.sendMessage(text, data);
          log.debug({ agentId: this.agentId, sessionId, event: 'message.sent' }, 'Message sent to Cognigy via socket');
        })
        .catch((connectErr: unknown) => {
          if (!settled) {
            settle(null, new AdapterError(
              `SocketAdapter: connect failed — ${String(connectErr)}`,
              'SOCKET',
            ));
          }
        });
    });
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Converts a raw Cognigy socket IMessage into one or more CognigyBaseOutput objects.
   */
  private buildOutputsFromMessage(message: IMessage): CognigyBaseOutput[] {
    const result: CognigyBaseOutput[] = [];
    const cognigyData = message.data?._cognigy;
    const defaultData = cognigyData?._default;

    if (message.text) {
      result.push({ text: message.text });
    }

    if (defaultData) {
      if (defaultData._quickReplies) {
        result.push({ text: null, data: { _cognigy: { _default: { _quickReplies: defaultData._quickReplies } } } });
      }
      if (defaultData._gallery) {
        result.push({ text: null, data: { _cognigy: { _default: { _gallery: defaultData._gallery } } } });
      }
      if (defaultData._buttons) {
        result.push({ text: null, data: { _cognigy: { _default: { _buttons: defaultData._buttons } } } });
      }
      if (defaultData._list) {
        result.push({ text: null, data: { _cognigy: { _default: { _list: defaultData._list } } } });
      }
      if (defaultData._adaptiveCard) {
        result.push({ text: null, data: { _cognigy: { _default: { _adaptiveCard: defaultData._adaptiveCard } } } });
      }
    }

    // Custom data (non-_cognigy, no text)
    if (message.data && !message.text && !cognigyData) {
      result.push({ text: null, data: message.data as Record<string, unknown> });
    }

    return result;
  }
}
