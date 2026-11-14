import { describe, expect, it } from 'vitest';
import { CardStore } from './store';

describe('cards glide to where they are put', () => {
  it('arrives and comes to rest at any frame rate, however slow', () => {
    for (const fps of [120, 60, 24, 12, 10]) {
      const store = new CardStore();
      const key = store.addSim('water', 0.2, 0.2)!;
      store.update(1 / fps);
      store.moveSim(key, 0.8, 0.7);
      let furthest = 0;
      for (let i = 0; i < fps * 4; i++) {
        store.update(1 / fps);
        furthest = Math.max(furthest, store.cards[0].x, store.cards[0].y);
      }
      expect(furthest, `${fps} fps: never past the target`).toBeLessThanOrEqual(0.8 + 1e-9);
      expect(store.cards[0].x, `${fps} fps`).toBeCloseTo(0.8, 3);
      expect(store.cards[0].y, `${fps} fps`).toBeCloseTo(0.7, 3);
      expect(store.moving, `${fps} fps: at rest`).toBe(false);
    }
  });
  it('ignores a tracked card whose position is not a number', () => {
    const store = new CardStore();
    store.setTracked([
      { id: 1, card: 'water', x: Number.NaN, y: 0.5, visible: true },
      { id: 2, card: 'life', x: 0.5, y: 0.5, visible: true },
    ]);
    expect(store.cards.map((c) => c.def.id)).toEqual(['life']);
  });
});
