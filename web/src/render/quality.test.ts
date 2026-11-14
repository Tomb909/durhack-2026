import { describe, expect, it } from 'vitest';
import { QualityGovernor } from './quality';

/**
 * Run for a while on a machine whose frame time is given by `frameTime(scale)`.
 * Returns how many times the scale changed and how long was spent below full sharpness.
 */
function run(governor: QualityGovernor, frameTime: (scale: number) => number, seconds: number): { changes: number; soft: number } {
  let changes = 0;
  let soft = 0;
  for (let t = 0; t < seconds; ) {
    const dt = frameTime(governor.scale);
    if (governor.scale < 1) soft += dt;
    if (governor.frame(dt)) changes++;
    t += dt;
  }
  return { changes, soft };
}

const steady = (fps: number) => () => 1 / fps;
/** A machine held back by drawing: frame time follows the number of pixels, never faster than the screen. */
const gpuBound = (atFull: number, screen = 60) => (scale: number) => Math.max(1 / screen, atFull * scale * scale);

describe('the picture gives up sharpness to stay smooth', () => {
  it('leaves a smooth picture alone', () => {
    const governor = new QualityGovernor();
    expect(run(governor, steady(60), 30).changes).toBe(0);
    expect(run(governor, steady(120), 30).changes).toBe(0);
    expect(governor.scale).toBe(1);
  });
  it('ignores one long frame, and a window that was away', () => {
    const governor = new QualityGovernor();
    run(governor, steady(60), 2);
    expect(governor.frame(0.3)).toBe(false); // a hitch
    expect(run(governor, steady(60), 2).changes).toBe(0);
    expect(governor.frame(45)).toBe(false); // the tab was hidden
    expect(governor.frame(Number.NaN)).toBe(false);
    expect(governor.scale).toBe(1);
  });
  it('draws fewer pixels when drawing is what is slow, until frames are smooth', () => {
    const governor = new QualityGovernor(0.4);
    run(governor, gpuBound(0.06), 20); // 60 ms a frame at full size
    expect(governor.scale).toBeLessThan(0.65);
    expect(governor.scale).toBeGreaterThan(0.4);
    expect(gpuBound(0.06)(governor.scale)).toBeLessThanOrEqual(1 / 45);
    expect(run(governor, gpuBound(0.06), 3).changes).toBe(0); // and holds there
  });
  it('stops at a floor on a machine no size can save', () => {
    const governor = new QualityGovernor(0.4);
    run(governor, gpuBound(0.3), 60);
    expect(governor.scale).toBe(0.4);
    expect(run(governor, gpuBound(0.3), 10).changes).toBe(0);
  });
  it('gives the pixels back when fewer did not make frames faster', () => {
    // A screen or battery saver that caps the page at 30 frames a second: no size is faster.
    const capped = new QualityGovernor();
    const { soft } = run(capped, steady(30), 300);
    expect(capped.scale).toBe(1);
    expect(soft).toBeLessThan(20); // a few short dips to find out, not five minutes of blur
    // The rules being slow while cards are dragged: the same, and sharp again as soon as it ends.
    const busy = new QualityGovernor();
    run(busy, steady(25), 6);
    expect(busy.scale).toBe(1);
    expect(run(busy, steady(60), 10).changes).toBe(0);
    expect(busy.scale).toBe(1);
  });
  it('sharpens again once there is time to spare', () => {
    const governor = new QualityGovernor();
    run(governor, gpuBound(0.06), 10);
    const low = governor.scale;
    expect(low).toBeLessThan(1);
    run(governor, steady(60), 120);
    expect(governor.scale).toBe(1);
  });
  it('tries less and less often when sharpening keeps failing', () => {
    // A machine that is smooth at the lower size and struggles at any sharper one.
    const governor = new QualityGovernor();
    run(governor, gpuBound(0.03), 5);
    const comfortable = governor.scale;
    expect(comfortable).toBeLessThan(1);
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
