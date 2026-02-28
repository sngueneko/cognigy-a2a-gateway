/**
 * @fileoverview SocketAdapter — IAdapter implementation for Cognigy Socket Endpoints.
 *
 * Streaming behaviour
 * ──────────────────
 * When AdapterSendParams.onOutput is provided, each Cognigy `output` event is
 * forwarded to the caller immediately via the callback as it arrives from the
 * socket — before finalPing is received. This lets CognigyAgentExecutor publish
 * streaming A2A events so A2A clients receive partial results progressively.
 *
 * Architecture note: Creates a dedicated per-session SocketClient (bound to the
 * session's userId+sessionId) to avoid cross-session output pollution.
 *
 * Data layout — Cognigy socket output
 * ─────────────────────────────────────────────────────────────────────────────
 * Cognigy wraps structured outputs inside:
 *   message.data._cognigy._default.<type>
 *
 * Example quick-replies:
 *   {
 *     text: "Choose one",
 *     data: {
 *       _cognigy: {
 *         _default: {
 *           _quickReplies: { text: "Choose one", quickReplies: [...] }
 *         }
 *       }
 *     }
 *   }
 *
 * The SocketAdapter UNWRAPS the payload from _cognigy._default so that
 * OutputNormalizer receives the payload at the top level, matching the
 * type guards in cognigy.types.ts:
 *
 *   { text: null, data: { _quickReplies: { text: "Choose one", ... } } }
 *
 * NOTE: When a structured type is present, the top-level message.text is
 * typically a duplicate of the structured payload's own text field. To avoid
 * emitting the same text twice, the plain-text entry is NOT emitted separately
 * when structured data (_cognigy._default.*) is present.
 *
 * Media outputs (image, audio, video) that Cognigy delivers via data fields
 * are also normalised to top-level keys (_image, _audio, _video).
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

        // RAW diagnostic � only when LOG_LEVEL=debug
        if (log.isLevelEnabled('debug')) {
          log.debug({ RAW_TEXT: message.text, RAW_DATA: JSON.stringify(message.data), event: 'output.raw' }, 'SocketAdapter RAW output');
        }

        const builtOutputs = this.buildOutputsFromMessage(message);

        for (const output of builtOutputs) {
          outputs.push(output);

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
          { agentId: this.agentId, sessionId, outputIndex, builtCount: builtOutputs.length, event: 'output.received' },
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
   *
   * ## Unwrapping
   * Cognigy wraps structured UI payloads inside `data._cognigy._default.<type>`.
   * This method UNWRAPS those payloads to the top level so that OutputNormalizer
   * type guards (isQuickRepliesData, isGalleryData, etc.) match:
   *
   *   Cognigy raw:   { text: "Choose one", data: { _cognigy: { _default: { _quickReplies: {...} } } } }
   *   Normalizer in: { text: null, data: { _quickReplies: {...} } }
   *
   * ## Text deduplication
   * When structured data (_cognigy._default.*) is present, `message.text` is typically
   * a copy of the structured payload's own `.text` field (e.g. quickReplies.text).
   * To avoid emitting duplicate text, the plain-text output is NOT emitted separately
   * when structured data is present — the TextPart is generated by the normalizer
   * from the structured payload instead.
   *
   * ## Media
   * Image/audio/video come via `message.data._image` / `_audio` / `_video` fields
   * (not inside _cognigy._default) and are emitted as separate outputs.
   *
   * ## Fallback
   * If none of the above match and the entry is not an internal metadata-only
   * entry, the raw data is forwarded as-is so OutputNormalizer's custom-data
   * path can handle it.
   */
  private buildOutputsFromMessage(message: IMessage): CognigyBaseOutput[] {
    const result: CognigyBaseOutput[] = [];

    const rawData = message.data as Record<string, unknown> | undefined;
    const cognigyMeta = rawData?.['_cognigy'] as Record<string, unknown> | undefined;
    const defaultData = cognigyMeta?.['_default'] as Record<string, unknown> | undefined;

    if (defaultData) {
      // ── Structured UI types from _cognigy._default ────────────────────────
      // Do NOT emit message.text separately — the normalizer generates the
      // TextPart from the structured payload (avoids duplicate text).
      if ('_quickReplies' in defaultData) {
        result.push({ text: null, data: { _quickReplies: defaultData['_quickReplies'] } });
      }
      if ('_gallery' in defaultData) {
        result.push({ text: null, data: { _gallery: defaultData['_gallery'] } });
      }
      if ('_buttons' in defaultData) {
        result.push({ text: null, data: { _buttons: defaultData['_buttons'] } });
      }
      if ('_list' in defaultData) {
        result.push({ text: null, data: { _list: defaultData['_list'] } });
      }
      if ('_adaptiveCard' in defaultData) {
        result.push({ text: null, data: { _adaptiveCard: defaultData['_adaptiveCard'] } });
      }

      if (result.length > 0) return result;

      // _cognigy._default present but no known type — emit text if there is any
      if (typeof message.text === 'string' && message.text.trim() !== '') {
        result.push({ text: message.text });
      }
      return result;
    }

    // ── Media: image, audio, video (at message.data root, no _cognigy wrapper) ──
    if (rawData) {
      let hasMedia = false;
      if ('_image' in rawData) {
        result.push({ text: null, data: { _image: rawData['_image'] } });
        hasMedia = true;
      }
      if ('_audio' in rawData) {
        result.push({ text: null, data: { _audio: rawData['_audio'] } });
        hasMedia = true;
      }
      if ('_video' in rawData) {
        result.push({ text: null, data: { _video: rawData['_video'] } });
        hasMedia = true;
      }
      if (hasMedia) return result;
    }

    // ── Plain text (no structured data or media) ──────────────────────────
    if (typeof message.text === 'string' && message.text.trim() !== '') {
      result.push({ text: message.text });
      return result;
    }

    // ── Internal metadata-only entry (_cognigy with only _messageId etc.) ──
    // These have text="" and data._cognigy but no _default — skip silently.
    if (cognigyMeta && !defaultData) {
      log.debug(
        { event: 'output.internal_skipped' },
        'SocketAdapter: skipping internal metadata-only output',
      );
      return result; // empty — nothing emitted
    }

    // ── Custom / unknown data ─────────────────────────────────────────────
    // No text, no known structured type, no media — forward raw data so the
    // OutputNormalizer custom-data path can handle it (e.g. _fallbackText).
    if (rawData && Object.keys(rawData).length > 0) {
      result.push({ text: null, data: rawData });
    }

    return result;
  }
}
