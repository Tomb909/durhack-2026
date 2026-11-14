// Climate palette: ground colour from temperature and wetness together.
// Edit the two tables to restyle the world. Columns run cold -> hot, rows run
// dry -> wet. Colours between the stops are blended smoothly.
import * as THREE from 'three';

const TEMPERATURE_STOPS = [-1, -0.45, -0.15, 0.3, 1]; // frozen, cold, mild, warm, scorching

/** Bare ground (no plants). */
const BARE: string[][] = [
  // frozen     cold       mild       warm       scorching
  ['#8d8a84', '#827f78', '#857f74', '#dba551', '#f4b84a'], // dry: tundra rock ... desert sand
  ['#b9bcbc', '#7f7c6e', '#7f7a69', '#b98f52', '#e0a24d'], // dryish
  ['#e9eef2', '#7d7a5c', '#7b7048', '#84683f', '#8e6a40'], // wet: snow ... damp earth
  ['#f6f9fc', '#eef3f7', '#665f3f', '#6b5434', '#6f5233'], // soaked: deep snow ... dark mud
];

/** Ground where plants cover it. */
const GREEN: string[][] = [
  ['#8d8a84', '#8a9072', '#a3a862', '#b9b060', '#cdb565'], // dry: sparse, yellowed
  ['#aab3aa', '#6f9468', '#84b254', '#8fb347', '#a7b04a'], // dryish: grassland
  ['#dfe8e6', '#4f8a5e', '#58a548', '#3f9a3c', '#2f8f3a'], // wet: forest floor
  ['#f2f6f8', '#447d5a', '#3f8f41', '#27803a', '#1c7436'], // soaked: jungle
];

function buildTexture(table: string[][], size = 64): THREE.DataTexture {
  const rows = table.length;
  const data = new Uint8Array(size * size * 4);
  const colours = table.map((row) => row.map((hex) => new THREE.Color().setStyle(hex, THREE.SRGBColorSpace)));
  const out = new THREE.Color();
  const a = new THREE.Color();
  const b = new THREE.Color();
  for (let j = 0; j < size; j++) {
    const wet = (j / (size - 1)) * (rows - 1);
    const r0 = Math.min(rows - 2, Math.floor(wet));
    const rt = wet - r0;
    for (let i = 0; i < size; i++) {
      const temperature = (i / (size - 1)) * 2 - 1;
      let c0 = 0;
      while (c0 < TEMPERATURE_STOPS.length - 2 && temperature > TEMPERATURE_STOPS[c0 + 1]) c0++;
      const span = TEMPERATURE_STOPS[c0 + 1] - TEMPERATURE_STOPS[c0];
      let ct = Math.min(1, Math.max(0, (temperature - TEMPERATURE_STOPS[c0]) / span));
      ct = ct * ct * (3 - 2 * ct);
      a.copy(colours[r0][c0]).lerp(colours[r0][c0 + 1], ct);
      b.copy(colours[r0 + 1][c0]).lerp(colours[r0 + 1][c0 + 1], ct);
      out.copy(a).lerp(b, rt);
      // Store as sRGB bytes; the GPU converts back to linear when sampling.
      out.convertLinearToSRGB();
      const o = (j * size + i) * 4;
      data[o] = Math.round(out.r * 255);
      data[o + 1] = Math.round(out.g * 255);
      data[o + 2] = Math.round(out.b * 255);
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

export function makePalettes(): { bare: THREE.DataTexture; green: THREE.DataTexture } {
  return { bare: buildTexture(BARE), green: buildTexture(GREEN) };
}
