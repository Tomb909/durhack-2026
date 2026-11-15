import { describe, expect, it } from 'vitest';
import { cardDef } from '../cards/defs';
import { settledCard } from '../cards/store';
import { WorldSim } from '../sim/world';
import { makeSharedUniforms } from './common';
import { Merchants, tradeRoutes } from './people';

const person = (key: string, x: number, y: number, strength = 1) => ({
  ...settledCard(key, cardDef('village')!, x, y),
  strength,
});

describe('merchant routes', () => {
  it('connects two active settlements, but not a single settlement', () => {
    expect(tradeRoutes([person('one', 0.2, 0.4)])).toHaveLength(0);
    expect(tradeRoutes([person('one', 0.2, 0.4), person('two', 0.8, 0.6)])).toHaveLength(1);
  });

  it('connects additional settlements without duplicating routes', () => {
    const settlements = [person('one', 0.2, 0.4), person('two', 0.8, 0.6), person('three', 0.5, 0.8)];
    const routes = tradeRoutes(settlements);
    expect(routes).toHaveLength(2);
    expect(new Set(routes.map((route) => route.key)).size).toBe(2);
    expect(new Set(routes.flatMap((route) => [route.from.key, route.to.key]))).toEqual(new Set(settlements.map((card) => card.key)));
  });

  it('ignores settlements that have almost faded away', () => {
    expect(tradeRoutes([person('one', 0.2, 0.4), person('two', 0.8, 0.6, 0.1)])).toHaveLength(0);
  });

  it('moves a cart over time and removes it when a settlement is gone', () => {
    const settlements = [person('one', 0.2, 0.4), person('two', 0.8, 0.6)];
    const frame = new WorldSim().settleNow(settlements);
    const merchants = new Merchants(makeSharedUniforms());
    merchants.update(settlements, frame, 0);
    const convoy = merchants.group.children[0];
    const start = convoy.position.clone();

    merchants.update(settlements, frame, 1);
    expect(convoy.position.distanceTo(start)).toBeGreaterThan(0.1);
    merchants.update([settlements[0]], frame, 2);
    expect(merchants.group.children).toHaveLength(0);
  });
});
