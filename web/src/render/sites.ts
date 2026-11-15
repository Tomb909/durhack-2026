// Things that stand at fixed sites on the map: trees, houses, people, sheep, boats, smoke.
//
// Each one is drawn by the GPU, which reads the world's textures at its site and
// shrinks it to nothing where there is nothing to show. That is free for the CPU
// but not for the GPU: every site costs its full set of vertices and texture
// reads on every frame, shown or not, and at most moments nearly all are empty.
//
// So before drawing, the sites that cannot be showing are left out. The test
// here only has to be safe, not exact: it may keep a site the shader then hides,
// but must never drop one the shader would show. Each test therefore asks for
// the largest value of a field anywhere near the site (never less than the GPU
// can read there) and compares it with the same threshold the shader uses.
import * as THREE from 'three';
import type { WorldFrame } from '../sim/world';

/** Cells per side of a coarse block. */
const BLOCK_SHIFT = 2;

/** The fields a site's test may ask about. */
export type ReachField = 'vegetation' | 'temperature' | 'homes' | 'farms' | 'fishing' | 'logging' | 'precipitation';

interface Coarse {
  highs: Float32Array;
  lows: Float32Array;
  /** Highest and lowest value anywhere. */
  top: number;
  bottom: number;
  version: number;
}

/**
 * A coarse look at a world: the largest (or smallest) value of a field near a point.
 * Built block by block the first time a field is asked about after the world changes.
 */
export class WorldReach {
  private frame: WorldFrame | null = null;
  private version = 0;
  private bw = 0;
  private bh = 0;
  private coarse = new Map<ReachField, Coarse>();

  /** Look at this world from now on. Call when the world's fields have changed. */
  reset(frame: WorldFrame): void {
    const bw = ((frame.w - 1) >> BLOCK_SHIFT) + 1;
    const bh = ((frame.h - 1) >> BLOCK_SHIFT) + 1;
    if (bw !== this.bw || bh !== this.bh) this.coarse.clear();
    this.frame = frame;
    this.bw = bw;
    this.bh = bh;
    this.version++;
  }

  private of(field: ReachField): Coarse {
    const frame = this.frame!;
    let c = this.coarse.get(field);
    if (!c) {
      c = { highs: new Float32Array(this.bw * this.bh), lows: new Float32Array(this.bw * this.bh), top: 0, bottom: 0, version: -1 };
      this.coarse.set(field, c);
    }
    if (c.version === this.version) return c;
    c.version = this.version;
    const { w, h } = frame;
    const data = frame[field];
    const { highs, lows } = c;
    highs.fill(-Infinity);
    lows.fill(Infinity);
    for (let j = 0; j < h; j++) {
      const row = j * w;
      const blockRow = (j >> BLOCK_SHIFT) * this.bw;
      for (let i = 0; i < w; i++) {
        const v = data[row + i];
        const b = blockRow + (i >> BLOCK_SHIFT);
        if (v > highs[b]) highs[b] = v;
        if (v < lows[b]) lows[b] = v;
      }
    }
    let top = -Infinity;
    let bottom = Infinity;
    for (let b = 0; b < highs.length; b++) {
      if (highs[b] > top) top = highs[b];
      if (lows[b] < bottom) bottom = lows[b];
    }
    c.top = top;
    c.bottom = bottom;
    return c;
  }

  /** The largest value of the field anywhere in the world. */
  top(field: ReachField): number {
    return this.of(field).top;
  }

  /** The smallest value of the field anywhere in the world. */
  bottom(field: ReachField): number {
    return this.of(field).bottom;
  }

  /**
   * The largest value of the field at table position (x, y) or within `reach` of it
   * (a fraction of the world's longer side: how far the thing at this site may wander).
   * May be the value from a little further away, never less than the true one.
   */
  most(field: ReachField, x: number, y: number, reach = 0): number {
    const c = this.of(field);
    if (c.top === c.bottom) return c.top; // the same everywhere: usually "none at all"
    return this.scan(c.highs, x, y, reach, true);
  }

  /** As `most`, for the smallest value. */
  least(field: ReachField, x: number, y: number, reach = 0): number {
    const c = this.of(field);
    if (c.top === c.bottom) return c.bottom;
    return this.scan(c.lows, x, y, reach, false);
  }

  private scan(blocks: Float32Array, x: number, y: number, reach: number, highest: boolean): number {
    const { w, h } = this.frame!;
    // One cell either side for the GPU's blending between cells, plus the wander.
    const r = 1 + Math.ceil(reach * (Math.max(w, h) - 1));
    const ix = Math.round(Math.min(1, Math.max(0, x)) * (w - 1));
    const iy = Math.round(Math.min(1, Math.max(0, y)) * (h - 1));
    const x0 = Math.max(0, ix - r) >> BLOCK_SHIFT;
    const x1 = Math.min(w - 1, ix + r) >> BLOCK_SHIFT;
    const y0 = Math.max(0, iy - r) >> BLOCK_SHIFT;
    const y1 = Math.min(h - 1, iy + r) >> BLOCK_SHIFT;
    let best = highest ? -Infinity : Infinity;
    for (let j = y0; j <= y1; j++) {
      const row = j * this.bw;
      for (let i = x0; i <= x1; i++) {
        const v = blocks[row + i];
        if (highest ? v > best : v < best) best = v;
      }
    }
    return best;
  }
}

/**
 * Could the thing at this site be showing? `rand` holds the site's four random
 * numbers starting at `at` (the shader's aRand). Must never say no when the shader would draw it.
 */
export type SiteTest = (world: WorldReach, x: number, y: number, rand: Float32Array, at: number) => boolean;

/** Thresholds are compared with this much to spare, so rounding on the GPU can never disagree. */
export const SPARE = 1e-4;

/** Something drawn from the world's textures that can be told to leave out what is not showing. */
export interface Culled {
  /** Draw only what can be showing in this world. `everything` turns the saving off (to check it changes nothing). */
  cull(world: WorldReach, everything: boolean): void;
}

/** One kind of thing at many sites: a mesh drawn once per site, minus the sites left out. */
export class Sites implements Culled {
  private allSites: Float32Array;
  private allRand: Float32Array;
  private sites: THREE.InstancedBufferAttribute;
  private rand: THREE.InstancedBufferAttribute;
  private geometry: THREE.InstancedBufferGeometry;
  /** Which sites were drawn last time, so an unchanged list is not sent to the GPU again. */
  private drawn: Int32Array;
  private drawnCount = -1;

  /**
   * @param mesh  its geometry must carry `aSite` (2 numbers) and `aRand` (4 numbers) per site
   * @param test  see SiteTest
   */
  constructor(readonly mesh: THREE.Mesh, private test: SiteTest) {
    this.geometry = mesh.geometry as THREE.InstancedBufferGeometry;
    this.sites = this.geometry.getAttribute('aSite') as THREE.InstancedBufferAttribute;
    this.rand = this.geometry.getAttribute('aRand') as THREE.InstancedBufferAttribute;
    this.allSites = Float32Array.from(this.sites.array);
    this.allRand = Float32Array.from(this.rand.array);
    this.sites.setUsage(THREE.DynamicDrawUsage);
    this.rand.setUsage(THREE.DynamicDrawUsage);
    this.drawn = new Int32Array(this.sites.count);
  }

  /** How many sites there are, and how many are being drawn. */
  get counts(): { all: number; drawn: number } {
    return { all: this.sites.count, drawn: Math.max(0, this.drawnCount) };
  }

  cull(world: WorldReach, everything: boolean): void {
    const { allSites, allRand, drawn, test } = this;
    const sites = this.sites.array as Float32Array;
    const rand = this.rand.array as Float32Array;
    const total = this.sites.count;
    let count = 0;
    let changed = false;
    for (let k = 0; k < total; k++) {
      if (!everything && !test(world, allSites[k * 2], allSites[k * 2 + 1], allRand, k * 4)) continue;
      if (drawn[count] !== k || count >= this.drawnCount) {
        changed = true;
        drawn[count] = k;
        sites[count * 2] = allSites[k * 2];
        sites[count * 2 + 1] = allSites[k * 2 + 1];
        rand[count * 4] = allRand[k * 4];
        rand[count * 4 + 1] = allRand[k * 4 + 1];
        rand[count * 4 + 2] = allRand[k * 4 + 2];
        rand[count * 4 + 3] = allRand[k * 4 + 3];
      }
      count++;
    }
    if (changed) {
      this.sites.clearUpdateRanges();
      this.sites.addUpdateRange(0, count * 2);
      this.sites.needsUpdate = true;
      this.rand.clearUpdateRanges();
      this.rand.addUpdateRange(0, count * 4);
      this.rand.needsUpdate = true;
    }
    this.drawnCount = count;
    this.geometry.instanceCount = count;
    this.mesh.visible = count > 0;
  }
}

/** Several culled things as one. */
export function together(object: THREE.Object3D, parts: Culled[]): THREE.Object3D & Culled {
  return Object.assign(object, {
    cull(world: WorldReach, everything: boolean) {
      for (const part of parts) part.cull(world, everything);
    },
  });
}
