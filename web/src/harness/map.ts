// A flat, top-down picture of a world, one pixel per grid cell. No 3D, no GPU:
// it shows exactly what the rules decided, with nothing hidden behind clouds.
import { cardDef } from '../cards/defs';
import { RULES, underSea, type WorldFrame } from '../sim/world';
import type { Placement } from './codes';

type RGB = [number, number, number];
const lerp = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const ramp = (a: number, b: number, x: number) => Math.min(1, Math.max(0, (x - a) / (b - a)));

const SEA_SHALLOW: RGB = [96, 176, 214];
const SEA_DEEP: RGB = [24, 78, 150];
const SEA_ICE: RGB = [200, 226, 240];
const FRESH: RGB = [70, 150, 235];
const GROUND: RGB = [150, 132, 102];
const SAND: RGB = [226, 180, 96];
const ROCK: RGB = [120, 118, 122];
const SNOW: RGB = [244, 248, 252];
const FOREST: RGB = [34, 128, 58];
const RAIN: RGB = [40, 60, 120];
const FARM: RGB = [206, 190, 92];
const HOME: RGB = [222, 96, 48];
const BOAT: RGB = [250, 240, 214];
const LAVA: RGB = [255, 104, 20];
const BASALT: RGB = [44, 38, 42];

export const MAP_LEGEND: [label: string, colour: RGB][] = [
  ['sea', SEA_DEEP], ['river/lake', FRESH], ['forest', FOREST], ['desert', SAND], ['snow/ice', SNOW], ['rock', ROCK], ['farmland', FARM], ['villages', HOME], ['lava', LAVA], ['cooled lava', BASALT], ['rain (dots)', RAIN],
];

/** Draw the world into a canvas the size of the grid (scale it up when copying). */
export function drawMap(frame: WorldFrame, canvas: HTMLCanvasElement | OffscreenCanvas): void {
  const { w, h, height, temperature, wetness, vegetation, waterSurface, river, precipitation, homes, farms, fishing, lava, lavaHeat, seaLevel } = frame;
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  const image = g.createImageData(w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const ground = height[k];
      const t = temperature[k];
      const cold = ramp(RULES.freezing + 0.08, RULES.freezing - 0.08, t);
      let c: RGB;
      if (underSea(frame, k)) {
        c = lerp(lerp(SEA_SHALLOW, SEA_DEEP, ramp(0, 0.06, seaLevel - ground)), SEA_ICE, cold);
      } else {
        c = lerp(GROUND, SAND, ramp(0.2, 0.05, wetness[k]) * ramp(0.1, 0.5, t));
        c = lerp(c, ROCK, ramp(0.12, 0.3, ground));
        c = lerp(c, FOREST, Math.min(1, vegetation[k]) * 0.9);
        c = lerp(c, FARM, Math.min(1, farms[k]) * 0.85);
        c = lerp(c, SNOW, cold * ramp(0.2, 0.45, wetness[k] + ramp(0.15, 0.4, ground)));
        // Light from the far left, so mountains read as mountains.
        const slope = height[j * w + Math.max(0, i - 1)] - height[j * w + Math.min(w - 1, i + 1)] + height[Math.max(0, j - 1) * w + i] - height[Math.min(h - 1, j + 1) * w + i];
        const shade = 1 - Math.max(-0.35, Math.min(0.35, slope * 9));
        c = [c[0] * shade, c[1] * shade, c[2] * shade];
        const water = Math.max(ramp(0.0005, 0.003, waterSurface[k] - ground), ramp(0.25, 0.7, river[k]));
        c = lerp(c, lerp(FRESH, SEA_ICE, cold), water);
      }
      // Lava: bright where molten, near black where it has set (seen through the water it set under).
      if (lava[k] > 0.02) c = lerp(c, lerp(BASALT, LAVA, lavaHeat[k]), Math.min(1, lava[k] * 1.6) * (underSea(frame, k) ? 0.6 : 1));
      // People: houses as a scatter of roof-coloured cells, fishing boats as pale specks on the water.
      if (homes[k] > 0.25 && (i * 7 + j * 3) % 5 < 2) c = lerp(c, HOME, 0.9);
      if (fishing[k] > 0.3 && (i * 5 + j * 11) % 23 === 0) c = BOAT;
      // Falling rain or snow: a dot pattern, so the ground stays readable underneath.
      if (precipitation[k] > 0.05 && (i + j * 2) % 4 === 0 && j % 2 === 0) c = lerp(c, cold > 0.5 ? SNOW : RAIN, 0.35 + 0.5 * precipitation[k]);
      const o = k * 4;
      image.data[o] = c[0];
      image.data[o + 1] = c[1];
      image.data[o + 2] = c[2];
      image.data[o + 3] = 255;
    }
  }
  g.putImageData(image, 0, 0);
}

/** Mark where the cards are, on a map already drawn at x,y with this size. */
export function drawCardMarks(g: CanvasRenderingContext2D, cards: Placement[], x: number, y: number, width: number, height: number): void {
  const r = Math.max(3, width / 60);
  for (const card of cards) {
    const def = cardDef(card.id);
    g.beginPath();
    g.arc(x + card.x * width, y + card.y * height, r, 0, Math.PI * 2);
    g.fillStyle = def?.color ?? '#ffffff';
    g.fill();
    g.lineWidth = Math.max(1, r / 3);
    g.strokeStyle = '#000000';
    g.stroke();
  }
}
