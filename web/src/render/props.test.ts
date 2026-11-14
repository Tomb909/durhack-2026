import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { PropPart } from '../cards/defs';
import { cleanCard } from '../cards/words';
import { buildPropGeometry, partMatrices } from './props';

const part = (extra: Partial<PropPart>): PropPart => ({ shape: 'cylinder', at: [0.2, 0.1, 0.3], size: [0.1, 0.2, 0.1], rotate: [0, 0, 20], color: '#808080', ...extra });
const centres = (p: PropPart) => partMatrices(p).map((m) => new THREE.Vector3().setFromMatrixPosition(m).toArray().map((v) => Math.round(v * 1000) / 1000));

describe('the object of a word card', () => {
  it('a mirrored part stands on both sides, and four ways for xz', () => {
    expect(centres(part({ mirror: 'x' }))).toEqual([[0.2, 0.1, 0.3], [-0.2, 0.1, 0.3]]);
    expect(centres(part({ mirror: 'xz' }))).toEqual([[0.2, 0.1, 0.3], [-0.2, 0.1, 0.3], [0.2, 0.1, -0.3], [-0.2, 0.1, -0.3]]);
    // Mirrored, not turned inside out, and leaning the other way.
    const [a, b] = partMatrices(part({ mirror: 'x' }));
    expect(b.determinant()).toBeGreaterThan(0);
    const up = (m: THREE.Matrix4) => new THREE.Vector3(0, 1, 0).transformDirection(m);
    expect(up(b).x).toBeCloseTo(-up(a).x, 6);
    expect(up(b).y).toBeCloseTo(up(a).y, 6);
  });
  it('a repeated part goes evenly round the upright axis', () => {
    const round = centres(part({ at: [0.3, 0.5, 0], repeat: 4 }));
    expect(round).toHaveLength(4);
    for (const [x, y, z] of round) expect([Math.round(Math.hypot(x, z) * 1000), y]).toEqual([300, 0.5]);
    expect(new Set(round.map((c) => c.join())).size).toBe(4);
  });
  it('fills the unit cube, stands on the ground and is shaded, whatever the recipe', () => {
    for (const shape of ['box', 'cylinder', 'cone', 'pyramid', 'prism', 'sphere', 'capsule', 'dome', 'ring'] as const) {
      const def = cleanCard({ word: `one ${shape}`, origin: 'llm', prop: { parts: [
        { shape, at: [0.1, 0.3, 0], size: [0.1, 0.3, 0.2], rotate: [0, 0, 0], color: '#808080', taper: 0.5 },
        { shape: 'box', at: [0.1, 0.1, 0], size: [0.3, 0.1, 0.3], rotate: [0, 30, 0], color: '#404040', mirror: 'x' },
      ] } })!;
      const g = buildPropGeometry(def)!;
      const box = g.boundingBox!;
      expect(box.min.y, shape).toBeCloseTo(0, 5);
      expect(Math.max(box.max.x - box.min.x, box.max.y, box.max.z - box.min.z), shape).toBeCloseTo(1, 5);
      expect(box.min.x + box.max.x, shape).toBeCloseTo(0, 5);
      const pos = g.getAttribute('position');
      const shade = g.getAttribute('aShade');
      expect(shade.count).toBe(pos.count);
      let lo = 1, hi = 0;
      for (let i = 0; i < pos.count; i++) {
        expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
        lo = Math.min(lo, shade.getX(i));
        hi = Math.max(hi, shade.getX(i));
      }
      expect(lo, shape).toBeGreaterThan(0.25);
      expect(hi, shape).toBeLessThanOrEqual(1);
      expect(hi - lo, shape).toBeGreaterThan(0.2); // darker at the foot and in the crease than at the top
    }
  });
});
