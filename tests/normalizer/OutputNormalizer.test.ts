/**
 * @fileoverview Tests for OutputNormalizer.
 *
 * Tests cover:
 *   - normalizeOutput() → NormalizedOutput discriminated union
 *     - kind: 'status-message' for text, quick replies, buttons, lists, galleries, cards, custom data
 *     - kind: 'artifact' for image, audio, video
 *   - TextPart human-text generation rules
 *   - DataPart original payload preservation
 *   - inferMimeType() + extractFilename() utilities
 *   - normalizeOutputs() flattening for REST path
 */

import {
  normalizeOutput,
  normalizeOutputs,
  inferMimeType,
  extractFilename,
} from '../../src/normalizer/OutputNormalizer';
import type { NormalizedOutput, StatusMessageOutput, ArtifactOutput } from '../../src/normalizer/OutputNormalizer';
import type { CognigyBaseOutput } from '../../src/types/cognigy.types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function output(text: string | null, data?: Record<string, unknown>): CognigyBaseOutput {
  return { text: text as string, data } as CognigyBaseOutput;
}

type AnyPart = { kind: string; text?: string; data?: { type: string; payload: unknown }; file?: { uri: string; mimeType: string; name: string } };

function asStatus(n: NormalizedOutput): StatusMessageOutput {
  expect(n.kind).toBe('status-message');
  return n as StatusMessageOutput;
}

function asArtifact(n: NormalizedOutput): ArtifactOutput {
  expect(n.kind).toBe('artifact');
  return n as ArtifactOutput;
}

function textOf(p: AnyPart): string { return p.text ?? ''; }
function dataTypeOf(p: AnyPart): string { return p.data?.type ?? ''; }

// ── inferMimeType ─────────────────────────────────────────────────────────────

describe('inferMimeType()', () => {
  it('infers image/png from .png URL', () => {
    expect(inferMimeType('https://cdn.example.com/photo.png', 'image/jpeg')).toBe('image/png');
  });
  it('infers image/jpeg from .jpg URL', () => {
    expect(inferMimeType('https://cdn.example.com/photo.jpg', 'image/jpeg')).toBe('image/jpeg');
  });
  it('infers audio/mpeg from .mp3 URL', () => {
    expect(inferMimeType('https://cdn.example.com/track.mp3', 'audio/mpeg')).toBe('audio/mpeg');
  });
  it('infers audio/ogg from .ogg URL', () => {
    expect(inferMimeType('https://cdn.example.com/sound.ogg', 'audio/mpeg')).toBe('audio/ogg');
  });
  it('infers video/mp4 from .mp4 URL', () => {
    expect(inferMimeType('https://cdn.example.com/clip.mp4', 'video/mp4')).toBe('video/mp4');
  });
  it('infers video/webm from .webm URL', () => {
    expect(inferMimeType('https://cdn.example.com/clip.webm', 'video/mp4')).toBe('video/webm');
  });
  it('falls back to image/jpeg for unknown extension', () => {
    expect(inferMimeType('https://cdn.example.com/file.xyz', 'image/jpeg')).toBe('image/jpeg');
  });
  it('strips query string before extracting extension', () => {
    expect(inferMimeType('https://cdn.example.com/image.png?size=large', 'image/jpeg')).toBe('image/png');
  });
});

// ── extractFilename ───────────────────────────────────────────────────────────

describe('extractFilename()', () => {
  it('extracts filename from URL', () => {
    expect(extractFilename('https://cdn.example.com/photo.png')).toBe('photo.png');
  });
  it('strips query string', () => {
    expect(extractFilename('https://cdn.example.com/photo.png?v=2')).toBe('photo.png');
  });
  it('returns default when URL has no path segment', () => {
    expect(extractFilename('https://cdn.example.com/', 'file')).toBe('file');
  });
});

// ── normalizeOutput() ─────────────────────────────────────────────────────────

describe('normalizeOutput()', () => {

  // ── plain text ──────────────────────────────────────────────────────────────

  describe('plain text (no data)', () => {
    it('returns kind:status-message with single TextPart', () => {
      const n = asStatus(normalizeOutput(output('Hello world'), 0));
      expect(n.parts).toHaveLength(1);
      expect(n.parts[0]).toEqual({ kind: 'text', text: 'Hello world' });
    });

    it('returns empty TextPart when both text and data are absent', () => {
      const n = asStatus(normalizeOutput(output(null), 0));
      expect(n.parts).toHaveLength(1);
      expect(n.parts[0]).toEqual({ kind: 'text', text: '' });
    });

    it('returns empty TextPart for whitespace-only text with no data', () => {
      const n = asStatus(normalizeOutput(output('   '), 0));
      expect(n.parts).toHaveLength(1);
      expect(n.parts[0]).toEqual({ kind: 'text', text: '' });
    });
  });

  // ── _quickReplies ───────────────────────────────────────────────────────────

  describe('_quickReplies', () => {
    const qr = { text: 'Choose one', quickReplies: [{ title: 'Yes' }, { title: 'No' }] };

    it('returns kind:status-message', () => {
      expect(normalizeOutput(output(null, { _quickReplies: qr }), 0).kind).toBe('status-message');
    });

    it('TextPart = label + option list when output.text is null', () => {
      const n = asStatus(normalizeOutput(output(null, { _quickReplies: qr }), 0));
      const parts = n.parts as AnyPart[];
      expect(textOf(parts[0]!)).toBe('Choose one\n- Yes\n- No');
    });

    it('TextPart prepends output.text before label+options', () => {
      const n = asStatus(normalizeOutput(output('Please pick', { _quickReplies: qr }), 0));
      const parts = n.parts as AnyPart[];
      expect(textOf(parts[0]!)).toBe('Please pick\nChoose one\n- Yes\n- No');
    });

    it('DataPart type is quick_replies', () => {
      const n = asStatus(normalizeOutput(output(null, { _quickReplies: qr }), 0));
      const parts = n.parts as AnyPart[];
      expect(parts[1]?.kind).toBe('data');
      expect(dataTypeOf(parts[1]!)).toBe('quick_replies');
    });

    it('DataPart payload is the original _quickReplies object', () => {
      const n = asStatus(normalizeOutput(output(null, { _quickReplies: qr }), 0));
      const parts = n.parts as AnyPart[];
      expect(parts[1]!.data!.payload).toEqual(qr);
    });

    it('renders only items when payload has no .text label', () => {
      const qrNoLabel = { quickReplies: [{ title: 'OK' }, { title: 'Cancel' }] };
      const n = asStatus(normalizeOutput(output(null, { _quickReplies: qrNoLabel }), 0));
      expect(textOf((n.parts as AnyPart[])[0]!)).toBe('- OK\n- Cancel');
    });

    it('emits [TextPart, DataPart] totalling 2 parts', () => {
      const n = asStatus(normalizeOutput(output(null, { _quickReplies: qr }), 0));
      expect(n.parts).toHaveLength(2);
    });
  });

  // ── _buttons ────────────────────────────────────────────────────────────────

  describe('_buttons', () => {
    const buttons = { text: 'Pick an action', buttons: [{ title: 'Book' }, { title: 'Cancel' }] };

    it('returns kind:status-message', () => {
      expect(normalizeOutput(output(null, { _buttons: buttons }), 0).kind).toBe('status-message');
    });

    it('TextPart = label + button list', () => {
      const n = asStatus(normalizeOutput(output(null, { _buttons: buttons }), 0));
      expect(textOf((n.parts as AnyPart[])[0]!)).toBe('Pick an action\n- Book\n- Cancel');
    });

    it('TextPart prepends output.text', () => {
      const n = asStatus(normalizeOutput(output('What next?', { _buttons: buttons }), 0));
      expect(textOf((n.parts as AnyPart[])[0]!)).toBe('What next?\nPick an action\n- Book\n- Cancel');
    });

    it('DataPart type is buttons', () => {
      const n = asStatus(normalizeOutput(output(null, { _buttons: buttons }), 0));
      expect(dataTypeOf((n.parts as AnyPart[])[1]!)).toBe('buttons');
    });

    it('renders only button titles when payload has no .text label', () => {
      const b = { buttons: [{ title: 'Go' }] };
      const n = asStatus(normalizeOutput(output(null, { _buttons: b }), 0));
      expect(textOf((n.parts as AnyPart[])[0]!)).toBe('- Go');
    });
  });

  // ── _list ───────────────────────────────────────────────────────────────────

  describe('_list', () => {
    const list = {
      header: 'Our services',
      items: [
        { title: 'Flights', subtitle: 'Book a flight' },
        { title: 'Hotels' },
      ],
    };

    it('returns kind:status-message', () => {
      expect(normalizeOutput(output(null, { _list: list }), 0).kind).toBe('status-message');
    });

    it('TextPart = header + items', () => {
      const n = asStatus(normalizeOutput(output(null, { _list: list }), 0));
      expect(textOf((n.parts as AnyPart[])[0]!)).toBe('Our services\n- Flights: Book a flight\n- Hotels');
    });

    it('TextPart prepends output.text', () => {
      const n = asStatus(normalizeOutput(output('Intro', { _list: list }), 0));
      expect(textOf((n.parts as AnyPart[])[0]!)).toBe('Intro\nOur services\n- Flights: Book a flight\n- Hotels');
    });

    it('falls back to .text when .header is absent (legacy format)', () => {
      const legacyList = { text: 'Services', items: [{ title: 'One' }] };
      const n = asStatus(normalizeOutput(output(null, { _list: legacyList }), 0));
      expect(textOf((n.parts as AnyPart[])[0]!)).toBe('Services\n- One');
    });

    it('DataPart type is list', () => {
      const n = asStatus(normalizeOutput(output(null, { _list: list }), 0));
      expect(dataTypeOf((n.parts as AnyPart[])[1]!)).toBe('list');
    });
  });

  // ── _gallery ────────────────────────────────────────────────────────────────

  describe('_gallery', () => {
    const gallery = {
      items: [
        { title: 'Card 1', subtitle: 'Sub 1' },
        { title: 'Card 2' },
      ],
    };

    it('returns kind:status-message', () => {
      expect(normalizeOutput(output(null, { _gallery: gallery }), 0).kind).toBe('status-message');
    });

    it('TextPart starts with default intro when output.text is null', () => {
      const n = asStatus(normalizeOutput(output(null, { _gallery: gallery }), 0));
      const text = textOf((n.parts as AnyPart[])[0]!);
      expect(text).toContain('Here are some options:');
      expect(text).toContain('- Card 1: Sub 1');
      expect(text).toContain('- Card 2');
    });

    it('TextPart uses output.text as intro when provided (replaces default)', () => {
      const n = asStatus(normalizeOutput(output('Check these out', { _gallery: gallery }), 0));
      const text = textOf((n.parts as AnyPart[])[0]!);
      expect(text.startsWith('Check these out')).toBe(true);
      expect(text).toContain('- Card 1: Sub 1');
      expect(text).not.toContain('Here are some options:');
    });

    it('TextPart still has intro when gallery has no items', () => {
      const n = asStatus(normalizeOutput(output(null, { _gallery: { items: [] } }), 0));
      const text = textOf((n.parts as AnyPart[])[0]!);
      expect(text).toContain('Here are some options:');
    });

    it('DataPart type is carousel', () => {
      const n = asStatus(normalizeOutput(output(null, { _gallery: gallery }), 0));
      expect(dataTypeOf((n.parts as AnyPart[])[1]!)).toBe('carousel');
    });

    it('DataPart payload is the original _gallery object', () => {
      const n = asStatus(normalizeOutput(output(null, { _gallery: gallery }), 0));
      expect((n.parts as AnyPart[])[1]!.data!.payload).toEqual(gallery);
    });
  });

  // ── _adaptiveCard ─────────────────────────────────────────────────────────

  describe('_adaptiveCard', () => {
    it('returns kind:status-message', () => {
      const card = { version: '1.4', body: [{ type: 'TextBlock', text: 'Hello' }] };
      expect(normalizeOutput(output(null, { _adaptiveCard: card }), 0).kind).toBe('status-message');
    });

    it('extracts TextBlock.text values', () => {
      const card = {
        version: '1.4',
        body: [
          { type: 'TextBlock', text: 'Hello there' },
          { type: 'Image', url: 'https://example.com/img.png' },
          { type: 'TextBlock', text: 'How can I help?' },
        ],
      };
      const n = asStatus(normalizeOutput(output(null, { _adaptiveCard: card }), 0));
      expect(textOf((n.parts as AnyPart[])[0]!)).toBe('Hello there\nHow can I help?');
    });

    it('extracts FactSet facts as "title: value"', () => {
      const card = {
        version: '1.4',
        body: [
          {
            type: 'FactSet',
            facts: [
              { title: 'Departure', value: 'Paris CDG' },
              { title: 'Arrival', value: 'Berlin BER' },
            ],
          },
        ],
      };
      const n = asStatus(normalizeOutput(output(null, { _adaptiveCard: card }), 0));
      const text = textOf((n.parts as AnyPart[])[0]!);
      expect(text).toContain('Departure: Paris CDG');
      expect(text).toContain('Arrival: Berlin BER');
    });

    it('extracts Input.Text label and placeholder', () => {
      const card = {
        version: '1.4',
        body: [{ type: 'Input.Text', label: 'Your name', placeholder: 'Enter your name here' }],
      };
      const n = asStatus(normalizeOutput(output(null, { _adaptiveCard: card }), 0));
      const text = textOf((n.parts as AnyPart[])[0]!);
      expect(text).toContain('Your name');
      expect(text).toContain('Enter your name here');
    });

    it('extracts Input.ChoiceSet label and choice titles', () => {
      const card = {
        version: '1.4',
        body: [
          {
            type: 'Input.ChoiceSet',
            label: 'Select seat class',
            choices: [{ title: 'Economy' }, { title: 'Business' }, { title: 'First' }],
          },
        ],
      };
      const n = asStatus(normalizeOutput(output(null, { _adaptiveCard: card }), 0));
      const text = textOf((n.parts as AnyPart[])[0]!);
      expect(text).toContain('Select seat class');
      expect(text).toContain('- Economy');
      expect(text).toContain('- Business');
      expect(text).toContain('- First');
    });

    it('extracts Action titles as "[Action: <title>]"', () => {
      const card = {
        version: '1.4',
        body: [{ type: 'TextBlock', text: 'Confirm?' }],
        actions: [
          { type: 'Action.Submit', title: 'Confirm' },
          { type: 'Action.OpenUrl', title: 'Learn more', url: 'https://example.com' },
        ],
      };
      const n = asStatus(normalizeOutput(output(null, { _adaptiveCard: card }), 0));
      const text = textOf((n.parts as AnyPart[])[0]!);
      expect(text).toContain('[Action: Confirm]');
      expect(text).toContain('[Action: Learn more]');
    });

    it('extracts nested elements inside ColumnSet', () => {
      const card = {
        version: '1.4',
        body: [{
          type: 'ColumnSet',
          columns: [
            { items: [{ type: 'TextBlock', text: 'Column A' }] },
            { items: [{ type: 'TextBlock', text: 'Column B' }] },
          ],
        }],
      };
      const n = asStatus(normalizeOutput(output(null, { _adaptiveCard: card }), 0));
      const text = textOf((n.parts as AnyPart[])[0]!);
      expect(text).toContain('Column A');
      expect(text).toContain('Column B');
    });

    it('prepends output.text before card text', () => {
      const card = { version: '1.4', body: [{ type: 'TextBlock', text: 'Card content' }] };
      const n = asStatus(normalizeOutput(output('Intro text', { _adaptiveCard: card }), 0));
      expect(textOf((n.parts as AnyPart[])[0]!)).toBe('Intro text\nCard content');
    });

    it('DataPart type is AdaptiveCard', () => {
      const card = { version: '1.4', body: [] };
      const n = asStatus(normalizeOutput(output(null, { _adaptiveCard: card }), 0));
      expect(dataTypeOf((n.parts as AnyPart[])[1]!)).toBe('AdaptiveCard');
    });

    it('emits only output.text when card body has no extractable text', () => {
      const card = { version: '1.4', body: [{ type: 'Image', url: 'x' }] };
      const n = asStatus(normalizeOutput(output('See image', { _adaptiveCard: card }), 0));
      expect(textOf((n.parts as AnyPart[])[0]!)).toBe('See image');
    });
  });

  // ── image → artifact ──────────────────────────────────────────────────────

  describe('_image → ArtifactOutput', () => {
    const imageData = { _image: { type: 'image', imageUrl: 'https://cdn.example.com/photo.png' } };

    it('returns kind:artifact', () => {
      expect(normalizeOutput(output(null, imageData), 0).kind).toBe('artifact');
    });

    it('artifact has correct mimeType, name, fileUrl', () => {
      const n = asArtifact(normalizeOutput(output(null, imageData), 0));
      expect(n.mimeType).toBe('image/png');
      expect(n.name).toBe('photo.png');
      expect(n.fileUrl).toBe('https://cdn.example.com/photo.png');
    });

    it('parts[0] is FilePart with correct uri and mimeType', () => {
      const n = asArtifact(normalizeOutput(output(null, imageData), 0));
      const fp = n.parts[0] as AnyPart;
      expect(fp.kind).toBe('file');
      expect(fp.file?.uri).toBe('https://cdn.example.com/photo.png');
      expect(fp.file?.mimeType).toBe('image/png');
      expect(fp.file?.name).toBe('photo.png');
    });

    it('parts[1] is TextPart fallback "[Image: <url>]"', () => {
      const n = asArtifact(normalizeOutput(output(null, imageData), 0));
      const tp = n.parts[1] as AnyPart;
      expect(tp.kind).toBe('text');
      expect(tp.text).toBe('[Image: https://cdn.example.com/photo.png]');
    });

    it('infers image/jpeg for .jpg extension', () => {
      const data = { _image: { type: 'image', imageUrl: 'https://cdn.example.com/shot.jpg' } };
      const n = asArtifact(normalizeOutput(output(null, data), 0));
      expect(n.mimeType).toBe('image/jpeg');
    });

    it('falls back to image/jpeg for unknown image extension', () => {
      const data = { _image: { type: 'image', imageUrl: 'https://cdn.example.com/img.xyz' } };
      const n = asArtifact(normalizeOutput(output(null, data), 0));
      expect(n.mimeType).toBe('image/jpeg');
    });
  });

  // ── audio → artifact ──────────────────────────────────────────────────────

  describe('_audio → ArtifactOutput', () => {
    const audioData = { _audio: { type: 'audio', audioUrl: 'https://cdn.example.com/track.mp3' } };

    it('returns kind:artifact', () => {
      expect(normalizeOutput(output(null, audioData), 0).kind).toBe('artifact');
    });

    it('artifact has mimeType audio/mpeg', () => {
      const n = asArtifact(normalizeOutput(output(null, audioData), 0));
      expect(n.mimeType).toBe('audio/mpeg');
      expect(n.name).toBe('track.mp3');
    });

    it('parts[0] is FilePart with correct uri', () => {
      const n = asArtifact(normalizeOutput(output(null, audioData), 0));
      const fp = n.parts[0] as AnyPart;
      expect(fp.kind).toBe('file');
      expect(fp.file?.uri).toBe('https://cdn.example.com/track.mp3');
    });

    it('parts[1] is TextPart "[Audio: <url>]"', () => {
      const n = asArtifact(normalizeOutput(output(null, audioData), 0));
      const tp = n.parts[1] as AnyPart;
      expect(tp.kind).toBe('text');
      expect(tp.text).toBe('[Audio: https://cdn.example.com/track.mp3]');
    });
  });

  // ── video → artifact ──────────────────────────────────────────────────────

  describe('_video → ArtifactOutput', () => {
    const videoData = { _video: { type: 'video', videoUrl: 'https://cdn.example.com/clip.mp4' } };

    it('returns kind:artifact', () => {
      expect(normalizeOutput(output(null, videoData), 0).kind).toBe('artifact');
    });

    it('artifact has mimeType video/mp4', () => {
      const n = asArtifact(normalizeOutput(output(null, videoData), 0));
      expect(n.mimeType).toBe('video/mp4');
      expect(n.name).toBe('clip.mp4');
    });

    it('parts[0] is FilePart, parts[1] is TextPart "[Video: <url>]"', () => {
      const n = asArtifact(normalizeOutput(output(null, videoData), 0));
      expect((n.parts[0] as AnyPart).kind).toBe('file');
      expect((n.parts[1] as AnyPart).text).toBe('[Video: https://cdn.example.com/clip.mp4]');
    });

    it('infers video/webm for .webm extension', () => {
      const data = { _video: { type: 'video', videoUrl: 'https://cdn.example.com/clip.webm' } };
      const n = asArtifact(normalizeOutput(output(null, data), 0));
      expect(n.mimeType).toBe('video/webm');
    });
  });

  // ── custom data ──────────────────────────────────────────────────────────

  describe('custom data (cognigy/data)', () => {
    it('returns kind:status-message', () => {
      const n = normalizeOutput(output(null, { _fallbackText: 'Fallback', someKey: 'v' }), 0);
      expect(n.kind).toBe('status-message');
    });

    it('uses _fallbackText as TextPart', () => {
      const n = asStatus(normalizeOutput(output(null, { _fallbackText: 'Fallback text', someKey: 'value' }), 0));
      const parts = n.parts as AnyPart[];
      expect(textOf(parts[0]!)).toBe('Fallback text');
    });

    it('DataPart type is cognigy/data', () => {
      const n = asStatus(normalizeOutput(output(null, { _fallbackText: 'fb', someKey: 'v' }), 0));
      expect(dataTypeOf((n.parts as AnyPart[])[1]!)).toBe('cognigy/data');
    });

    it('_fallbackText and _cognigy keys are stripped from DataPart payload', () => {
      const n = asStatus(normalizeOutput(output(null, { _fallbackText: 'fb', _cognigy: { id: '1' }, real: 'data' }), 0));
      const payload = (n.parts as AnyPart[])[1]!.data!.payload as Record<string, unknown>;
      expect(payload).not.toHaveProperty('_fallbackText');
      expect(payload).not.toHaveProperty('_cognigy');
      expect(payload).toHaveProperty('real', 'data');
    });

    it('uses output.text over _fallbackText', () => {
      const n = asStatus(normalizeOutput(output('Real text', { _fallbackText: 'Fallback', other: 1 }), 0));
      const textParts = (n.parts as AnyPart[]).filter(p => p.kind === 'text');
      expect(textParts[0]!.text).toBe('Real text');
    });

    it('emits only DataPart when there is no text and no _fallbackText', () => {
      const n = asStatus(normalizeOutput(output(null, { foo: 'bar' }), 0));
      const parts = n.parts as AnyPart[];
      expect(parts[0]!.kind).toBe('data');
      expect(parts[0]!.data!.payload).toEqual({ foo: 'bar' });
    });

    it('emits guard TextPart when data is empty object and text is blank', () => {
      const n = asStatus(normalizeOutput(output(null, {}), 0));
      expect(n.parts).toHaveLength(1);
      expect(n.parts[0]).toEqual({ kind: 'text', text: '' });
    });
  });

  // ── guard ─────────────────────────────────────────────────────────────────

  describe('empty guard', () => {
    it('always returns at least one Part', () => {
      const n = normalizeOutput(output(null), 0);
      expect(n.parts.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ── normalizeOutputs() — REST path flattening ─────────────────────────────────

describe('normalizeOutputs()', () => {
  it('flattens multiple plain text outputs into Part[]', () => {
    const parts = normalizeOutputs([output('Hello'), output('World')]) as AnyPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ kind: 'text', text: 'Hello' });
    expect(parts[1]).toEqual({ kind: 'text', text: 'World' });
  });

  it('returns single empty TextPart for empty stack', () => {
    const parts = normalizeOutputs([]) as AnyPart[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ kind: 'text', text: '' });
  });

  it('flattens text+data output followed by plain text', () => {
    const qr = { text: 'Pick one', quickReplies: [{ title: 'Yes' }, { title: 'No' }] };
    const parts = normalizeOutputs([output(null, { _quickReplies: qr }), output('Done')]) as AnyPart[];
    // [TextPart, DataPart, TextPart] = 3 parts
    expect(parts).toHaveLength(3);
    expect(parts[0]!.kind).toBe('text');
    expect(parts[1]!.kind).toBe('data');
    expect(parts[2]!.kind).toBe('text');
  });

  it('includes image FilePart inline for REST path', () => {
    const imageData = { _image: { type: 'image', imageUrl: 'https://cdn.example.com/photo.png' } };
    const parts = normalizeOutputs([output('Text first'), output(null, imageData)]) as AnyPart[];
    // TextPart from text output + FilePart + TextPart from image artifact
    expect(parts.some(p => p.kind === 'file')).toBe(true);
    const filePart = parts.find(p => p.kind === 'file');
    expect(filePart?.file?.uri).toBe('https://cdn.example.com/photo.png');
    expect(filePart?.file?.mimeType).toBe('image/png');
  });

  it('skips outputs that throw during normalisation (resilience)', () => {
    const badOutput = null as unknown as CognigyBaseOutput;
    const goodOutput = output('Good');
    const parts = normalizeOutputs([badOutput, goodOutput]) as AnyPart[];
    expect(parts.some(p => textOf(p) === 'Good')).toBe(true);
  });
});
