import { describe, expect, it } from 'vitest';
import { QualityGovernor } from './quality';

/** Run for a while at a steady frame rate; returns how many times the scale changed. */
function run(governor: QualityGovernor, fps: number, seconds: number): number {
  let changes = 0;
  for (let i = 0; i < fps * seconds; i++) if (governor.frame(1 / fps)) changes++;
  return changes;
}

describe('the picture gives up sharpness to stay smooth', () => {
  it('leaves a smooth picture alone', () => {
    const governor = new QualityGovernor();
    expect(run(governor, 60, 30)).toBe(0);
    expect(run(governor, 120, 30)).toBe(0);
    expect(governor.scale).toBe(1);
  });
  it('ignores one long frame, and a window that was away', () => {
    const governor = new QualityGovernor();
    run(governor, 60, 2);
    expect(governor.frame(0.3)).toBe(false); // a hitch
    expect(run(governor, 60, 2)).toBe(0);
    expect(governor.frame(45)).toBe(false); // the tab was hidden
    expect(governor.frame(Number.NaN)).toBe(false);
    expect(governor.scale).toBe(1);
  });
  it('draws fewer pixels while frames stay slow, down to a floor and no further', () => {
    const governor = new QualityGovernor(0.4);
    expect(run(governor, 20, 3)).toBeGreaterThan(0);
    expect(governor.scale).toBeLessThan(1);
    run(governor, 20, 60);
    expect(governor.scale).toBe(0.4);
    expect(run(governor, 20, 10)).toBe(0);
  });
  it('sharpens again once there is time to spare', () => {
    const governor = new QualityGovernor();
    run(governor, 20, 4);
    const low = governor.scale;
    run(governor, 60, 120);
    expect(governor.scale).toBeGreaterThan(low);
    expect(governor.scale).toBe(1);
  });
  it('tries less and less often when sharpening keeps failing', () => {
    // A machine that is smooth at the lower size and struggles at any sharper one.
    const governor = new QualityGovernor();
    run(governor, 20, 2);
    const comfortable = governor.scale;
    let tries = 0;
    let early = 0;
    for (let i = 0; i < 60 * 240; i++) {
      const slowNow = governor.scale > comfortable + 1e-9;
      const before = governor.scale;
      if (governor.frame(slowNow ? 1 / 20 : 1 / 60) && governor.scale > before) {
        tries++;
        if (i < 60 * 60) early++;
      }
    }
    expect(tries).toBeGreaterThan(0);
    expect(tries - early, 'fewer tries in the last three minutes than the first').toBeLessThan(early * 3);
    expect(tries).toBeLessThan(12); // not every four seconds (that would be 60)
  });
});
