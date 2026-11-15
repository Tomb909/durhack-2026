import { describe, expect, it } from 'vitest';
import { cardDef } from '../cards/defs';
import type { LiveCard } from '../cards/store';
import { WorldSim } from '../sim/world';
import { listen } from './listen';

let n = 0;
function card(id: string, x: number, y: number): LiveCard {
  const def = cardDef(id)!;
  return { key: `a${n++}`, def, source: 'sim', x, y, angle: 0, targetAngle: 0, tx: x, ty: y, vx: 0, vy: 0, strength: 1, fade: 1, present: true, visible: true, age: 9 };
}
/** Open water: a wide lake under rain. (Open water of any kind is heard as `sea`.) */
const sea = (x: number) => [card('lake', x, 0.5), card('big', x + 0.12, 0.5), card('rain', x, 0.5)];
const hear = (cards: LiveCard[], focus = { x: 0.5, y: 0.5, zoom: 1 }) => listen(new WorldSim().settleNow(cards), focus);

describe('listening to the world', () => {
  it('an empty world is a quiet breeze and nothing else', () => {
    const s = hear([]);
    expect(s.wind).toBeGreaterThan(0.05);
    expect(s.wind).toBeLessThan(0.5);
    for (const k of ['sea', 'river', 'rain', 'snow', 'birds', 'insects'] as const) expect(s[k]).toBeLessThan(0.05);
  });

  it('a lake brings lapping water, a mountain brings wind', () => {
    expect(hear(sea(0.5)).sea).toBeGreaterThan(0.2);
    expect(hear([card('mountain', 0.5, 0.5)]).wind).toBeGreaterThan(hear([]).wind + 0.2);
  });

  it('forest brings birds; warmth brings insects too', () => {
    const green = hear([card('rain', 0.3, 0.5), card('forest', 0.6, 0.5)]);
    expect(green.birds).toBeGreaterThan(0.1);
    const warm = hear([card('rain', 0.3, 0.5), card('forest', 0.6, 0.5), card('sun', 0.6, 0.5)]);
    expect(warm.insects).toBeGreaterThan(green.insects);
  });

  it('cold turns rain into snow', () => {
    const wet = [card('rain', 0.3, 0.5), card('rain', 0.7, 0.5)];
    const cold = hear([...wet, card('ice', 0.5, 0.5)]);
    expect(cold.snow).toBeGreaterThan(cold.rain);
  });

  it('zooming in on the far side of a lake leaves the sea behind', () => {
    const cards = [...sea(0.2), card('mountain', 0.85, 0.5)];
    const wide = hear(cards);
    const close = hear(cards, { x: 0.88, y: 0.5, zoom: 4 });
    expect(close.sea).toBeLessThan(wide.sea);
  });
});

describe('listening to a settlement', () => {
  const village = [...sea(0.3), card('forest', 0.6, 0.5), card('civilization', 0.5, 0.5)];
  it('is silent without one, and heard with one', () => {
    const none = hear([...sea(0.3), card('forest', 0.6, 0.5)]);
    expect(none.village + none.farm + none.fishing + none.logging).toBe(0);
    const s = hear(village);
    expect(s.village).toBeGreaterThan(0.3);
    expect(s.farm + s.fishing + s.logging).toBeGreaterThan(0.2);
  });
  it('fades away when you look somewhere else', () => {
    const near = hear(village, { x: 0.5, y: 0.5, zoom: 3 });
    const far = hear(village, { x: 0.95, y: 0.1, zoom: 3 });
    expect(far.village).toBeLessThan(near.village * 0.5);
  });
});
