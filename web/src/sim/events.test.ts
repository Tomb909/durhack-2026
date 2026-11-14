import { describe, expect, it } from 'vitest';
import { cardDef } from '../cards/defs';
import type { LiveCard } from '../cards/store';
import { WorldSim, type WorldFrame } from './world';

let n = 0;
function card(id: string, x: number, y: number, strength = 1): LiveCard {
  const def = cardDef(id)!;
  return { key: `e${n++}`, def, source: 'sim', x, y, tx: x, ty: y, vx: 0, vy: 0, strength, fade: strength, present: true, visible: true, age: 9 };
}

/** Settle the standing cards, then add the action card and run real time. */
function run(standing: LiveCard[], event: LiveCard, seconds: number, sim = new WorldSim()): WorldFrame {
  sim.settleNow(standing);
  const cards = [...standing, event];
  for (let i = 0; i < seconds * 30; i++) sim.step(cards, false, 1 / 30);
  return sim.frame;
}

const at = (f: WorldFrame, a: Float32Array, x: number, y: number) =>
  a[Math.round(y * (f.h - 1)) * f.w + Math.round(x * (f.w - 1))];
const total = (a: Float32Array, t = 0.3) => a.filter((v) => v > t).length / a.length;

describe('nuke', () => {
  it('wrecks and burns the village around it and leaves a crater', () => {
    const village = [card('people', 0.4, 0.5)];
    const before = new WorldSim().settleNow(village);
    const h0 = at(before, before.height, 0.4, 0.5);
    const f = run(village, card('nuke', 0.4, 0.5), 3);
    expect(at(f, f.damage, 0.4, 0.5)).toBeGreaterThan(0.9);
    expect(at(f, f.scorch, 0.4, 0.5)).toBeGreaterThan(0.9);
    expect(at(f, f.damage, 0.9, 0.15)).toBe(0);
    expect(at(f, f.height, 0.4, 0.5)).toBeLessThan(h0 - 0.02);
  });

  it('brings a nuclear winter that passes', () => {
    const sim = new WorldSim();
    const f = run([], card('nuke', 0.5, 0.5), 10, sim);
    expect(f.winter).toBeGreaterThan(0.9);
    const later = run([], card('nuke', 0.5, 0.5), 0, sim); // same sim, no new time
    for (let i = 0; i < 50 * 30; i++) sim.step([], false, 1 / 30);
    expect(sim.frame.winter).toBe(0);
    expect(later.events.length).toBe(0);
  });

  it('happens once, however long the card stays', () => {
    const sim = new WorldSim();
    const nuke = card('nuke', 0.5, 0.5);
    run([], nuke, 50, sim);
    expect(sim.frame.events.length).toBe(0);
    for (let i = 0; i < 30; i++) sim.step([nuke], false, 1 / 30);
    expect(sim.frame.events.length).toBe(0);
  });
});

describe('tsunami', () => {
  const coast = [card('water', 0.3, 0.6), card('water', 0.5, 0.6), card('water', 0.62, 0.7), card('people', 0.4, 0.45)];
  it('floods low land near the sea and wrecks what it reaches', () => {
    const f = run(coast, card('tsunami', 0.5, 0.6), 4);
    expect(total(f.damage, 0.5)).toBeGreaterThan(0.01);
  });
  it('is stopped by mountains', () => {
    const walled = [...coast, card('mountain', 0.4, 0.45), card('mountain', 0.44, 0.45)];
    const f = run(walled, card('tsunami', 0.5, 0.6), 6);
    expect(at(f, f.damage, 0.4, 0.4)).toBeLessThan(0.1);
  });
  it('is gentler from an ice-bound sea', () => {
    const icy = [...coast, card('ice', 0.4, 0.6), card('ice', 0.55, 0.65)];
    const warm = run(coast, card('tsunami', 0.5, 0.6), 5);
    const frozen = run(icy, card('tsunami', 0.5, 0.6), 5);
    expect(total(frozen.damage, 0.5)).toBeLessThan(total(warm.damage, 0.5));
  });
});

describe('tornado', () => {
  it('wanders and tears a track', () => {
    const f = run([card('people', 0.5, 0.5)], card('tornado', 0.5, 0.5), 8);
    const e = f.events.find((x) => x.kind === 'tornado')!;
    expect(Math.hypot(e.x - 0.5, e.y - 0.5)).toBeGreaterThan(0.05);
    expect(total(f.damage, 0.3)).toBeGreaterThan(0.002);
  });
  it('grows with the sun and dies in the cold', () => {
    const hot = run([card('sun', 0.5, 0.5), card('sun', 0.52, 0.5)], card('tornado', 0.5, 0.5), 6);
    const cold = run([card('ice', 0.5, 0.5), card('ice', 0.52, 0.5)], card('tornado', 0.5, 0.5), 6);
    const strength = (f: WorldFrame) => f.events.find((x) => x.kind === 'tornado')?.strength ?? 0;
    expect(strength(hot)).toBeGreaterThan(1.1);
    expect(strength(cold)).toBeLessThan(0.6);
  });
});

describe('the land heals', () => {
  it('rebuilds after an event', () => {
    const sim = new WorldSim();
    run([card('people', 0.4, 0.5)], card('tornado', 0.4, 0.5), 5, sim);
    expect(total(sim.frame.damage, 0.1)).toBeGreaterThan(0);
    for (let i = 0; i < 120 * 10; i++) sim.step([], false, 0.1);
    expect(total(sim.frame.damage, 0.001)).toBe(0);
  });
});
