/**
 * @fileoverview OutputNormalizer — converts Cognigy output objects to A2A Parts.
 *
 * Rendering rule (unconditional for all structured types):
 *
 *   parts[0] = TextPart  — human-readable representation
 *                          = output.text (if present)
 *                          + "\n" (when both sides exist)
 *                          + rendered payload text (always)
 *   parts[1] = DataPart  — structured payload for rich / UI clients
 *
 * Rendering per type:
 *   _quickReplies → label\n- <title> per quickReply
 *   _buttons      → label\n- <title> per button
 *   _list         → header\n- <title>: <subtitle> per item
 *   _gallery      → - <title>: <subtitle> per item  (no single label)
 *   _adaptiveCard → concatenated TextBlock .text values from body[]
 *   custom data   → _fallbackText (if present), then cognigy/data DataPart
 *                   (_cognigy and _fallbackText internal keys are always stripped)
 */

import type { Part } from '@a2a-js/sdk';
import type { CognigyBaseOutput } from '../types/cognigy.types';
import {
  isQuickRepliesData,
  isGalleryData,
  isButtonsData,
  isListData,
  isAdaptiveCardData,
} from '../types/cognigy.types';
import { logger } from '../logger';

const log = logger.child({ component: 'OutputNormalizer' });

// ── Part factories ────────────────────────────────────────────────────────────

function textPart(text: string): Part {
  return { kind: 'text', text } as Part;
}

function dataPart(type: string, payload: Record<string, unknown>): Part {
  return { kind: 'data', data: { type, payload } } as Part;
}

// ── Payload text renderers ────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Renders a quick-replies payload to plain text.
 * Output: "<text>\n- <title>\n- <title>"
 */
function renderQuickReplies(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const label = str(payload['text']);
  if (label) lines.push(label);

  const items = payload['quickReplies'];
  if (Array.isArray(items)) {
    for (const item of items) {
      const title = str((item as Record<string, unknown>)['title']);
      if (title) lines.push(`- ${title}`);
    }
  }
  return lines.join('\n');
}

/**
 * Renders a buttons payload to plain text.
 * Output: "<text>\n- <title>\n- <title>"
 */
function renderButtons(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const label = str(payload['text']);
  if (label) lines.push(label);

  const items = payload['buttons'];
  if (Array.isArray(items)) {
    for (const item of items) {
      const title = str((item as Record<string, unknown>)['title']);
      if (title) lines.push(`- ${title}`);
    }
  }
  return lines.join('\n');
}

/**
 * Renders a list payload to plain text.
 * Output: "<header>\n- <title>: <subtitle>"  (subtitle omitted when absent)
 */
function renderList(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  // .header is preferred; fall back to .text for older Cognigy versions
  const header = str(payload['header']) || str(payload['text']);
  if (header) lines.push(header);

  const items = payload['items'];
  if (Array.isArray(items)) {
    for (const item of items) {
      const p = item as Record<string, unknown>;
      const title = str(p['title']);
      const subtitle = str(p['subtitle']);
      if (title && subtitle) lines.push(`- ${title}: ${subtitle}`);
      else if (title) lines.push(`- ${title}`);
    }
  }
  return lines.join('\n');
}

/**
 * Renders a gallery payload to plain text.
 * Gallery has no single label — render items directly.
 * Output: "- <title>: <subtitle>"
 */
function renderGallery(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const items = payload['items'];
  if (Array.isArray(items)) {
    for (const item of items) {
      const p = item as Record<string, unknown>;
      const title = str(p['title']);
      const subtitle = str(p['subtitle']);
      if (title && subtitle) lines.push(`- ${title}: ${subtitle}`);
      else if (title) lines.push(`- ${title}`);
    }
  }
  return lines.join('\n');
}

/**
 * Renders an AdaptiveCard payload to plain text by extracting
 * TextBlock .text values from body[].
 */
function renderAdaptiveCard(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const body = payload['body'];
  if (Array.isArray(body)) {
    for (const element of body) {
      const el = element as Record<string, unknown>;
      if (el['type'] === 'TextBlock') {
        const t = str(el['text']);
        if (t) lines.push(t);
      }
    }
  }
  return lines.join('\n');
}

// ── Merge helper ─────────────────────────────────────────────────────────────

/**
 * Combines output.text and the rendered payload text into a single string.
 * Both sides are trimmed; they are joined with "\n" when both are non-empty.
 */
function mergeText(outputText: string | null | undefined, rendered: string): string {
  const a = typeof outputText === 'string' ? outputText.trim() : '';
  const b = rendered.trim();
  if (a && b) return `${a}\n${b}`;
  return a || b;
}

// ── Fallback helper ───────────────────────────────────────────────────────────

function getFallbackText(data: Record<string, unknown>): string | null {
  const fb = data['_fallbackText'];
  return typeof fb === 'string' && fb.trim() !== '' ? fb : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function normalizeOutput(output: CognigyBaseOutput, index: number): ReadonlyArray<Part> {
  const parts: Part[] = [];

  if (output.data !== undefined && output.data !== null) {
    const data = output.data;

    if (isQuickRepliesData(data)) {
      const payload = data['_quickReplies'] as Record<string, unknown>;
      const text = mergeText(output.text, renderQuickReplies(payload));
      parts.push(textPart(text));
      parts.push(dataPart('quick_replies', payload));

    } else if (isGalleryData(data)) {
      const payload = data['_gallery'] as Record<string, unknown>;
      const text = mergeText(output.text, renderGallery(payload));
      parts.push(textPart(text));
      parts.push(dataPart('carousel', payload));

    } else if (isButtonsData(data)) {
      const payload = data['_buttons'] as Record<string, unknown>;
      const text = mergeText(output.text, renderButtons(payload));
      parts.push(textPart(text));
      parts.push(dataPart('buttons', payload));

    } else if (isListData(data)) {
      const payload = data['_list'] as Record<string, unknown>;
      const text = mergeText(output.text, renderList(payload));
      parts.push(textPart(text));
      parts.push(dataPart('list', payload));

    } else if (isAdaptiveCardData(data)) {
      const payload = data['_adaptiveCard'] as Record<string, unknown>;
      const text = mergeText(output.text, renderAdaptiveCard(payload));
      parts.push(textPart(text));
      parts.push(dataPart('AdaptiveCard', payload));

    } else {
      // ── Custom / unknown data ──────────────────────────────────────────────
      // Use output.text first, then _fallbackText as the TextPart source.
      const rawText = typeof output.text === 'string' && output.text.trim() !== ''
        ? output.text
        : getFallbackText(data);
      if (rawText !== null) {
        parts.push(textPart(rawText));
      }

      // Strip Cognigy internal keys (_cognigy metadata, _fallbackText) before
      // deciding whether to emit a DataPart. If nothing real remains, skip it.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _fallbackText: _ft, _cognigy: _cg, ...rest } = data as Record<string, unknown>;
      if (Object.keys(rest).length > 0) {
        parts.push(dataPart('cognigy/data', rest));
      }
    }

  } else if (typeof output.text === 'string' && output.text.trim() !== '') {
    // ── Plain text, no data ────────────────────────────────────────────────
    parts.push(textPart(output.text));
  }

  // ── Guard — always emit at least one Part ─────────────────────────────────
  if (parts.length === 0) {
    log.warn(
      { index, event: 'normalizer.empty_output' },
      'Cognigy output produced no Parts — emitting empty TextPart',
    );
    parts.push(textPart(''));
  }

  return parts;
}

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
      all.push(...normalizeOutput(output, i));
    } catch (err) {
      log.error(
        { index: i, err, event: 'normalizer.error' },
        'Failed to normalize output — skipping',
      );
    }
  }

  return all;
}
