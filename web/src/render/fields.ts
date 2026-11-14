// Uploads the world's fields to the GPU as float textures.
import * as THREE from 'three';
import type { WorldFrame } from '../sim/world';
import { MAX_VENTS, findVents } from './vents';

export class FieldTextures {
  readonly a: THREE.DataTexture;
  readonly b: THREE.DataTexture;
  readonly c: THREE.DataTexture;
  readonly d: THREE.DataTexture;
  /** Drawing only, worked out here from the lava: how burnt the ground around it is, how lit by it, and how close to it. */
  readonly e: THREE.DataTexture;
  /** Wind (x, z) and wind-blown snow. */
  readonly f: THREE.DataTexture;
  /** Where smoke rises, as table u, v and strength (found from the lava; see vents.ts). */
  readonly vents: THREE.Vector4[] = Array.from({ length: MAX_VENTS }, () => new THREE.Vector4());
  ventCount = 0;
  private dataA: Float32Array;
  private dataB: Float32Array;
  private dataC: Float32Array;
  private dataD: Float32Array;
  private dataE: Float32Array;
  private dataF: Float32Array;
  private blurA: Float32Array;
  private blurB: Float32Array;
  private hadLava = true;
  private version = -1;
  /** The highest ground in the frame last uploaded (sim height units). */
  peak = 1e9;
  /** True when the frame last uploaded has enough lava anywhere for the lava surface to show. */
  lavaShows = false;
  /** True until the first upload: everything is worked out then, whatever the arrays hold. */
  private fresh = true;

  constructor(w: number, h: number, floatLinear: boolean) {
    this.dataA = new Float32Array(w * h * 4);
    this.dataB = new Float32Array(w * h * 4);
    this.dataC = new Float32Array(w * h * 4);
    this.dataD = new Float32Array(w * h * 4);
    this.dataE = new Float32Array(w * h * 4);
    this.dataF = new Float32Array(w * h * 4);
    this.blurA = new Float32Array(w * h);
    this.blurB = new Float32Array(w * h);
    const make = (data: Float32Array) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
      // Without float filtering support we fall back to blocky sampling (rare on desktop GPUs).
      t.minFilter = t.magFilter = floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      return t;
    };
    this.a = make(this.dataA);
    this.b = make(this.dataB);
    this.c = make(this.dataC);
    this.d = make(this.dataD);
    this.e = make(this.dataE);
    this.f = make(this.dataF);
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
    this.c.dispose();
    this.d.dispose();
    this.e.dispose();
    this.f.dispose();
  }

  update(frame: WorldFrame): void {
    if (frame.version === this.version) return;
    if (frame.w * frame.h * 4 !== this.dataA.length) return; // a frame from before a shape change
    this.version = frame.version;
    const n = frame.w * frame.h;
    const { dataA, dataB, dataC, dataD, dataF } = this;
    const { homes, farms, fishing, cleared, logging, lava, lavaHeat, lavaSurface } = frame;
    const { height, temperature, wetness, vegetation, waterSurface, river, precipitation, mask } = frame;
    let peak = -Infinity;
    let mostLava = 0;
    // Has the lava moved since the last upload (the arrays below still hold that upload)?
    // The halo and the vents are worked out from the lava alone: while it stands still
    // (water settling, woodcutters at work) there is no need to work them out again.
    let lavaMoved = this.fresh;
    let ventsMoved = this.fresh;
    this.fresh = false;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      if (height[i] > peak) peak = height[i];
      if (lava[i] > mostLava) mostLava = lava[i];
      if (dataD[o + 3] !== lava[i] || dataC[o + 3] !== lavaHeat[i]) lavaMoved = true;
      if (dataD[o + 2] !== lavaSurface[i] || dataA[o] !== height[i]) ventsMoved = true;
      dataA[o] = height[i];
      dataA[o + 1] = temperature[i];
      dataA[o + 2] = wetness[i];
      dataA[o + 3] = vegetation[i];
      dataB[o] = waterSurface[i];
      dataB[o + 1] = river[i];
      dataB[o + 2] = precipitation[i];
      // Inside mask: 0.5 exactly on the outline, so filtering gives a smooth edge.
      dataC[o] = homes[i];
      dataC[o + 1] = farms[i];
      dataC[o + 2] = fishing[i];
      dataC[o + 3] = lavaHeat[i];
      dataD[o] = cleared[i];
      dataD[o + 1] = logging[i] * (1 - cleared[i]);
      dataD[o + 2] = lavaSurface[i];
      dataD[o + 3] = lava[i];
      dataF[o] = frame.windX[i];
      dataF[o + 1] = frame.windY[i];
      dataF[o + 2] = frame.snowBlow[i];
      dataB[o + 3] = Math.min(1, Math.max(0, 0.5 + mask[i]));
    }
    this.peak = peak;
    // The lava surface discards everything where less than this much lava lies (see lava.ts).
    this.lavaShows = mostLava > 0.049;
    this.a.needsUpdate = true;
    this.b.needsUpdate = true;
    this.c.needsUpdate = true;
    this.d.needsUpdate = true;
    this.f.needsUpdate = true;
    if (lavaMoved) this.updateLavaHalo(frame);
    if (lavaMoved || ventsMoved) {
      const found = findVents(frame);
      this.ventCount = found.length;
      found.forEach((v, k) => this.vents[k].set(v.u, v.v, v.strength, 0));
    }
  }

  /** Spread the lava out into a soft halo: ash on the ground around it, and the glow it throws. */
  private updateLavaHalo(frame: WorldFrame): void {
    const { w, h, lava, lavaHeat } = frame;
    const n = w * h;
    const { dataE, blurA, blurB } = this;
    let any = false;
    for (let i = 0; i < n; i++) {
      if (lava[i] > 0.01) {
        any = true;
        break;
      }
    }
    if (!any && !this.hadLava) return; // already blank
    this.hadLava = any;
    // r: ash, lava spread wide. g: glow, molten lava spread a little. b: molten lava spread a medium way
    // (scoria, and the rim). a: any lava (set or not) spread the same way (the dark basalt around it).
    const radii = [14, 3, 6, 6];
    for (let pass = 0; pass < 4; pass++) {
      const radius = radii[pass];
      for (let i = 0; i < n; i++) {
        blurA[i] = !any ? 0 : pass === 0 || pass === 3 ? lava[i] : lava[i] * lavaHeat[i];
      }
      if (any) {
        for (let twice = 0; twice < 2; twice++) {
          boxBlur(blurA, blurB, w, h, radius, true);
          boxBlur(blurB, blurA, w, h, radius, false);
        }
      }
      for (let i = 0, o = pass; i < n; i++, o += 4) dataE[o] = blurA[i];
    }
    this.e.needsUpdate = true;
  }
}

/** Average over 2 * radius + 1 cells along rows (or columns), edges repeated. */
function boxBlur(from: Float32Array, to: Float32Array, w: number, h: number, radius: number, alongRows: boolean): void {
  const lines = alongRows ? h : w;
  const length = alongRows ? w : h;
  const step = alongRows ? 1 : w;
  const span = 2 * radius + 1;
  for (let line = 0; line < lines; line++) {
    const start = alongRows ? line * w : line;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += from[start + Math.min(length - 1, Math.max(0, k)) * step];
    for (let k = 0; k < length; k++) {
      to[start + k * step] = sum / span;
      sum += from[start + Math.min(length - 1, k + radius + 1) * step] - from[start + Math.max(0, k - radius) * step];
    }
  }
}
