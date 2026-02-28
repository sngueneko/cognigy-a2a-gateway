/**
 * @fileoverview OutputNormalizer — converts Cognigy output objects to typed A2A event payloads.
 *
 * ## Design
 *
 * Each Cognigy output is classified into one of two A2A event kinds:
 *
 * ### `status-message` (→ TaskStatusUpdateEvent.status.message)
 * Used for all **conversational / UI** outputs: plain text, quick replies, buttons,
 * lists, galleries, adaptive cards, and custom data. These are intermediate agent
 * messages that ride inside a `TaskStatusUpdateEvent` with `state: 'working'`.
 *
 * Each produces two A2A Parts:
 *   - `TextPart`  — **always present** — a fully synthesized human-readable representation
 *                   of the entire output (label + all options/items/card texts). This ensures
 *                   any A2A client — including pure LLM agents — can read and reason about
 *                   the content without touching the DataPart.
 *   - `DataPart`  — **always present for structured types** — the original Cognigy structured
 *                   payload verbatim, keyed by its Cognigy type name. Preserved so that
 *                   downstream A2A agents or rich UI clients can reconstruct the full UI.
 *
 * ### `artifact` (→ TaskArtifactUpdateEvent)
 * Used for **binary file** outputs: images, audio, video. These are real media assets that
 * the A2A spec models as Artifacts with `FilePart` and a proper MIME type.
 * A short `TextPart` describing the file is included as a text fallback for LLM agents.
 *
 * ## Human text generation rules (TextPart)
 *
 * | Cognigy Type     | TextPart content                                            |
 * |------------------|-------------------------------------------------------------|
 * | Plain text       | `output.text` verbatim                                      |
 * | Quick replies    | `<label>\n- <title>` per option                             |
 * | Buttons          | `<label>\n- <title>` per button                             |
 * | List             | `<header>\n- <title>: <subtitle>` per item                  |
 * | Gallery          | `Here are some options:\n- <title>: <subtitle>` per card    |
 * | Adaptive Card    | All TextBlocks + FactSet rows + Input labels + Action titles |
 * | Custom data      | `_fallbackText` (if present) or omitted                     |
 * | Image            | `[Image: <url>]`                                            |
 * | Audio            | `[Audio: <url>]`                                            |
 * | Video            | `[Video: <url>]`                                            |
 *
 * ## DataPart preservation
 *
 * The original Cognigy payload is always preserved in `DataPart.data` under a typed wrapper:
 * ```json
 * { "type": "quick_replies", "payload": { ...original _quickReplies object... } }
 * ```
 * Downstream agents that understand Cognigy formats can extract and use the original data.
 * Agents that only understand text will read the TextPart and ignore the DataPart.
 */

import type { Part } from '@a2a-js/sdk';
import type { CognigyBaseOutput, CognigyAdaptiveCardElement, CognigyAdaptiveCardAction } from '../types/cognigy.types';
import {
  isQuickRepliesData,
  isGalleryData,
  isButtonsData,
  isListData,
  isAdaptiveCardData,
  isImageData,
  isAudioData,
  isVideoData,
} from '../types/cognigy.types';
import { logger } from '../logger';

const log = logger.child({ component: 'OutputNormalizer' });

// ── Discriminated union: the normalizer return type ──────────────────────────

/**
 * A `status-message` result carries Parts for `TaskStatusUpdateEvent.status.message`.
 * It always contains at minimum a TextPart, and a DataPart for structured outputs.
 */
export interface StatusMessageOutput {
  readonly kind: 'status-message';
  readonly parts: ReadonlyArray<Part>;
}

/**
 * An `artifact` result carries Parts for `TaskArtifactUpdateEvent.artifact`.
 * It always contains a FilePart (the media file) and a TextPart (fallback description).
 * `mimeType` and `name` are pre-extracted for the executor to use in artifact metadata.
 */
export interface ArtifactOutput {
  readonly kind: 'artifact';
  readonly parts: ReadonlyArray<Part>;
  readonly mimeType: string;
  readonly name: string;
  readonly fileUrl: string;
}

export type NormalizedOutput = StatusMessageOutput | ArtifactOutput;

// ── Part factories ────────────────────────────────────────────────────────────

function textPart(text: string): Part {
  return { kind: 'text', text } as Part;
}

function dataPart(type: string, payload: Record<string, unknown>): Part {
  return { kind: 'data', data: { type, payload } } as Part;
}

function filePart(uri: string, mimeType: string, name: string): Part {
  return {
    kind: 'file',
    file: { uri, mimeType, name },
  } as Part;
}

// ── MIME type inference ───────────────────────────────────────────────────────

const IMAGE_EXTS: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon',
};

const AUDIO_EXTS: Record<string, string> = {
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  webm: 'audio/webm',
};

const VIDEO_EXTS: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg',
  avi: 'video/x-msvideo', mov: 'video/quicktime', mkv: 'video/x-matroska',
  m4v: 'video/mp4',
};

/**
 * Infers a MIME type from a URL by inspecting the file extension.
 * Falls back to `fallback` if the extension is unknown.
 */
export function inferMimeType(
  url: string,
  fallback: 'image/jpeg' | 'audio/mpeg' | 'video/mp4',
): string {
  try {
    // Strip query string before extracting extension
    const clean = url.split('?')[0] ?? url;
    const ext = clean.split('.').pop()?.toLowerCase() ?? '';
    const extMap = fallback.startsWith('image')
      ? IMAGE_EXTS
      : fallback.startsWith('audio')
        ? AUDIO_EXTS
        : VIDEO_EXTS;
    return extMap[ext] ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Extracts a filename from a URL.
 * Returns 'file' if none can be determined.
 */
export function extractFilename(url: string, defaultName = 'file'): string {
  try {
    const clean = url.split('?')[0] ?? url;
    const parts = clean.split('/');
    const last = parts[parts.length - 1];
    return last && last.length > 0 ? last : defaultName;
  } catch {
    return defaultName;
  }
}

// ── String helpers ────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function mergeText(outputText: string | null | undefined, rendered: string): string {
  const a = typeof outputText === 'string' ? outputText.trim() : '';
  const b = rendered.trim();
  if (a && b) return `${a}\n${b}`;
  return a || b;
}

function getFallbackText(data: Record<string, unknown>): string | null {
  const fb = data['_fallbackText'];
  return typeof fb === 'string' && fb.trim() !== '' ? fb : null;
}

// ── Human text renderers ──────────────────────────────────────────────────────

/**
 * Quick replies: label + bullet list of option titles.
 * imageUrl per option is included as markdown if present.
 * Example:
 *   Choose your topic
 *   - Billing
 *   - Technical Support ![img](https://...)
 *   - Other
 */
function renderQuickReplies(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const label = str(payload['text']);
  if (label) lines.push(label);

  const items = payload['quickReplies'];
  if (Array.isArray(items)) {
    for (const item of items) {
      const p = item as Record<string, unknown>;
      const title = str(p['title']);
      const imageUrl = str(p['imageUrl']);
      if (!title) continue;
      lines.push(imageUrl ? `- ${title} ![image](${imageUrl})` : `- ${title}`);
    }
  }
  return lines.join('\n');
}

/**
 * Buttons: label + bullet list of button titles.
 * url-type buttons include the URL in markdown.
 * Example:
 *   What would you like to do?
 *   - Book a flight
 *   - Visit website [link](https://...)
 */
function renderButtons(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const label = str(payload['text']);
  if (label) lines.push(label);

  const items = payload['buttons'];
  if (Array.isArray(items)) {
    for (const item of items) {
      const p = item as Record<string, unknown>;
      const title = str(p['title']);
      const url = str(p['url']);
      const type = str(p['type']);
      if (!title) continue;
      // web_url buttons: append the URL so LLMs can relay it
      lines.push(url && type === 'web_url' ? `- ${title}: ${url}` : `- ${title}`);
    }
  }
  return lines.join('\n');
}

/**
 * List: header + items as "- title: subtitle" or "- title".
 * imageUrl per item included as markdown if present.
 * Example:
 *   Our services
 *   - Flights: Book domestic or international flights
 *   - Hotels ![image](https://...hotel.jpg)
 *   - Car rental: Rent a car at your destination
 */
function renderList(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const header = str(payload['header']) || str(payload['text']);
  if (header) lines.push(header);

  const items = payload['items'];
  if (Array.isArray(items)) {
    for (const item of items) {
      const p = item as Record<string, unknown>;
      const title = str(p['title']);
      const subtitle = str(p['subtitle']);
      const imageUrl = str(p['imageUrl']);
      if (!title) continue;
      let line = subtitle ? `- ${title}: ${subtitle}` : `- ${title}`;
      if (imageUrl) line += ` ![image](${imageUrl})`;
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * Gallery / carousel: intro sentence + items as "- title: subtitle ![image](url)".
 * The intro is output.text if present, otherwise "Here are some options:".
 * imageUrl per card is included as markdown so LLM consumers can see/relay the image.
 * Example:
 *   Here are some options:
 *   - ACME Cantina🍴: Great food from every corner of the world ![image](https://...jpg)
 *   - Burger Palace: Best burgers in town ![image](https://...jpg)
 */
function renderGallery(payload: Record<string, unknown>, outputText?: string | null): string {
  const lines: string[] = [];
  // Gallery has no built-in label in the payload — use output.text or a default intro
  const intro = (typeof outputText === 'string' && outputText.trim())
    ? outputText.trim()
    : 'Here are some options:';
  lines.push(intro);

  const items = payload['items'];
  if (Array.isArray(items)) {
    for (const item of items) {
      const p = item as Record<string, unknown>;
      const title = str(p['title']);
      const subtitle = str(p['subtitle']);
      const imageUrl = str(p['imageUrl']);
      if (!title) continue;
      let line = subtitle ? `- ${title}: ${subtitle}` : `- ${title}`;
      if (imageUrl) line += ` ![image](${imageUrl})`;
      lines.push(line);
    }
  }
  // If there are no items, still return the intro so the agent knows a gallery was sent
  return lines.join('\n');
}

/**
 * Adaptive Card: extract human-readable text from all known element types.
 *
 * Extracted element types:
 *   - TextBlock          → .text value
 *   - FactSet            → "<title>: <value>" per fact
 *   - Input.Text         → label + placeholder as description
 *   - Input.ChoiceSet    → label + "- <choice>" per choice
 *   - Input.Date/Number  → label + placeholder as description
 *   - Input.Toggle       → .title text
 *   - ColumnSet          → recurses into columns → items
 *   - Container          → recurses into items
 *   - Action.*           → "[Action: <title>]" for submit/openUrl/showCard etc.
 *
 * This ensures an LLM agent reading the TextPart understands both the card's
 * displayed content AND what inputs/actions it is asking the user to perform.
 */
function renderAdaptiveCard(payload: Record<string, unknown>): string {
  // Support both nested (adaptiveCard.body) and flat (body) structures
  const card = (payload['adaptiveCard'] as Record<string, unknown> | undefined) ?? payload;
  const body = card['body'] as ReadonlyArray<CognigyAdaptiveCardElement> | undefined;
  const actions = card['actions'] as ReadonlyArray<CognigyAdaptiveCardAction> | undefined;

  const lines: string[] = [];

  if (Array.isArray(body)) {
    for (const el of body) {
      extractCardElement(el, lines);
    }
  }

  if (Array.isArray(actions)) {
    for (const action of actions) {
      const title = str(action['title']);
      if (title) lines.push(`[Action: ${title}]`);
    }
  }

  return lines.join('\n');
}

function extractCardElement(el: CognigyAdaptiveCardElement, lines: string[]): void {
  if (!el || typeof el !== 'object') return;
  const type = str(el['type']);

  switch (type) {
    case 'TextBlock': {
      const t = str(el['text']);
      if (t) lines.push(t);
      break;
    }

    case 'FactSet': {
      const facts = el['facts'];
      if (Array.isArray(facts)) {
        for (const fact of facts) {
          const f = fact as { title?: string; value?: string };
          const title = str(f['title']);
          const value = str(f['value']);
          if (title && value) lines.push(`${title}: ${value}`);
          else if (title) lines.push(title);
        }
      }
      break;
    }

    case 'Input.Text':
    case 'Input.Date':
    case 'Input.Number':
    case 'Input.Time': {
      const label = str(el['label']);
      const placeholder = str(el['placeholder']);
      if (label && placeholder) lines.push(`${label} (${placeholder})`);
      else if (label) lines.push(label);
      else if (placeholder) lines.push(placeholder);
      break;
    }

    case 'Input.ChoiceSet': {
      const label = str(el['label']);
      if (label) lines.push(label);
      const choices = el['choices'];
      if (Array.isArray(choices)) {
        for (const choice of choices) {
          const c = choice as { title?: string };
          const title = str(c['title']);
          if (title) lines.push(`- ${title}`);
        }
      }
      break;
    }

    case 'Input.Toggle': {
      const title = str(el['title']);
      if (title) lines.push(title);
      break;
    }

    case 'ColumnSet': {
      const columns = el['columns'];
      if (Array.isArray(columns)) {
        for (const col of columns) {
          const items = (col as Record<string, unknown>)['items'];
          if (Array.isArray(items)) {
            for (const item of items) {
              extractCardElement(item as CognigyAdaptiveCardElement, lines);
            }
          }
        }
      }
      break;
    }

    case 'Container': {
      const items = el['items'];
      if (Array.isArray(items)) {
        for (const item of items) {
          extractCardElement(item as CognigyAdaptiveCardElement, lines);
        }
      }
      break;
    }

    case 'Action.Submit':
    case 'Action.OpenUrl':
    case 'Action.ShowCard':
    case 'Action.Execute': {
      const title = str(el['title']);
      if (title) lines.push(`[Action: ${title}]`);
      break;
    }

    // Image, Video, Media — no text to extract, skip
    default:
      break;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Normalizes a single Cognigy output into a typed `NormalizedOutput`.
 *
 * Returns:
 *   - `StatusMessageOutput` for conversational/UI outputs (text, quick replies, etc.)
 *   - `ArtifactOutput` for binary media (image, audio, video)
 *
 * @param output  - The raw Cognigy output from the socket or REST adapter
 * @param index   - Position in the output stack (used for logging)
 */
export function normalizeOutput(output: CognigyBaseOutput, index: number): NormalizedOutput {
  if (output.data !== undefined && output.data !== null) {
    const data = output.data;

    // ── Image → Artifact ──────────────────────────────────────────────────────
    if (isImageData(data)) {
      const imageUrl = data['_image']['imageUrl'];
      const mimeType = inferMimeType(imageUrl, 'image/jpeg');
      const name = extractFilename(imageUrl, 'image');
      return {
        kind: 'artifact',
        parts: [
          filePart(imageUrl, mimeType, name),
          textPart(`[Image: ${imageUrl}]`),
        ],
        mimeType,
        name,
        fileUrl: imageUrl,
      };
    }

    // ── Audio → Artifact ──────────────────────────────────────────────────────
    if (isAudioData(data)) {
      const audioUrl = data['_audio']['audioUrl'];
      const mimeType = inferMimeType(audioUrl, 'audio/mpeg');
      const name = extractFilename(audioUrl, 'audio');
      return {
        kind: 'artifact',
        parts: [
          filePart(audioUrl, mimeType, name),
          textPart(`[Audio: ${audioUrl}]`),
        ],
        mimeType,
        name,
        fileUrl: audioUrl,
      };
    }

    // ── Video → Artifact ──────────────────────────────────────────────────────
    if (isVideoData(data)) {
      const videoUrl = data['_video']['videoUrl'];
      const mimeType = inferMimeType(videoUrl, 'video/mp4');
      const name = extractFilename(videoUrl, 'video');
      return {
        kind: 'artifact',
        parts: [
          filePart(videoUrl, mimeType, name),
          textPart(`[Video: ${videoUrl}]`),
        ],
        mimeType,
        name,
        fileUrl: videoUrl,
      };
    }

    // ── Quick Replies → StatusMessage ─────────────────────────────────────────
    if (isQuickRepliesData(data)) {
      const payload = data['_quickReplies'] as Record<string, unknown>;
      const text = mergeText(output.text, renderQuickReplies(payload));
      return {
        kind: 'status-message',
        parts: [textPart(text), dataPart('quick_replies', payload)],
      };
    }

    // ── Gallery → StatusMessage ───────────────────────────────────────────────
    if (isGalleryData(data)) {
      const payload = data['_gallery'] as Record<string, unknown>;
      // Gallery renderer handles the intro sentence using output.text or default
      const text = renderGallery(payload, output.text);
      return {
        kind: 'status-message',
        parts: [textPart(text), dataPart('carousel', payload)],
      };
    }

    // ── Buttons → StatusMessage ───────────────────────────────────────────────
    if (isButtonsData(data)) {
      const payload = data['_buttons'] as Record<string, unknown>;
      const text = mergeText(output.text, renderButtons(payload));
      return {
        kind: 'status-message',
        parts: [textPart(text), dataPart('buttons', payload)],
      };
    }

    // ── List → StatusMessage ──────────────────────────────────────────────────
    if (isListData(data)) {
      const payload = data['_list'] as Record<string, unknown>;
      const text = mergeText(output.text, renderList(payload));
      return {
        kind: 'status-message',
        parts: [textPart(text), dataPart('list', payload)],
      };
    }

    // ── Adaptive Card → StatusMessage ─────────────────────────────────────────
    if (isAdaptiveCardData(data)) {
      const payload = data['_adaptiveCard'] as Record<string, unknown>;
      const cardText = renderAdaptiveCard(payload);
      const text = mergeText(output.text, cardText);
      return {
        kind: 'status-message',
        parts: [textPart(text), dataPart('AdaptiveCard', payload)],
      };
    }

    // ── Custom / unknown data → StatusMessage ─────────────────────────────────
    {
      const parts: Part[] = [];
      const rawText = typeof output.text === 'string' && output.text.trim() !== ''
        ? output.text
        : getFallbackText(data as Record<string, unknown>);
      if (rawText !== null) {
        parts.push(textPart(rawText));
      }

      // Strip Cognigy-internal keys before deciding whether to emit a DataPart
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _fallbackText: _ft, _cognigy: _cg, ...rest } = data as Record<string, unknown>;
      if (Object.keys(rest).length > 0) {
        parts.push(dataPart('cognigy/data', rest));
      }

      if (parts.length === 0) {
        log.warn(
          { index, event: 'normalizer.empty_output' },
          'Cognigy output produced no Parts — emitting empty TextPart',
        );
        parts.push(textPart(''));
      }

      return { kind: 'status-message', parts };
    }
  }

  // ── Plain text, no data ───────────────────────────────────────────────────
  if (typeof output.text === 'string' && output.text.trim() !== '') {
    return {
      kind: 'status-message',
      parts: [textPart(output.text)],
    };
  }

  // ── Guard: no text, no data ───────────────────────────────────────────────
  log.warn(
    { index, event: 'normalizer.empty_output' },
    'Cognigy output produced no Parts — emitting empty TextPart',
  );
  return {
    kind: 'status-message',
    parts: [textPart('')],
  };
}

/**
 * Normalizes a complete Cognigy output stack (REST adapter path).
 *
 * All outputs are flattened into a single `Part[]` for inclusion in a `Message`.
 * Media outputs (image/audio/video) are included as FilePart + TextPart inline
 * since the REST path cannot route them to TaskArtifactUpdateEvents.
 *
 * @param outputs - The full output stack from the REST adapter
 */
export function normalizeOutputs(outputs: ReadonlyArray<CognigyBaseOutput>): ReadonlyArray<Part> {
  if (outputs.length === 0) {
    log.warn({ event: 'normalizer.empty_stack' }, 'Cognigy returned empty outputStack');
    return [textPart('')];
  }

  const all: Part[] = [];

  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i];
    if (output === undefined) continue;
    try {
      const normalized = normalizeOutput(output, i);
      all.push(...normalized.parts);
    } catch (err) {
      log.error(
        { index: i, err, event: 'normalizer.error' },
        'Failed to normalize output — skipping',
      );
    }
  }

  return all;
}
