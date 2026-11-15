// One small test per bug found by the review of the merged branch (14 Nov 2026), so none comes back.
import { describe, expect, it } from 'vitest';
import { cardDef } from './cards/defs';
import { CardStore } from './cards/store';
import { cleanCard, register, removeWord, resolveWord, type AskServer } from './cards/words';
import { parseCode } from './harness/codes';
import { liveCards } from './harness/metrics';
import { placeProps } from './sim/props';
import { WorldSim } from './sim/world';

describe('the live world ends exactly where the settled one is', () => {
  it('for lava as well as water (lava used to stop 0.7% short for good)', () => {
    for (const code of ['lava', 'volcano', 'lava+mountain', 'ravine+rain']) {
      const placements = parseCode(code);
      const settled = new WorldSim().settleNow(liveCards(placements));
      const store = new CardStore();
      const sim = new WorldSim();
      sim.step(store.cards, store.moving, 1 / 30); // the empty world first, as in the app
      for (const p of placements) store.addSim(p.id, p.x, p.y);
      for (let i = 0; i < 30 * 40; i++) {
        store.update(1 / 30);
        sim.step(store.cards, store.moving, 1 / 30);
      }
      for (const field of ['lava', 'lavaHeat', 'lavaSurface', 'waterSurface', 'river'] as const) {
        let worst = 0;
        for (let i = 0; i < settled[field].length; i++) worst = Math.max(worst, Math.abs(sim.frame[field][i] - settled[field][i]));
        expect(worst, `${code}: ${field}`).toBeLessThan(2e-4);
      }
    }
  });
  it('counts when the rules were worked out, apart from water easing', () => {
    const sim = new WorldSim();
    const cards = liveCards(parseCode('rain'));
    sim.settleNow(cards);
    const { rules, version } = sim.frame;
    sim.step(cards, true, 1 / 60); // a card moved: worked out again
    expect(sim.frame.rules).toBe(rules + 1);
    for (let i = 0; i < 30; i++) sim.step(cards, false, 1 / 60); // half a second of water easing only
    expect(sim.frame.rules).toBe(rules + 1);
    expect(sim.frame.version).toBeGreaterThan(version + 20);
  });
});

describe('cards made from words', () => {
  it('drop an effect whose field is a name every object has, instead of failing', () => {
    const hostile = JSON.parse('{"word":"zz","effects":[{"field":"constructor","amount":0.3},{"field":"toString","amount":1},{"field":"__proto__","amount":1},{"field":"people","amount":0.5}]}');
    const def = cleanCard(hostile);
    // Only the last is a field, by its old name: a card made before PEOPLE became SETTLEMENT.
    expect(def?.effects).toEqual([{ field: 'settlement', amount: 0.5, radius: 0.18 }]);
  });
  it('a made card with a one-letter id does not take over the shorthand for built-in cards', () => {
    register(cleanCard({ word: 'M', icon: 'm', color: '#888888', effects: [{ field: 'height', amount: 0.2, radius: 0.1 }] })!);
    try {
      expect(cardDef('m')).toBeDefined();
      expect(parseCode('m+rai').map((c) => c.id)).toEqual(['mountain', 'rain']);
    } finally {
      removeWord('m');
    }
  });
  it('a guess never replaces a card the model already made', async () => {
    const model: AskServer = async () => ({ card: { icon: '🗼', color: '#ffffff', reading: 'A tower.', effects: [{ field: 'height', amount: 0.2, radius: 0.1 }] }, source: 'model', ms: 5 });
    const down: AskServer = async () => {
      throw new Error('offline');
    };
    try {
      expect((await resolveWord('signal tower', { ask: model })).def.origin).toBe('llm');
      // A second ask for the same word fails (Try again with the model gone, or a slow twin request).
      const again = await resolveWord('signal tower', { fresh: true, ask: down });
      expect(again.def.origin).toBe('llm');
      expect(cardDef('signal-tower')?.origin).toBe('llm');
    } finally {
      removeWord('signal-tower');
    }
  });
});

describe('the card store', () => {
  it('gives every card its own key when a tracked card is read as another word and back', () => {
    const store = new CardStore();
    for (const word of ['rain', 'ice', 'rain', 'ice']) {
      store.setTracked([{ id: 2, card: word, x: 0.5, y: 0.5, visible: true }]);
      for (let i = 0; i < 12; i++) store.update(1 / 60); // long enough to start fading in, not to fade out
    }
    const keys = store.cards.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('refuses a position that is not a number', () => {
    const store = new CardStore();
    expect(store.addSim('rain', Number.NaN, 0.5)).toBeNull();
    const key = store.addSim('rain', 0.5, 0.5)!;
    store.moveSim(key, Number.POSITIVE_INFINITY, Number.NaN);
    store.update(1 / 60);
    expect(store.cards[0].tx).toBe(0.5);
    expect(Number.isFinite(store.cards[0].x) && Number.isFinite(store.cards[0].y)).toBe(true);
  });
});

describe('placing the objects of word cards', () => {
  const reeds = cleanCard({
    word: 'reeds', icon: 'r', color: '#557755', effects: [],
    prop: { parts: [{ shape: 'cylinder', at: [0, 0.5, 0], size: [0.1, 1, 0.1], rotate: [0, 0, 0], color: '#557755' }], scale: 'small', count: 'many', habitat: 'shore', motion: 'sway', glow: false },
  })!;
  it('is quick for shore objects, even with no water anywhere near (it took 160 ms for five cards)', () => {
    register(reeds);
    try {
      const cards = liveCards(parseCode('reeds*5+mountain+sun'));
      const frame = new WorldSim().settleNow(cards);
      placeProps(frame, cards); // once to warm up
      const started = performance.now();
      const placed = placeProps(frame, cards);
      expect(performance.now() - started).toBeLessThan(60);
      expect(placed.length).toBeGreaterThan(0);
      expect(placeProps(frame, cards)).toEqual(placed); // and the same every time
    } finally {
      removeWord('reeds');
    }
  });
  it('stands an object on a steep slope without burying it', () => {
    const tower = cleanCard({
      word: 'tall tower', icon: 't', color: '#999999', effects: [],
      prop: { parts: [{ shape: 'box', at: [0, 0.5, 0], size: [0.3, 1, 0.3], rotate: [0, 0, 0], color: '#999999' }], scale: 'landmark', count: 'one', habitat: 'land', motion: 'still', glow: false },
    })!;
    register(tower);
    try {
      const cards = liveCards(parseCode('tall-tower@0.56,0.5+mountain@0.5,0.5'));
      const frame = new WorldSim().settleNow(cards);
      const [object] = placeProps(frame, cards);
      const { w, h, height } = frame;
      const middle = height[Math.round(object.y * (h - 1)) * w + Math.round(object.x * (w - 1))];
      // It may stand a little into the hillside, never most of its own height (0.14 x 10 / 4.2 = 0.33).
      expect(middle - object.ground).toBeLessThan(0.14 * 0.6 + 0.02);
    } finally {
      removeWord('tall-tower');
    }
  });
});
