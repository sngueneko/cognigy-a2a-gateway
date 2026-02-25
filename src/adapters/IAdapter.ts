import type { CognigyBaseOutput } from '../types/cognigy.types';

/**
 * Callback invoked by SocketAdapter for each Cognigy output event received
 * before finalPing. Allows the executor to stream partial results to the
 * A2A caller as TaskArtifactUpdateEvents rather than waiting for all outputs.
 *
 * Not called by RestAdapter (REST returns all outputs at once).
 */
export type OutputCallback = (output: CognigyBaseOutput, index: number) => void;

export interface AdapterSendParams {
  readonly text: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly data?: Record<string, unknown>;
  /** Called per output event as it arrives (SocketAdapter only). */
  readonly onOutput?: OutputCallback;
}

export interface IAdapter {
  send(params: AdapterSendParams): Promise<ReadonlyArray<CognigyBaseOutput>>;
  readonly type: 'REST' | 'SOCKET';
}

export class AdapterError extends Error {
  public readonly adapterType: 'REST' | 'SOCKET';
  public readonly cause?: unknown;
  constructor(message: string, adapterType: 'REST' | 'SOCKET', cause?: unknown) {
    super(message);
    this.name = 'AdapterError';
    this.adapterType = adapterType;
    this.cause = cause;
  }
}
