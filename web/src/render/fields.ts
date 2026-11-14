// Uploads the world's fields to the GPU as two float textures.
import * as THREE from 'three';
import type { WorldFrame } from '../sim/world';

export class FieldTextures {
  readonly a: THREE.DataTexture;
  readonly b: THREE.DataTexture;
  private dataA: Float32Array;
  private dataB: Float32Array;
  private version = -1;

  constructor(w: number, h: number, floatLinear: boolean) {
    this.dataA = new Float32Array(w * h * 4);
    this.dataB = new Float32Array(w * h * 4);
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
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
  }

  update(frame: WorldFrame): void {
    if (frame.version === this.version) return;
    if (frame.w * frame.h * 4 !== this.dataA.length) return; // a frame from before a shape change
    this.version = frame.version;
    const n = frame.w * frame.h;
    const { dataA, dataB } = this;
    const { height, temperature, wetness, vegetation, waterSurface, river, precipitation, mask } = frame;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      dataA[o] = height[i];
      dataA[o + 1] = temperature[i];
      dataA[o + 2] = wetness[i];
      dataA[o + 3] = vegetation[i];
      dataB[o] = waterSurface[i];
      dataB[o + 1] = river[i];
      dataB[o + 2] = precipitation[i];
      // Inside mask: 0.5 exactly on the outline, so filtering gives a smooth edge.
      dataB[o + 3] = Math.min(1, Math.max(0, 0.5 + mask[i]));
    }
    this.a.needsUpdate = true;
    this.b.needsUpdate = true;
  }
}
