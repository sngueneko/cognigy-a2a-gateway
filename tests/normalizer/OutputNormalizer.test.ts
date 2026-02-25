/**
 * @fileoverview Tests for OutputNormalizer.
 *
 * Rule under test (unconditional):
 *   parts[0] = TextPart  — output.text (if any) + "\n" + rendered payload (always)
 *   parts[1] = DataPart  — structured payload
 */

import { normalizeOutput, normalizeOutputs } from '../../src/normalizer/OutputNormalizer';
import type { CognigyBaseOutput } from '../../src/types/cognigy.types';

function output(text: string | null, data?: Record<string, unknown>): CognigyBaseOutput {
  return { text: text as string, data } as CognigyBaseOutput;
}

// ── helpers ───────────────────────────────────────────────────────────────────

type AnyPart = { kind: string; text?: string; data?: { type: string; payload: unknown } };

function textOf(p: AnyPart): string { return p.text ?? ''; }
function typeOf(p: AnyPart): string { return p.data?.type ?? ''; }

// ── normalizeOutput() ─────────────────────────────────────────────────────────

describe('normalizeOutput()', () => {

  // ── plain text ──────────────────────────────────────────────────────────────

  describe('text-only (no data)', () => {
    it('emits a single TextPart for plain text', () => {
      const parts = normalizeOutput(output('Hello world'), 0) as AnyPart[];
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual({ kind: 'text', text: 'Hello world' });
    });

    it('emits guard empty TextPart when both text and data are absent', () => {
      const parts = normalizeOutput(output(null), 0) as AnyPart[];
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual({ kind: 'text', text: '' });
    });

    it('emits guard empty TextPart for whitespace-only text with no data', () => {
      const parts = normalizeOutput(output('   '), 0) as AnyPart[];
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual({ kind: 'text', text: '' });
    });
  });

  // ── _quickReplies ───────────────────────────────────────────────────────────

  describe('_quickReplies', () => {
    const qr = { text: 'Choose one', quickReplies: [{ title: 'Yes' }, { title: 'No' }] };

    it('renders choices into TextPart when output.text is null', () => {
      const parts = normalizeOutput(output(null, { _quickReplies: qr }), 0) as AnyPart[];
      expect(parts).toHaveLength(2);
      expect(parts[0]!.kind).toBe('text');
      expect(textOf(parts[0]!)).toBe('Choose one\n- Yes\n- No');
      expect(parts[1]!.kind).toBe('data');
      expect(typeOf(parts[1]!)).toBe('quick_replies');
      expect(parts[1]!.data!.payload).toEqual(qr);
    });

    it('prepends output.text before rendered choices', () => {
      const parts = normalizeOutput(output('Please pick', { _quickReplies: qr }), 0) as AnyPart[];
      expect(parts).toHaveLength(2);
      expect(textOf(parts[0]!)).toBe('Please pick\nChoose one\n- Yes\n- No');
    });

    it('renders only items when payload has no .text label', () => {
      const qrNoLabel = { quickReplies: [{ title: 'OK' }, { title: 'Cancel' }] };
      const parts = normalizeOutput(output(null, { _quickReplies: qrNoLabel }), 0) as AnyPart[];
      expect(textOf(parts[0]!)).toBe('- OK\n- Cancel');
    });

    it('emits empty TextPart when payload has no items and no output.text', () => {
      const parts = normalizeOutput(output(null, { _quickReplies: {} }), 0) as AnyPart[];
      expect(parts).toHaveLength(2);
      expect(textOf(parts[0]!)).toBe('');
    });
  });

  // ── _buttons ────────────────────────────────────────────────────────────────

  describe('_buttons', () => {
    const buttons = { text: 'Pick an action', buttons: [{ title: 'Book' }, { title: 'Cancel' }] };

    it('renders buttons into TextPart when output.text is null', () => {
      const parts = normalizeOutput(output(null, { _buttons: buttons }), 0) as AnyPart[];
      expect(parts).toHaveLength(2);
      expect(textOf(parts[0]!)).toBe('Pick an action\n- Book\n- Cancel');
      expect(typeOf(parts[1]!)).toBe('buttons');
    });

    it('prepends output.text before rendered buttons', () => {
      const parts = normalizeOutput(output('What next?', { _buttons: buttons }), 0) as AnyPart[];
      expect(textOf(parts[0]!)).toBe('What next?\nPick an action\n- Book\n- Cancel');
    });

    it('renders only button titles when payload has no .text label', () => {
      const b = { buttons: [{ title: 'Go' }] };
      const parts = normalizeOutput(output(null, { _buttons: b }), 0) as AnyPart[];
      expect(textOf(parts[0]!)).toBe('- Go');
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

    it('renders header + items into TextPart when output.text is null', () => {
      const parts = normalizeOutput(output(null, { _list: list }), 0) as AnyPart[];
      expect(parts).toHaveLength(2);
      expect(textOf(parts[0]!)).toBe('Our services\n- Flights: Book a flight\n- Hotels');
      expect(typeOf(parts[1]!)).toBe('list');
    });

    it('prepends output.text before rendered list', () => {
      const parts = normalizeOutput(output('Intro', { _list: list }), 0) as AnyPart[];
      expect(textOf(parts[0]!)).toBe('Intro\nOur services\n- Flights: Book a flight\n- Hotels');
    });

    it('falls back to .text when .header is absent (legacy format)', () => {
      const legacyList = { text: 'Services', items: [{ title: 'One' }] };
      const parts = normalizeOutput(output(null, { _list: legacyList }), 0) as AnyPart[];
      expect(textOf(parts[0]!)).toBe('Services\n- One');
    });

    it('omits subtitle separator when subtitle is absent', () => {
      const l = { header: 'H', items: [{ title: 'Only title' }] };
      const parts = normalizeOutput(output(null, { _list: l }), 0) as AnyPart[];
      expect(textOf(parts[0]!)).toBe('H\n- Only title');
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

    it('renders gallery items into TextPart when output.text is null', () => {
      const parts = normalizeOutput(output(null, { _gallery: gallery }), 0) as AnyPart[];
      expect(parts).toHaveLength(2);
      expect(textOf(parts[0]!)).toBe('- Card 1: Sub 1\n- Card 2');
      expect(typeOf(parts[1]!)).toBe('carousel');
    });

    it('prepends output.text before rendered gallery items', () => {
      const parts = normalizeOutput(output('Check these out', { _gallery: gallery }), 0) as AnyPart[];
      expect(textOf(parts[0]!)).toBe('Check these out\n- Card 1: Sub 1\n- Card 2');
    });

    it('emits empty TextPart when gallery has no items and no output.text', () => {
      const parts = normalizeOutput(output(null, { _gallery: { items: [] } }), 0) as AnyPart[];
      expect(parts).toHaveLength(2);
      expect(textOf(parts[0]!)).toBe('');
    });
  });

  // ── _adaptiveCard ────────────────────────────────────────────────────────────

  describe('_adaptiveCard', () => {
    const card = {
      version: '1.4',
      body: [
        { type: 'TextBlock', text: 'Hello there' },
        { type: 'Image', url: 'https://example.com/img.png' },
        { type: 'TextBlock', text: 'How can I help?' },
      ],
    };

    it('extracts TextBlock texts from body into TextPart', () => {
      const parts = normalizeOutput(output(null, { _adaptiveCard: card }), 0) as AnyPart[];
      expect(parts).toHaveLength(2);
      expect(textOf(parts[0]!)).toBe('Hello there\nHow can I help?');
      expect(typeOf(parts[1]!)).toBe('AdaptiveCard');
    });

    it('prepends output.text before extracted card texts', () => {
      const parts = normalizeOutput(output('Intro', { _adaptiveCard: card }), 0) as AnyPart[];
      expect(textOf(parts[0]!)).toBe('Intro\nHello there\nHow can I help?');
    });

    it('emits only output.text when card body has no TextBlocks', () => {
      const cardNoText = { version: '1.4', body: [{ type: 'Image', url: 'x' }] };
      const parts = normalizeOutput(output('See image', { _adaptiveCard: cardNoText }), 0) as AnyPart[];
      expect(textOf(parts[0]!)).toBe('See image');
    });

    it('emits empty TextPart when body has no TextBlocks and output.text is null', () => {
      const cardNoText = { version: '1.4', body: [] };
      const parts = normalizeOutput(output(null, { _adaptiveCard: cardNoText }), 0) as AnyPart[];
      expect(parts).toHaveLength(2);
      expect(textOf(parts[0]!)).toBe('');
    });
  });

  // ── custom data ──────────────────────────────────────────────────────────────

  describe('custom data (cognigy/data)', () => {
    it('emits _fallbackText as TextPart + cognigy/data DataPart', () => {
      const parts = normalizeOutput(
        output(null, { _fallbackText: 'Fallback text', someKey: 'value' }),
        0,
      ) as AnyPart[];
      expect(parts[0]).toEqual({ kind: 'text', text: 'Fallback text' });
      expect(typeOf(parts[1]!)).toBe('cognigy/data');
      expect((parts[1]!.data!.payload as Record<string, unknown>)).not.toHaveProperty('_fallbackText');
      expect((parts[1]!.data!.payload as Record<string, unknown>)).toHaveProperty('someKey', 'value');
    });

    it('uses output.text over _fallbackText when both present', () => {
      const parts = normalizeOutput(
        output('Real text', { _fallbackText: 'Fallback', other: 1 }),
        0,
      ) as AnyPart[];
      const texts = parts.filter((p) => p.kind === 'text').map((p) => textOf(p));
      expect(texts).toEqual(['Real text']);
    });

    it('emits cognigy/data DataPart for plain custom data with no text', () => {
      const parts = normalizeOutput(output(null, { foo: 'bar', count: 42 }), 0) as AnyPart[];
      expect(typeOf(parts[0]!)).toBe('cognigy/data');
      expect(parts[0]!.data!.payload).toEqual({ foo: 'bar', count: 42 });
    });

    it('emits only guard TextPart when data is empty object and text is blank', () => {
      const parts = normalizeOutput(output(null, {}), 0) as AnyPart[];
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual({ kind: 'text', text: '' });
    });
  });

  // ── guard ─────────────────────────────────────────────────────────────────────

  describe('empty guard', () => {
    it('always returns at least one Part', () => {
      const parts = normalizeOutput(output(null), 0);
      expect(parts.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ── normalizeOutputs() ────────────────────────────────────────────────────────

describe('normalizeOutputs()', () => {
  it('flattens multiple plain text outputs', () => {
    const outputs: CognigyBaseOutput[] = [
      output('Hello'),
      output('World'),
    ];
    const parts = normalizeOutputs(outputs) as AnyPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ kind: 'text', text: 'Hello' });
    expect(parts[1]).toEqual({ kind: 'text', text: 'World' });
  });

  it('returns a single empty TextPart for an empty stack', () => {
    const parts = normalizeOutputs([]) as AnyPart[];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ kind: 'text', text: '' });
  });

  it('flattens text+data and plain text in order', () => {
    const qr = { text: 'Pick one', quickReplies: [{ title: 'Yes' }, { title: 'No' }] };
    const outputs: CognigyBaseOutput[] = [
      output('Pick one', { _quickReplies: qr }),
      output('Done'),
    ];
    const parts = normalizeOutputs(outputs) as AnyPart[];
    // output[0]: TextPart + DataPart = 2 parts
    // output[1]: TextPart = 1 part
    expect(parts).toHaveLength(3);
    expect(parts[0]!.kind).toBe('text');
    expect(parts[1]!.kind).toBe('data');
    expect(parts[2]!.kind).toBe('text');
  });

  it('renders label+choices for quick_replies when output.text is null', () => {
    const qr = { text: 'Choose', quickReplies: [{ title: 'Yes' }] };
    const outputs: CognigyBaseOutput[] = [
      output(null, { _quickReplies: qr }),
      output('Follow-up'),
    ];
    const parts = normalizeOutputs(outputs) as AnyPart[];
    // [TextPart('Choose\n- Yes'), DataPart(quick_replies), TextPart('Follow-up')]
    expect(parts).toHaveLength(3);
    expect(textOf(parts[0]!)).toBe('Choose\n- Yes');
    expect(parts[1]!.kind).toBe('data');
    expect(textOf(parts[2]!)).toBe('Follow-up');
  });

  it('skips outputs that throw during normalisation (resilience)', () => {
    const badOutput = null as unknown as CognigyBaseOutput;
    const goodOutput = output('Good');
    const parts = normalizeOutputs([badOutput, goodOutput]) as AnyPart[];
    expect(parts.some((p) => textOf(p) === 'Good')).toBe(true);
  });
});
