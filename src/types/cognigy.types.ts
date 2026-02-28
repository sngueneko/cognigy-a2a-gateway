/**
 * @fileoverview Cognigy output type definitions.
 *
 * Models the outputStack[] from Cognigy REST endpoints
 * and the "output" event on Socket endpoints.
 *
 * Output types handled:
 *   - Plain text
 *   - _quickReplies   → conversational text with option list
 *   - _gallery        → carousel of cards with images/titles
 *   - _buttons        → text with action buttons
 *   - _list           → structured list of items
 *   - _adaptiveCard   → Microsoft Adaptive Card JSON schema
 *   - _image          → image file reference (→ A2A FilePart)
 *   - _audio          → audio file reference (→ A2A FilePart)
 *   - _video          → video file reference (→ A2A FilePart)
 *   - custom data     → arbitrary JSON payload
 */

export interface CognigyBaseOutput {
  readonly text: string | null;
  readonly data?: CognigyOutputData;
  readonly traceId?: string;
  readonly sessionId?: string;
}

export type CognigyOutputData = Record<string, unknown>;

// ── Structured output types ────────────────────────────────────────────────────

export interface CognigyQuickReply {
  readonly contentType?: 'postback' | 'user_phone_number' | 'user_email' | 'trigger_intent' | string;
  readonly payload?: string;
  readonly title: string;
  readonly imageUrl?: string;
  readonly intentName?: string;
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
  readonly type: 'postback' | 'web_url' | 'phone_number' | string;
  readonly title: string;
  readonly payload?: string;
  readonly url?: string;
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
    readonly header?: string;
    readonly text?: string;
    readonly buttons?: ReadonlyArray<CognigyButton>;
  };
}

// ── Adaptive Card types ────────────────────────────────────────────────────────

export interface CognigyAdaptiveCardElement {
  readonly type: string;
  readonly text?: string;
  readonly title?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly facts?: ReadonlyArray<{ title: string; value: string }>;
  readonly columns?: ReadonlyArray<{ items?: ReadonlyArray<CognigyAdaptiveCardElement> }>;
  readonly items?: ReadonlyArray<CognigyAdaptiveCardElement>;
  readonly choices?: ReadonlyArray<{ title: string; value: string }>;
  readonly [key: string]: unknown;
}

export interface CognigyAdaptiveCardAction {
  readonly type: string;
  readonly title?: string;
  readonly url?: string;
  readonly [key: string]: unknown;
}

export interface CognigyAdaptiveCardData {
  readonly _adaptiveCard: {
    readonly type?: 'AdaptiveCard' | string;
    readonly adaptiveCard?: {
      readonly type?: 'AdaptiveCard' | string;
      readonly version?: string;
      readonly body?: ReadonlyArray<CognigyAdaptiveCardElement>;
      readonly actions?: ReadonlyArray<CognigyAdaptiveCardAction>;
      readonly [key: string]: unknown;
    };
    readonly version?: string;
    readonly body?: ReadonlyArray<CognigyAdaptiveCardElement>;
    readonly actions?: ReadonlyArray<CognigyAdaptiveCardAction>;
    readonly [key: string]: unknown;
  };
}

// ── Media file output types ────────────────────────────────────────────────────

/**
 * Image output — Cognigy Say node "Image" type.
 * The image URL is stored in the data payload.
 * Maps to A2A TaskArtifactUpdateEvent with FilePart (mimeType: image/*).
 */
export interface CognigyImageData {
  readonly _image: {
    readonly type: 'image';
    readonly imageUrl: string;
    readonly altText?: string;
  };
}

/**
 * Audio output — Cognigy Say node "Audio" type.
 * Maps to A2A TaskArtifactUpdateEvent with FilePart (mimeType: audio/*).
 */
export interface CognigyAudioData {
  readonly _audio: {
    readonly type: 'audio';
    readonly audioUrl: string;
    readonly altText?: string;
  };
}

/**
 * Video output — Cognigy Say node "Video" type.
 * Maps to A2A TaskArtifactUpdateEvent with FilePart (mimeType: video/*).
 */
export interface CognigyVideoData {
  readonly _video: {
    readonly type: 'video';
    readonly videoUrl: string;
    readonly altText?: string;
  };
}

export type CognigyStructuredData =
  | CognigyQuickRepliesData
  | CognigyGalleryData
  | CognigyButtonsData
  | CognigyListData
  | CognigyAdaptiveCardData
  | CognigyImageData
  | CognigyAudioData
  | CognigyVideoData;

// ── Type guards ────────────────────────────────────────────────────────────────

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

export function isImageData(data: unknown): data is CognigyImageData {
  return typeof data === 'object' && data !== null && '_image' in data;
}

export function isAudioData(data: unknown): data is CognigyAudioData {
  return typeof data === 'object' && data !== null && '_audio' in data;
}

export function isVideoData(data: unknown): data is CognigyVideoData {
  return typeof data === 'object' && data !== null && '_video' in data;
}

// ── REST response types ────────────────────────────────────────────────────────

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

// ── Internal entry guard ───────────────────────────────────────────────────────

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
    if (keys.length === 0 || !keys.every(k => k === '_cognigy')) return false;

    // Entries with _cognigy._default contain real UI output (quick replies,
    // gallery, etc.) wrapped in the Cognigy envelope — NOT internal metadata.
    // Only entries with _messageId / _finishReason (and NO _default) are internal.
    const cognigyMeta = dataObj['_cognigy'] as Record<string, unknown> | undefined;
    if (cognigyMeta && '_default' in cognigyMeta) return false;

    return true;
  } catch {
    return false;
  }
}
