/**
 * @fileoverview Cognigy output type definitions.
 *
 * Models the outputStack[] from Cognigy REST endpoints
 * and the "output" event on Socket endpoints.
 */

export interface CognigyBaseOutput {
  readonly text: string | null;
  readonly data?: CognigyOutputData;
  readonly traceId?: string;
  readonly sessionId?: string;
}

export type CognigyOutputData = Record<string, unknown>;

export interface CognigyQuickReply {
  readonly contentType: 'postback' | 'user_phone_number' | 'user_email';
  readonly payload: string;
  readonly title: string;
  readonly imageUrl?: string;
}

export interface CognigyQuickRepliesData {
  readonly _quickReplies: {
    readonly type: 'quick_replies';
    readonly text: string;
    readonly quickReplies: ReadonlyArray<CognigyQuickReply>;
  };
}

export interface CognigyGalleryCard {
  readonly title: string;
  readonly subtitle?: string;
  readonly imageUrl?: string;
  readonly buttons?: ReadonlyArray<CognigyButton>;
}

export interface CognigyGalleryData {
  readonly _gallery: {
    readonly type: 'carousel';
    readonly items: ReadonlyArray<CognigyGalleryCard>;
  };
}

export interface CognigyButton {
  readonly type: 'postback' | 'web_url' | 'phone_number';
  readonly title: string;
  readonly payload: string;
}

export interface CognigyButtonsData {
  readonly _buttons: {
    readonly type: 'buttons';
    readonly text: string;
    readonly buttons: ReadonlyArray<CognigyButton>;
  };
}

export interface CognigyListItem {
  readonly title: string;
  readonly subtitle?: string;
  readonly imageUrl?: string;
  readonly buttons?: ReadonlyArray<CognigyButton>;
}

export interface CognigyListData {
  readonly _list: {
    readonly type: 'list';
    readonly items: ReadonlyArray<CognigyListItem>;
    readonly buttons?: ReadonlyArray<CognigyButton>;
  };
}

export interface CognigyAdaptiveCardData {
  readonly _adaptiveCard: {
    readonly type: 'AdaptiveCard';
    readonly version: string;
    readonly body: ReadonlyArray<Record<string, unknown>>;
    readonly actions?: ReadonlyArray<Record<string, unknown>>;
  };
}

export type CognigyStructuredData =
  | CognigyQuickRepliesData
  | CognigyGalleryData
  | CognigyButtonsData
  | CognigyListData
  | CognigyAdaptiveCardData;

/**
 * Shape of the Cognigy REST endpoint response.
 *
 * The REST endpoint returns:
 *   - outputStack[]: array of all bot outputs for this turn
 *   - text: combined text of all outputs (convenience field, we use outputStack)
 *   - data: combined data of last output
 *
 * NOTE: Cognigy appends internal metadata entries to outputStack that must be
 * filtered out before returning to callers — use isCognigyInternalEntry().
 */
export interface CognigyRestResponse {
  readonly outputStack?: ReadonlyArray<CognigyBaseOutput>;
  readonly text?: string;
  readonly data?: unknown;
  readonly userId?: string;
  readonly sessionId?: string;
}

export interface CognigySocketOutput {
  readonly text: string | null;
  readonly data?: CognigyOutputData;
  readonly type?: string;
  readonly source?: string;
  readonly traceId?: string;
  readonly sessionId?: string;
}

export interface CognigyFinalPingEvent {
  readonly sessionId?: string;
}

export function isQuickRepliesData(data: unknown): data is CognigyQuickRepliesData {
  return typeof data === 'object' && data !== null && '_quickReplies' in data;
}

export function isGalleryData(data: unknown): data is CognigyGalleryData {
  return typeof data === 'object' && data !== null && '_gallery' in data;
}

export function isButtonsData(data: unknown): data is CognigyButtonsData {
  return typeof data === 'object' && data !== null && '_buttons' in data;
}

export function isListData(data: unknown): data is CognigyListData {
  return typeof data === 'object' && data !== null && '_list' in data;
}

export function isAdaptiveCardData(data: unknown): data is CognigyAdaptiveCardData {
  return typeof data === 'object' && data !== null && '_adaptiveCard' in data;
}

/**
 * Returns true if the outputStack entry is a Cognigy internal metadata entry
 * that should never be forwarded to the A2A caller.
 *
 * Cognigy appends internal entries to outputStack that have:
 *   - text: "" or null
 *   - data that contains ONLY the "_cognigy" key (with _messageId, _finishReason, etc.)
 *
 * Two known variants:
 *   { text: "", data: { "_cognigy": { "_messageId": "...", "_finishReason": "stop" } } }  ← finish marker
 *   { text: "", data: { "_cognigy": { "_messageId": "..." } } }                            ← messageId-only entry
 *
 * data can also be a JSON string in some Cognigy versions.
 *
 * The rule: text is empty/null AND every top-level key in data is "_cognigy".
 */
export function isCognigyInternalEntry(output: CognigyBaseOutput): boolean {
  if (output.text !== '' && output.text !== null) return false;

  try {
    const dataObj: Record<string, unknown> =
      typeof output.data === 'string'
        ? (JSON.parse(output.data) as Record<string, unknown>)
        : (output.data as Record<string, unknown> | undefined) ?? {};

    const keys = Object.keys(dataObj);
    return keys.length > 0 && keys.every(k => k === '_cognigy');
  } catch {
    return false;
  }
}
