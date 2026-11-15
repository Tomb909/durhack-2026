import { describe, expect, it } from 'vitest';
import { parseCode } from '../harness/codes';
import { liveCards } from '../harness/metrics';
import { WorldSim, sampleField, SHAPE_PRESETS } from '../sim/world';
import { WorldReach, type ReachField } from './sites';

/** A fixed stream of numbers in 0..1, so a failure can be run again. */
function numbers(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

describe('the coarse look at the world used to leave out empty sites', () => {
  const fields: ReachField[] = ['vegetation', 'temperature', 'homes', 'farms', 'fishing', 'logging', 'precipitation'];

  it('never reports less than the GPU could read at a site or within its wander (nor more, for the smallest)', () => {
    for (const shape of [SHAPE_PRESETS.rect, SHAPE_PRESETS.circle]) {
      const frame = new WorldSim(shape).settleNow(liveCards(parseCode('mountain+rain*2+sun+ice+forest+village*2')));
      const reach = new WorldReach();
      reach.reset(frame);
      const next = numbers(7);
      for (let k = 0; k < 4000; k++) {
        const x = next();
        const y = next();
        const field = fields[k % fields.length];
        const wander = k % 3 === 0 ? 0 : 0.018;
        // What the shader can read: the blended value at the site, or anywhere it may wander to.
        const dx = (next() * 2 - 1) * wander;
        const dy = (next() * 2 - 1) * wander * frame.aspect; // sheep and people wander by widths of the world
        const read = sampleField(frame[field], frame.w, frame.h, Math.min(1, Math.max(0, x + dx)), Math.min(1, Math.max(0, y + dy)));
        expect(reach.most(field, x, y, wander), `most ${field} at ${x},${y}`).toBeGreaterThanOrEqual(read - 1e-6);
        expect(reach.least(field, x, y, wander), `least ${field} at ${x},${y}`).toBeLessThanOrEqual(read + 1e-6);
      }
    }
  });

  it('knows a field that is the same everywhere, and follows the world when it changes', () => {
    const sim = new WorldSim();
    const reach = new WorldReach();
    reach.reset(sim.settleNow([]));
    expect(reach.top('homes')).toBe(0);
    expect(reach.most('vegetation', 0.5, 0.5)).toBe(0);
    reach.reset(sim.settleNow(liveCards(parseCode('forest+rain'))));
    expect(reach.top('vegetation')).toBeGreaterThan(0.5);
    expect(reach.bottom('vegetation')).toBe(0);
    expect(reach.most('vegetation', 0.02, 0.02)).toBeLessThan(reach.top('vegetation')); // local, not just the world's best
  });
});
