import { describe, expect, it } from 'vitest';
import { parseCode } from '../harness/codes';
import { liveCards } from '../harness/metrics';
import { WorldSim } from '../sim/world';
import { worldMood } from './mood';

const mood = (code: string) => worldMood(new WorldSim().settleNow(liveCards(parseCode(code))));

describe('the mood the sky follows', () => {
  it('is calm over an empty world', () => {
    expect(mood('empty')).toEqual({ hot: 0, cold: 0, wet: 0, life: 0 });
  });
  it('reads each condition from the cards that cause it', () => {
    expect(mood('sun*2').hot).toBeGreaterThan(0.6);
    expect(mood('sun*2').cold).toBe(0);
    expect(mood('ice*2').cold).toBeGreaterThan(0.6);
    expect(mood('rain*3').wet).toBeGreaterThan(0.6);
    expect(mood('forest+rain').life).toBeGreaterThan(0.4);
    // Forest alone is only grass and scrub: a hint of green, far short of a forest's.
    expect(mood('forest').life).toBeGreaterThan(0);
    expect(mood('forest').life).toBeLessThan(mood('forest+rain').life / 2);
  });
  it('stays between 0 and 1', () => {
    for (const value of Object.values(mood('mountain*3+rain*3+sun*3+ice*3+forest*3'))) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
