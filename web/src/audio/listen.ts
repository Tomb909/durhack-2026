// What the world sounds like from where the camera is looking: a pure reading of
// the frame, so it can be tested without any audio. Every value is 0..1.
import { RULES, type WorldFrame } from '../sim/world';

export interface Soundscape {
  /** Open sea in earshot (not frozen). */
  sea: number;
  /** Running rivers. */
  river: number;
  /** Wind: always a breath of it, stronger up high and in the cold. */
  wind: number;
  /** Rain falling (above freezing). */
  rain: number;
  /** Snow falling: a muffled hush. */
  snow: number;
  /** Woods and meadows: birdsong. */
  birds: number;
  /** Warm, green land: insects. */
  insects: number;
  /** Houses: voices, a hearth, a hammer now and then. */
  village: number;
  /** Fields: sheep, a hoe in the soil. */
  farm: number;
  /** Fishing boats: oars and gulls. */
  fishing: number;
  /** Woodcutters: axes, and now and then a falling tree. */
  logging: number;
}

export const SILENT: Soundscape = { sea: 0, river: 0, wind: 0, rain: 0, snow: 0, birds: 0, insects: 0, village: 0, farm: 0, fishing: 0, logging: 0 };

/** Where the camera is looking, in 0..1 of the world (x across, y from the far edge), and how close. */
export interface Focus {
  x: number;
  y: number;
  zoom: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export const LISTEN = {
  /** How far you hear, in 0..1 of the long side, when the whole world fits. Zooming in shrinks it. */
  reach: 0.7,
  nearest: 0.12,
  /** Water deeper than this counts as sea or lake (thinner is a wet riverbed). */
  openWater: 0.001,
  /** Rivers above this are drawn as rivers, not sea. */
  riverLine: 0.25,
  /** Height above the sea where the wind is at its strongest. */
  windHeight: 0.15,
  windCalm: 0.12,
  /** People are a small part of the land, so a little of them is already easy to hear. */
  lifeGain: 6,
};

export function listen(frame: WorldFrame, focus: Focus): Soundscape {
  const { w, h } = frame;
  const reach = Math.max(LISTEN.nearest, LISTEN.reach / Math.max(0.5, focus.zoom));
  // Grid cells are square, so the long side (w) is 1 and the short side is h/w.
  const fx = focus.x;
  const fy = focus.y * (h / w);
  const step = Math.max(1, Math.round(w / 48));
  let total = 0, sea = 0, frozen = 0, river = 0, alt = 0, rain = 0, snow = 0, birds = 0, insects = 0, land = 0, homes = 0, farms = 0, fishing = 0, logging = 0;
  for (let j = 0; j < h; j += step) {
    for (let i = 0; i < w; i += step) {
      const k = j * w + i;
      if (frame.mask[k] <= 0) continue;
      const dx = (i + 0.5) / w - fx;
      const dy = (j + 0.5) / w - fy;
      const weight = Math.exp(-(dx * dx + dy * dy) / (reach * reach));
      if (weight < 0.02) continue;
      total += weight;
      const t = frame.temperature[k];
      const cold = t <= RULES.freezing;
      const depth = frame.waterSurface[k] - frame.height[k];
      const r = frame.river[k];
      if (depth > LISTEN.openWater && r < LISTEN.riverLine) {
        if (cold) frozen += weight;
        else sea += weight;
      } else {
        land += weight;
        river += weight * (cold ? 0.2 : 1) * r;
        const green = frame.vegetation[k] * (1 - frame.cleared[k]);
        birds += weight * green * smoothstep(-0.45, -0.1, t);
        insects += weight * green * smoothstep(0.05, 0.45, t);
      }
      homes += weight * frame.homes[k];
      farms += weight * frame.farms[k];
      fishing += weight * frame.fishing[k];
      logging += weight * frame.logging[k];
      alt += weight * Math.max(0, frame.height[k] - frame.seaLevel);
      const p = frame.precipitation[k];
      if (cold) snow += weight * p;
      else rain += weight * p;
    }
  }
  if (total <= 0) return { ...SILENT };
  const onLand = land > 0 ? 1 / land : 0;
  const people = (amount: number) => clamp01(Math.sqrt((amount / total) * LISTEN.lifeGain));
  const height = alt / total;
  const coldness = clamp01((frozen + snow) / total);
  return {
    // Hearing the sea does not need much of it in view.
    sea: clamp01(Math.sqrt(sea / total) * 1.15),
    river: clamp01((river * onLand) * 3),
    wind: clamp01(LISTEN.windCalm + (1 - LISTEN.windCalm) * smoothstep(0.02, LISTEN.windHeight, height) + 0.25 * coldness),
    rain: clamp01((rain / total) * 1.6),
    snow: clamp01((snow / total) * 1.6),
    birds: clamp01(birds * onLand * 1.6),
    insects: clamp01(insects * onLand * 1.6),
    village: people(homes),
    farm: people(farms),
    fishing: people(fishing),
    logging: people(logging),
  };
}
