import { describe, expect, it } from 'vitest';
import { cardDef, type CardDef } from '../cards/defs';
import { settledCard, type LiveCard } from '../cards/store';
import { cleanCard } from '../cards/words';
import { placeProps } from './props';
import { WorldSim, sampleField, type WorldFrame } from './world';

const part = { shape: 'box', at: [0, 0.2, 0], size: [0.6, 0.4, 0.3], rotate: [0, 0, 0], color: '#7a4e2e' };
const make = (word: string, habitat: string, count = 'one', scale = 'medium'): CardDef =>
  cleanCard({ word, origin: 'llm', prop: { parts: [part], scale, count, habitat, motion: 'still', glow: false } })!;

const boat = make('test boat', 'water', 'few');
const hut = make('test hut', 'land', 'many', 'small');
const reed = make('test reed', 'shore', 'many', 'small');
const kite = make('test kite', 'air', 'few');

function world(cards: LiveCard[]): WorldFrame {
  return new WorldSim().settleNow(cards);
}
const at = (def: CardDef, x: number, y: number, key = 'k') => settledCard(`${key}:${x},${y}`, def, x, y);
const water = (x = 0.3, y = 0.3) => [0, 1, 2].map((k) => at(cardDef('water')!, x + k * 0.05, y, `w${k}`));
const depth = (f: WorldFrame, x: number, y: number) => sampleField(f.waterSurface, f.w, f.h, x, y) - sampleField(f.height, f.w, f.h, x, y);

describe('where objects stand', () => {
  it('a boat by water floats on it', () => {
    const cards = [...water(), at(boat, 0.45, 0.42)];
    const frame = world(cards);
    const placed = placeProps(frame, cards);
    expect(placed.length).toBeGreaterThan(0);
    for (const o of placed) {
      expect(o.afloat).toBe(true);
      expect(depth(frame, o.x, o.y)).toBeGreaterThan(0.002);
      expect(o.ground).toBeCloseTo(frame.seaLevel, 2);
    }
  });
  it('a boat with no water sits on land at the card', () => {
    const cards = [at(boat, 0.5, 0.5)];
    const frame = world(cards);
    const placed = placeProps(frame, cards);
    expect(placed.length).toBeGreaterThan(0);
    for (const o of placed) {
      expect(o.afloat).toBe(false);
      expect(Math.hypot(o.x - 0.5, o.y - 0.5)).toBeLessThan(0.2);
      expect(depth(frame, o.x, o.y)).toBeLessThan(0.001);
    }
  });
  it('land objects are never under water', () => {
    const cards = [...water(), at(hut, 0.32, 0.3)];
    const frame = world(cards);
    const placed = placeProps(frame, cards);
    expect(placed.length).toBeGreaterThan(0);
    for (const o of placed) expect(depth(frame, o.x, o.y)).toBeLessThan(0.0008);
  });
  it('shore objects hug the waterline', () => {
    const cards = [...water(), at(reed, 0.45, 0.42)];
    const frame = world(cards);
    const placed = placeProps(frame, cards);
    expect(placed.length).toBeGreaterThan(0);
    for (const o of placed) {
      expect(depth(frame, o.x, o.y)).toBeLessThan(0.0008);
      // Open water within a few cells.
      let near = false;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) near ||= depth(frame, o.x + dx / (frame.w - 1), o.y + dy / (frame.h - 1)) > 0.003;
      expect(near).toBe(true);
    }
  });
  it('air objects float above the ground', () => {
    const cards = [at(kite, 0.5, 0.5)];
    for (const o of placeProps(world(cards), cards)) expect(o.hover).toBeGreaterThan(0.02);
  });
  it('nothing stands outside the play area', () => {
    for (const [x, y] of [[0, 0], [1, 1], [0.01, 0.5], [0.99, 0.02]]) {
      const cards = [at(hut, x, y)];
      const frame = world(cards);
      for (const o of placeProps(frame, cards)) {
        expect(o.x).toBeGreaterThan(0.005);
        expect(o.x).toBeLessThan(0.995);
        expect(o.y).toBeGreaterThan(0.005);
        expect(o.y).toBeLessThan(0.995);
      }
    }
  });
  it('the same cards give the same places, whatever the key or the order', () => {
    const a = [at(hut, 0.4, 0.4, 'one'), at(boat, 0.6, 0.6, 'two'), ...water()];
    const b = [...water(), at(boat, 0.6, 0.6, 'other'), at(hut, 0.4, 0.4, 'keys')];
    const frame = world(a);
    const strip = (list: ReturnType<typeof placeProps>) => list.map(({ def, ...rest }) => ({ id: def.id, ...rest }));
    expect(strip(placeProps(frame, b))).toEqual(strip(placeProps(frame, a)));
  });
  it('objects grow in with the card', () => {
    const card = { ...at(hut, 0.5, 0.5), strength: 0.4 };
    expect(placeProps(world([card]), [card]).every((o) => o.grow === 0.4)).toBe(true);
    const gone = { ...card, strength: 0 };
    expect(placeProps(world([gone]), [gone])).toEqual([]);
  });
});
