// The world's conditions as four numbers, so the sky can follow them:
// how hot, how cold, how wet, and how alive the world is (each 0..1).
// No graphics in here: a world frame in, a mood out.
import { RULES, type WorldFrame } from '../sim/world';

export interface Mood {
  hot: number;
  cold: number;
  wet: number;
  life: number;
}

export const CALM: Mood = { hot: 0, cold: 0, wet: 0, life: 0 };

const sat = (v: number) => Math.min(1, Math.max(0, v));

/** Read the mood off a world. A quarter of the map in one state is already a strong mood. */
export function worldMood(frame: WorldFrame): Mood {
  const n = frame.w * frame.h;
  const { temperature, precipitation, vegetation, height, mask, seaLevel } = frame;
  let inside = 0, hot = 0, cold = 0, rain = 0, sea = 0, green = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i] < 0) continue; // outside the play area
    inside++;
    if (temperature[i] > 0.35) hot++;
    else if (temperature[i] < RULES.freezing) cold++;
    if (precipitation[i] > 0.05) rain++;
    if (height[i] < seaLevel) sea++;
    green += Math.min(1, vegetation[i]);
  }
  if (!inside) return { ...CALM };
  return {
    hot: sat((hot / inside) * 2.4),
    cold: sat((cold / inside) * 2.4),
    wet: sat((rain / inside) * 1.7 + (sea / inside) * 0.6),
    life: sat((green / inside) * 3.2),
  };
}
