// Where smoke should rise: the places lava is pooled or welling up. Read from the world's
// lava arrays alone, so it needs no knowledge of cards. A deep molten pool (a crater lake)
// is a strong vent; thin lava running down a slope is only a weak one (a wisp).
import type { WorldFrame } from '../sim/world';

export const MAX_VENTS = 16;
/** Vents closer than this many grid cells to a stronger one are dropped (their puffs would overlap). Weak ones need more room. */
const SPACING = 7;

export interface Vent {
  /** Table position, 0..1 (the same coordinates the field textures use). */
  u: number;
  v: number;
  /** 0..1: 0.1 is a wisp, 1 is a tall column. */
  strength: number;
  /** Grid cell, for picking vents apart. */
  x: number;
  y: number;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function findVents(frame: Pick<WorldFrame, 'w' | 'h' | 'height' | 'lava' | 'lavaHeat' | 'lavaSurface'>, max = MAX_VENTS): Vent[] {
  const { w, h, height, lava, lavaHeat, lavaSurface } = frame;
  const n = w * h;
  let any = false;
  for (let i = 0; i < n && !any; i++) any = lava[i] > 0.25 && lavaHeat[i] > 0.3;
  if (!any) return [];
  // How much molten lava there is around each cell: a pool is surrounded by it, a stream is not.
  const molten = new Float32Array(n);
  for (let i = 0; i < n; i++) molten[i] = smooth(0.25, 0.6, lava[i]) * lavaHeat[i];
  const around = blur(molten, w, h, 3);
  const candidates: { i: number; s: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (molten[i] < 0.2) continue;
    const depth = Math.max(0, lavaSurface[i] - height[i]);
    // A pool is lava all around, and the deeper the stronger; a stream is narrow however deep it runs.
    const pooled = smooth(0.35, 0.8, around[i]) * (0.5 + 0.5 * smooth(0.001, 0.012, depth));
    const s = molten[i] * (0.12 + 0.88 * pooled);
    if (s > 0.1) candidates.push({ i, s });
  }
  candidates.sort((a, b) => b.s - a.s || a.i - b.i);
  const vents: Vent[] = [];
  for (const c of candidates) {
    if (vents.length >= max) break;
    const x = c.i % w;
    const y = Math.floor(c.i / w);
    // Wisps are spread wider apart than the columns of a pool.
    const space = SPACING + 5 * (1 - smooth(0.15, 0.45, c.s));
    if (vents.some((t) => (t.x - x) ** 2 + (t.y - y) ** 2 < space * space)) continue;
    vents.push({ u: x / (w - 1), v: y / (h - 1), strength: c.s, x, y });
  }
  return vents;
}

/** Box blur of radius r (cells), edges treated as empty. */
function blur(from: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(from.length);
  const out = new Float32Array(from.length);
  const span = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < w) sum += from[y * w + x];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / span;
      if (x + r + 1 < w) sum += from[y * w + x + r + 1];
      if (x - r >= 0) sum -= from[y * w + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < h) sum += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / span;
      if (y + r + 1 < h) sum += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) sum -= tmp[(y - r) * w + x];
    }
  }
  return out;
}
