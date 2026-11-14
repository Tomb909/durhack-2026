import { describe, expect, it } from 'vitest';
import { BUILT_IN_IDS, CARD_DEFS, cardDef } from './defs';
import { cleanCard, fallbackCard, findCard, nearMatch, normaliseWord, register, removeWord, resolveWord, wordId, wordSound, type AskServer, MAX_PRIMITIVES, MAX_PARTS, copiesOf } from './words';

describe('words and ids', () => {
  it('normalises what was typed', () => {
    expect(normaliseWord('  haunted   house ')).toBe('HAUNTED HOUSE');
    expect(normaliseWord('a'.repeat(100))).toHaveLength(40);
    expect(normaliseWord('<script>x</script>')).toBe('SCRIPT X /SCRIPT');
    expect(normaliseWord('   ')).toBe('');
  });
  it('makes ids that fit the code grammar, the same as the server', () => {
    // The same cases as server/tests/test_words.py.
    expect(wordId('haunted house')).toBe('haunted-house');
    expect(wordId('Café')).toBe('cafe');
    expect(wordId('3d')).toBe('w-3d');
    expect(wordId('empty')).toBe('w-empty');
    expect(wordId('x3')).toBe('w-x3');
    expect(wordId('火山')).toBe('w-cf8159af');
    expect(wordId(' 火山 ')).toBe(wordId('火山'));
    for (const word of ['castle', 'haunted house', '火山', 'rock & roll', 'Ñandú', '!!!', '42']) {
      expect(wordId(word), word).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe('cleanCard, the one gate', () => {
  const good = {
    word: 'castle', icon: '🏰', color: '#9D978C', reading: 'A keep.', origin: 'llm',
    effects: [{ field: 'height', amount: 0.2, radius: 0.1 }],
    prop: { parts: [{ shape: 'box', at: [0, 0.3, 0], size: [0.5, 0.6, 0.5], rotate: [0, 0, 0], color: '#8f8a80' }], scale: 'large', count: 'one', habitat: 'land', motion: 'still', glow: false },
  };
  it('keeps a good card', () => {
    const def = cleanCard(good)!;
    expect(def.id).toBe('castle');
    expect(def.word).toBe('CASTLE');
    expect(def.color).toBe('#9d978c');
    expect(def.prop!.parts).toHaveLength(1);
    expect(def.origin).toBe('llm');
  });
  it('treats its input as hostile', () => {
    const def = cleanCard({
      word: '<img src=x onerror=alert(1)>', id: 'water', icon: '<b>💥</b>', color: 'red; background:url(x)', origin: 'admin',
      reading: '<script>steal()</script>' + 'x'.repeat(1000),
      effects: [
        { field: 'height', amount: 99, radius: 99 }, { field: 'seaLevel', amount: -5, radius: 3 }, { field: 'magic', amount: 1 },
        { field: 'life', amount: Number.NaN }, { field: 'temperature', amount: -Infinity }, { field: 'wetness', amount: '1' },
        { field: 'life', amount: -0.5 }, { field: 'settlement', amount: 0.5 }, { field: 'people', amount: 0.5 },
      ],
      atmosphere: { tint: 'javascript:1', strength: 7, light: -9, particles: { motion: 'explode', density: 1 } },
      prop: {
        parts: Array.from({ length: 1000 }, (_, k) => ({ shape: k % 2 ? 'box' : 'teapot', at: [1e9, -5, 'x'], size: [-1, 1e6, null], rotate: [1e5, 0, 0], color: '#zzzzzz' })),
        scale: 'galactic', count: 1e9, habitat: 'space', motion: 'teleport', glow: 'yes',
      },
      __proto__: { polluted: true },
    })!;
    expect(def).not.toBeNull();
    expect(def.id).not.toBe('water'); // the id comes from the word, never from the input
    expect(def.word).not.toMatch(/[<>"'&]/);
    expect(def.icon).not.toMatch(/[<>]/);
    expect(def.reading).not.toMatch(/[<>]/);
    expect(def.reading!.length).toBeLessThanOrEqual(200);
    expect(def.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(def.origin).toBe('fallback');
    expect(def.effects.length).toBeLessThanOrEqual(4);
    for (const e of def.effects) {
      expect(Number.isFinite(e.amount)).toBe(true);
      expect(Math.abs(e.amount)).toBeLessThanOrEqual(1);
      if (!e.global) expect(e.radius!).toBeLessThanOrEqual(0.3);
    }
    expect(def.effects.find((e) => e.field === 'height')!.amount).toBe(0.6);
    expect(def.effects.find((e) => e.field === 'seaLevel')).toEqual({ field: 'seaLevel', amount: -0.015, global: true });
    expect(def.atmosphere!.strength).toBe(1);
    expect(def.atmosphere!.light).toBe(-1);
    expect(def.atmosphere!.tint).toBe('#ffffff');
    expect(def.atmosphere!.particles).toBeNull();
    const prop = def.prop!;
    expect(prop.parts.length).toBeLessThanOrEqual(MAX_PARTS);
    for (const part of prop.parts) {
      expect(part.shape).toBe('box');
      expect(part.color).toMatch(/^#[0-9a-f]{6}$/);
      for (const v of [...part.at, ...part.size, ...part.rotate]) expect(Number.isFinite(v)).toBe(true);
      expect(part.at[0]).toBeLessThanOrEqual(0.5);
      expect(part.size[1]).toBeLessThanOrEqual(1);
      expect(part.size[0]).toBeGreaterThan(0);
    }
    expect([prop.scale, prop.count, prop.habitat, prop.motion, prop.glow]).toEqual(['medium', 'one', 'land', 'still', false]);
    expect(Object.keys(def)).not.toContain('polluted');
  });
  it('keeps a taper, a mirror and a repeat only where they mean something, and bounds what they draw', () => {
    const part = (extra: object) => ({ shape: 'cylinder', at: [0.2, 0.3, 0.2], size: [0.1, 0.6, 0.1], rotate: [0, 0, 0], color: '#808080', ...extra });
    const def = cleanCard({ word: 'gate', origin: 'llm', prop: { metres: 1e9, scale: 'small', parts: [
      part({ taper: 0.6, mirror: 'xz', repeat: 3.4 }), part({ taper: 9, mirror: 'y', repeat: -2 }), part({ shape: 'sphere', taper: 0.5, repeat: 500 }), part({ taper: 1 }),
    ] } })!;
    const [a, b, c, d] = def.prop!.parts;
    expect([a.taper, a.mirror, a.repeat]).toEqual([0.6, 'xz', 3]);
    expect([b.taper, b.mirror, b.repeat]).toEqual([2, undefined, undefined]);
    expect([c.taper, c.repeat]).toEqual([undefined, 12]);
    expect('taper' in d).toBe(false);
    expect(copiesOf(a)).toBe(12);
    // A real size wins over the scale word, and is bounded.
    expect([def.prop!.metres, def.prop!.scale]).toEqual([400, 'landmark']);
    // Forty parts each drawn 48 times would be 1920 shapes: the later ones lose their copies.
    const many = cleanCard({ word: 'swarm', origin: 'llm', prop: { parts: Array.from({ length: 40 }, () => part({ mirror: 'xz', repeat: 12 })) } })!;
    expect(many.prop!.parts.reduce((n, p) => n + copiesOf(p), 0)).toBeLessThanOrEqual(MAX_PRIMITIVES);
    expect(many.prop!.parts).toHaveLength(40);
  });
  it('turns away nonsense, and never replaces a built-in card', () => {
    for (const bad of [null, undefined, 5, 'castle', [], {}, { word: '' }, { word: '   ' }, { word: 42 }]) expect(cleanCard(bad)).toBeNull();
    expect(cleanCard({ ...good, word: 'water' })).toBeNull();
    expect(cleanCard({ ...good, word: 'WATER' })).toBeNull();
  });
  it('gives a card that would do nothing the abstract shape instead', () => {
    const def = cleanCard({ word: 'hollow', origin: 'llm', effects: [], prop: { parts: [] } })!;
    expect(def.origin).toBe('fallback');
    expect(def.prop!.parts.length).toBeGreaterThan(0);
  });
});

describe('the abstract fallback', () => {
  it('is the same every time for the same word', () => {
    expect(fallbackCard('swamp')).toEqual(fallbackCard('  SWAMP '));
    expect(cleanCard(fallbackCard('swamp'))).toEqual(cleanCard(fallbackCard('swamp')));
  });
  it('makes KIKI spiky and hot, BOUBA round and cool', () => {
    expect(wordSound('KIKI').spike).toBeGreaterThan(0.5);
    expect(wordSound('BOUBA').spike).toBeLessThan(-0.5);
    const kiki = fallbackCard('kiki');
    const bouba = fallbackCard('bouba');
    const shapes = (d: typeof kiki) => d.prop!.parts.slice(1).map((p) => p.shape);
    expect(shapes(kiki).every((s) => s === 'cone' || s === 'pyramid')).toBe(true);
    expect(shapes(bouba).every((s) => s === 'sphere')).toBe(true);
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
      return { warm: r > b, light: (Math.max(r, g, b) + Math.min(r, g, b)) / 2 };
    };
    expect(hue(kiki.color).warm).toBe(true);
    expect(hue(bouba.color).warm).toBe(false);
    expect(hue(bouba.color).light).toBeGreaterThan(hue(kiki.color).light - 20);
    expect(kiki.color).not.toBe(bouba.color);
  });
  it('answers for any word at all, every kind of fallback passes the gate', () => {
    for (const word of ['a', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', '火山', '🙂', 'mmm', 'tktktk', 'haunted house']) {
      const def = cleanCard(fallbackCard(word));
      expect(def, word).not.toBeNull();
      expect(def!.prop!.parts.length, word).toBeGreaterThan(1);
      expect(def!.atmosphere, word).toBeDefined();
    }
  });
});

describe('where a word comes from', () => {
  const down: AskServer = async () => {
    throw new Error('no server');
  };
  const model = (card: object): AskServer => async () => ({ card, source: 'model', ms: 1234 });
  it('finds built-in cards by word and alias, without asking', async () => {
    let asked = 0;
    const ask: AskServer = async () => {
      asked++;
      throw new Error('no');
    };
    expect((await resolveWord('water', { ask })).def.id).toBe('water');
    expect((await resolveWord('Mountains', { ask })).def.id).toBe('mountain');
    expect((await resolveWord('people', { ask })).source).toBe('built-in');
    expect(asked).toBe(0);
  });
  it('asks the model, and a word seen before is instant', async () => {
    const first = await resolveWord('lighthouse', { ask: model({ icon: '🗼', color: '#ffffff', reading: 'A lighthouse.', prop: { parts: [{ shape: 'cylinder', at: [0, 0.5, 0], size: [0.2, 1, 0.2], rotate: [0, 0, 0], color: '#ffffff' }], scale: 'large', count: 'one', habitat: 'shore', motion: 'still', glow: false } }) });
    expect(first.source).toBe('model');
    expect(first.def.origin).toBe('llm');
    expect(cardDef('lighthouse')).toBe(first.def);
    const again = await resolveWord('LIGHTHOUSE', { ask: down });
    expect(again.source).toBe('stored');
    removeWord('lighthouse');
    expect(cardDef('lighthouse')).toBeUndefined();
  });
  it('with no server, a near match is a guess', async () => {
    const r = await resolveWord('mountian', { ask: down });
    expect(r.source).toBe('near');
    expect(r.def.id).toBe('mountain');
    expect(r.why).toBe('no server');
    expect(nearMatch('wates')?.id).toBe('water');
    expect(nearMatch('sun')).toBeNull(); // too short to guess at
  });
  it('with no server, anything else is the abstract fallback at once, marked as a guess', async () => {
    const r = await resolveWord('jazz', { ask: down });
    expect(r.source).toBe('fallback');
    expect(r.def.origin).toBe('fallback');
    expect(cardDef('jazz')).toBeDefined();
    // A guess is not an answer: next time the model is asked again, and its card replaces the guess.
    const later = await resolveWord('jazz', { ask: model({ atmosphere: { tint: '#5a3c8c', strength: 0.4, light: -0.4, particles: null } }) });
    expect(later.source).toBe('model');
    expect(cardDef('jazz')!.origin).toBe('llm');
    removeWord('jazz');
  });
  it('a reply that is not a usable card falls back', async () => {
    const r = await resolveWord('glorp', { ask: model({ nonsense: true }) });
    expect(r.source).toBe('fallback');
    removeWord('glorp');
  });
  it('removing a made card leaves the built-in cards alone', () => {
    const before = CARD_DEFS.filter((d) => BUILT_IN_IDS.has(d.id)).length;
    register(cleanCard(fallbackCard('pebble'))!);
    expect(findCard('pebble')).not.toBeNull();
    removeWord('pebble');
    removeWord('water'); // not removable
    expect(CARD_DEFS.filter((d) => BUILT_IN_IDS.has(d.id)).length).toBe(before);
    expect(cardDef('water')).toBeDefined();
  });
});
