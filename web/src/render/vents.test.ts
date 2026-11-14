import { describe, expect, it } from 'vitest';
import { findVents } from './vents';

const W = 40;
const H = 30;
function frame(fill: (x: number, y: number) => number) {
  const make = () => new Float32Array(W * H);
  const f = { w: W, h: H, height: make(), lava: make(), lavaHeat: make(), lavaSurface: make() };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cover = fill(x, y);
    f.lava[y * W + x] = cover;
    f.lavaHeat[y * W + x] = cover > 0 ? 1 : 0;
    f.lavaSurface[y * W + x] = cover > 0 ? 0.01 : 0;
  }
  return f;
}

describe('where smoke rises', () => {
  it('finds nothing without lava', () => {
    expect(findVents(frame(() => 0))).toEqual([]);
  });
  it('makes a strong vent over a pool and only a wisp over a thin stream', () => {
    const pool = findVents(frame((x, y) => ((x - 20) ** 2 + (y - 15) ** 2 < 49 ? 1 : 0)));
    const stream = findVents(frame((x) => (x >= 19 && x <= 21 ? 1 : 0)));
    expect(Math.max(...pool.map((v) => v.strength))).toBeGreaterThan(0.6);
    expect(Math.max(...stream.map((v) => v.strength))).toBeLessThan(0.35);
  });
  it('never returns more vents than there are slots', () => {
    expect(findVents(frame(() => 1), 5).length).toBeLessThanOrEqual(5);
  });
});
