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
 * Cognigy appends internal metadata entries to outputStack that must be
 * filtered before returning to callers — see isCognigyInternalEntry().
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

      // Filter out Cognigy internal metadata entries (empty text + only _cognigy data).
      // Two known variants appended by Cognigy:
      //   { text: "", data: { _cognigy: { _messageId: "..." } } }
      //   { text: "", data: { _cognigy: { _messageId: "...", _finishReason: "stop" } } }
      const outputs = rawStack.filter(entry => !isCognigyInternalEntry(entry));

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
}
