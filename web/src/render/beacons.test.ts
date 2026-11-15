import { describe, expect, it } from 'vitest';
import { cardDef } from '../cards/defs';
import { settledCard } from '../cards/store';
import { groupCopies } from './beacons';

const card = (id: string, x: number, y = 0.5) => settledCard(`${id}@${x}`, cardDef(id)!, x, y);
const none = new Set<never>();

describe('labels shared by copies of a card', () => {
  it('gives close copies one label and distant ones their own', () => {
    const groups = groupCopies([card('rain', 0.3), card('rain', 0.35), card('rain', 0.8), card('forest', 0.32)], none, 1.4);
    expect(groups.map((g) => g.map((c) => c.key))).toEqual([['rain@0.3', 'rain@0.35'], ['rain@0.8'], ['forest@0.32']]);
  });
  it('joins two groups when a copy lands between them, and carries on with the cards after it', () => {
    // Two rains too far apart to share a label, a third between them, then anything else:
    // this order used to stop the whole picture.
    const cards = [card('rain', 0.3), card('rain', 0.5), card('rain', 0.4), card('forest', 0.7), card('rain', 0.9)];
    const groups = groupCopies(cards, none, 1.4);
    expect(groups.map((g) => g.map((c) => c.key).sort())).toEqual([['rain@0.3', 'rain@0.4', 'rain@0.5'], ['forest@0.7'], ['rain@0.9']]);
  });
  it('leaves out the cards it is told to skip', () => {
    const big = card('big', 0.31);
    expect(groupCopies([card('mountain', 0.3), big], new Set([big]), 1.4).length).toBe(1);
  });
});
