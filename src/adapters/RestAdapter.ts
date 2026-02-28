/**
 * @fileoverview REST Adapter for Cognigy.AI REST endpoints.
 *
 * Sends a synchronous HTTP POST to the Cognigy REST endpoint and returns
 * the full outputStack[], filtered of internal Cognigy metadata entries.
 * Uses axios with an 8-second timeout.
 *
 * Cognigy REST endpoint format:
 *   POST https://<host>/<urlToken>
 *   Body: { userId, sessionId, text, data? }
 *   Response: { text, data, outputStack[] }
 *
 * ## outputStack unwrapping
 *
 * Cognigy REST outputStack entries use the same `_cognigy._default.<type>`
 * envelope as Socket output events. Each raw entry is expanded into one or
 * more normalised CognigyBaseOutput objects so that OutputNormalizer type
 * guards (`_quickReplies`, `_gallery`, etc.) work correctly:
 *
 *   Raw entry:
 *     { text: "", data: { _cognigy: { _default: { _quickReplies: { ... } } } } }
 *
 *   Expanded:
 *     { text: null, data: { _quickReplies: { ... } } }
 *
 * Plain-text entries are passed through unchanged. Internal metadata entries
 * (only `_cognigy` key with `_messageId` / `_finishReason`) are dropped.
 *
 * This mirrors the unwrapping performed by SocketAdapter.buildOutputsFromMessage.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import type { IAdapter, AdapterSendParams } from './IAdapter';
import { AdapterError } from './IAdapter';
import type { CognigyBaseOutput, CognigyRestResponse } from '../types/cognigy.types';
import { isCognigyInternalEntry } from '../types/cognigy.types';
import { logger } from '../logger';

const REST_TIMEOUT_MS = 8_000;

/**
 * Cognigy REST request body shape.
 */
interface CognigyRestRequestBody {
  readonly userId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly data?: Record<string, unknown>;
}

/**
 * RestAdapter — communicates with Cognigy via synchronous HTTP POST.
 *
 * One instance per agent. The axios client is reused across requests
 * for connection pooling benefits.
 */
export class RestAdapter implements IAdapter {
  public readonly type = 'REST' as const;

  private readonly client: AxiosInstance;
  private readonly agentId: string;
  private readonly log = logger.child({ component: 'RestAdapter' });

  /**
   * @param agentId - Agent ID for log correlation.
   * @param endpointUrl - Cognigy REST base URL (e.g. https://endpoint.cognigy.ai).
   * @param urlToken - Cognigy URL token appended as path segment (e.g. abc123def456).
   *                   The effective request URL will be: <endpointUrl>/<urlToken>
   */
  constructor(agentId: string, endpointUrl: string, urlToken: string, axiosInstance?: AxiosInstance) {
    this.agentId = agentId;

    if (axiosInstance) {
      this.client = axiosInstance;
    } else {
      // Cognigy REST endpoint: POST <endpointUrl>/<urlToken>
      const baseURL = `${endpointUrl.replace(/\/$/, '')}/${urlToken}`;
      this.client = axios.create({
        baseURL,
        timeout: REST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });
    }
  }

  /**
   * Send a message to the Cognigy REST endpoint.
   *
   * @param params - Message parameters.
   * @returns All real output messages from the Cognigy flow (internal entries excluded).
   * @throws {AdapterError} on HTTP error, timeout, or network failure.
   */
  async send(params: AdapterSendParams): Promise<ReadonlyArray<CognigyBaseOutput>> {
    const { text, sessionId, userId, data } = params;
    const startMs = Date.now();

    this.log.debug(
      { agentId: this.agentId, sessionId, event: 'rest.request.start' },
      'Sending REST request to Cognigy',
    );

    const body: CognigyRestRequestBody = {
      userId,
      sessionId,
      text,
      ...(data !== undefined ? { data } : {}),
    };

    try {
      const response = await this.client.post<CognigyRestResponse>('', body);
      const durationMs = Date.now() - startMs;

      // Cognigy REST response uses outputStack[], not outputs[]
      const rawStack: ReadonlyArray<CognigyBaseOutput> = response.data?.outputStack ?? [];

      // RAW diagnostic � only when LOG_LEVEL=debug
      if (this.log.isLevelEnabled('debug')) {
        this.log.debug({ RAW_STACK: JSON.stringify(rawStack), event: 'rest.raw' }, 'RestAdapter RAW outputStack');
      }

      // Filter internal metadata entries first, then unwrap _cognigy._default
      // envelope so OutputNormalizer type guards work identically to the Socket path.
      const outputs: CognigyBaseOutput[] = [];
      for (const entry of rawStack) {
        if (isCognigyInternalEntry(entry)) continue;
        const expanded = this.expandOutputEntry(entry);
        outputs.push(...expanded);
      }

      this.log.info(
        {
          agentId: this.agentId,
          sessionId,
          durationMs,
          rawCount: rawStack.length,
          outputCount: outputs.length,
          event: 'rest.request.success',
        },
        'REST request completed',
      );

      return outputs;
    } catch (err) {
      const durationMs = Date.now() - startMs;

      if (axios.isAxiosError(err)) {
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;
        const isTimeout = axiosErr.code === 'ECONNABORTED' || axiosErr.code === 'ERR_CANCELED';

        this.log.error(
          {
            agentId: this.agentId,
            sessionId,
            durationMs,
            status,
            isTimeout,
            errorCode: axiosErr.code,
            event: 'rest.request.error',
          },
          'REST request failed',
        );

        if (isTimeout) {
          throw new AdapterError(
            `Cognigy REST request timed out after ${REST_TIMEOUT_MS}ms (agentId=${this.agentId})`,
            'REST',
            err,
          );
        }

        throw new AdapterError(
          `Cognigy REST request failed with HTTP ${status ?? 'unknown'} (agentId=${this.agentId})`,
          'REST',
          err,
        );
      }

      throw new AdapterError(
        `Cognigy REST request failed with unexpected error (agentId=${this.agentId})`,
        'REST',
        err,
      );
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Expands a single Cognigy REST outputStack entry into one or more
   * normalised CognigyBaseOutput objects.
   *
   * Cognigy REST uses the same `_cognigy._default.<type>` envelope as
   * Socket output events. This method performs the same unwrapping as
   * SocketAdapter.buildOutputsFromMessage so that OutputNormalizer receives
   * data in the shape its type guards expect.
   *
   * Cases handled:
   *   1. Plain text (text !== "" and text !== null) → passed through as-is
   *   2. _cognigy._default.<type> present → unwrap each known key into its
   *      own output entry (text: null, data: { _<type>: payload })
   *   3. Media fields at root (_image, _audio, _video) → emitted directly
   *   4. Unknown custom data → passed through as-is
   *
   * A single outputStack entry may produce multiple outputs (e.g. a message
   * that contains both plain text and quick replies in the same data object).
   */
  private expandOutputEntry(entry: CognigyBaseOutput): CognigyBaseOutput[] {
    const result: CognigyBaseOutput[] = [];

    // ── Plain text ─────────────────────────────────────────────────────────
    if (typeof entry.text === 'string' && entry.text.trim() !== '') {
      result.push({ text: entry.text });
    }

    const rawData = entry.data as Record<string, unknown> | undefined;
    if (!rawData) {
      // No data at all — if there was text it's already pushed
      return result.length > 0 ? result : [{ text: entry.text }];
    }

    const cognigyMeta = rawData['_cognigy'] as Record<string, unknown> | undefined;
    const defaultData = cognigyMeta?.['_default'] as Record<string, unknown> | undefined;

    if (defaultData) {
      // ── Structured UI types from _cognigy._default ──────────────────────
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
      // If _cognigy._default was present we've handled this entry
      return result;
    }

    // ── Media fields at root data level (no _cognigy wrapper) ─────────────
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

    // ── Unknown / custom data (no _cognigy, no media, no text) ────────────
    // Pass through as-is so OutputNormalizer's custom-data path handles it.
    if (result.length === 0) {
      result.push({ text: entry.text, data: rawData });
    }

    return result;
  }
}
