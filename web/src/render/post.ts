// Light that the materials cannot work out on their own:
//
// - SunShadows: every frame, everything that stands on the land (trees, houses,
//   people, boats, carts) is drawn from the sun into a depth map, and the clouds
//   into a cover map. Every surface then looks both up (see sunlight() in
//   common.ts) to find whether something stands between it and the sun.
// - AmbientPass: ambient occlusion from the depth buffer. Creases, the feet of
//   trees and walls, the gaps between houses take less of the sky's light, which
//   is what makes things sit on the ground instead of floating over it.
// - GradeShader: the film look. Teal shade and warm light, a little more colour,
//   a vignette, faint colour fringes at the very edge and a whisper of grain.
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { CLOUD_MAP_SIZE, SHADOW_SIZE, SUN_DIR, world, type SharedUniforms } from './common';

const SHADOW_CASTER = 1;
const CLOUD_CASTER = 2;

/** Mark everything opaque under `root` as casting a shadow. */
export function castsShadow(root: THREE.Object3D): void {
  root.userData.castsShadow = true;
}

/** Mark the clouds: they shade the land softly instead of casting a hard shadow. */
export function castsCloudShade(mesh: THREE.Object3D): void {
  mesh.userData.cloud = true;
}

function underShadowCaster(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.castsShadow) return true;
  return false;
}

export class SunShadows {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 40);
  private depth: THREE.WebGLRenderTarget;
  private clouds: THREE.WebGLRenderTarget;
  private depthMaterials = new WeakMap<THREE.Material, THREE.ShaderMaterial>();
  private coverMaterials = new WeakMap<THREE.Material, THREE.ShaderMaterial>();
  private swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
  private clearColour = new THREE.Color();

  constructor(private renderer: THREE.WebGLRenderer, private shared: SharedUniforms) {
    this.depth = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE);
    const depthTexture = new THREE.DepthTexture(SHADOW_SIZE, SHADOW_SIZE);
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    this.depth.depthTexture = depthTexture;
    this.clouds = new THREE.WebGLRenderTarget(CLOUD_MAP_SIZE, CLOUD_MAP_SIZE, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    shared.uShadowMap.value = depthTexture;
    shared.uCloudMap.value = this.clouds.texture;
    this.fit();
  }

  /** Point the sun's view at the whole world (call when its size changes). */
  fit(): void {
    const half = Math.hypot(world.w, world.d) / 2 + 1;
    const distance = 20;
    const cam = this.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = distance - 10;
    cam.far = distance + 10;
    cam.position.copy(SUN_DIR).multiplyScalar(distance);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.shared.uSunMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  }

  render(scene: THREE.Scene): void {
    const r = this.renderer;
    const before = r.getRenderTarget();
    r.getClearColor(this.clearColour);
    const alpha = r.getClearAlpha();

    // Everything that stands on the land: depth only.
    this.mark(scene, (mesh, material) => {
      if (!underShadowCaster(mesh) || material.transparent) return null;
      mesh.layers.enable(SHADOW_CASTER);
      return this.variant(this.depthMaterials, material, (m) => {
        m.colorWrite = false;
      }, 'void main() { gl_FragColor = vec4(1.0); }');
    });
    this.camera.layers.set(SHADOW_CASTER);
    r.setRenderTarget(this.depth);
    r.setClearColor(0xffffff, 1);
    r.clear(true, true, false);
    r.render(scene, this.camera);
    this.restore();

    // The clouds: how much of them the sunlight passes through, added up.
    this.mark(scene, (mesh, material) => {
      if (!mesh.userData.cloud) return null;
      mesh.layers.enable(CLOUD_CASTER);
      return this.variant(this.coverMaterials, material, (m) => {
        m.transparent = true;
        m.blending = THREE.AdditiveBlending;
        m.depthTest = false;
        m.depthWrite = false;
      }, 'void main() { gl_FragColor = vec4(0.32); }');
    });
    this.camera.layers.set(CLOUD_CASTER);
    r.setRenderTarget(this.clouds);
    r.setClearColor(0x000000, 1);
    r.clear(true, false, false);
    r.render(scene, this.camera);
    this.restore();

    r.setRenderTarget(before);
    r.setClearColor(this.clearColour, alpha);
  }

  /** Swap each mesh's material for the one `choose` gives (null: leave it out of this pass). */
  private mark(scene: THREE.Scene, choose: (mesh: THREE.Mesh, material: THREE.ShaderMaterial) => THREE.Material | null): void {
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.visible || !(o.material instanceof THREE.ShaderMaterial)) return;
      const replacement = choose(o, o.material);
      if (!replacement) return;
      this.swapped.push([o, o.material]);
      o.material = replacement;
    });
  }

  private restore(): void {
    for (const [mesh, material] of this.swapped) mesh.material = material;
    this.swapped.length = 0;
  }

  /** The same shape as `material` (same vertex shader and uniforms) with a plain fragment. */
  private variant(cache: WeakMap<THREE.Material, THREE.ShaderMaterial>, material: THREE.ShaderMaterial, setup: (m: THREE.ShaderMaterial) => void, fragment: string): THREE.ShaderMaterial {
    let m = cache.get(material);
    if (!m) {
      m = new THREE.ShaderMaterial({
        uniforms: material.uniforms,
        defines: material.defines,
        vertexShader: material.vertexShader,
        fragmentShader: fragment,
        side: THREE.DoubleSide,
      });
      setup(m);
      cache.set(material, m);
    }
    return m;
  }

  dispose(): void {
    this.depth.dispose();
    this.clouds.dispose();
  }
}

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const AO_FRAGMENT = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform float uProjY;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;

// Depth is read unfiltered, so always read it at a texel's centre: a read on the
// corner between texels lands on either of them, and the surface it describes
// flips from row to row (that drew lines across flat ground).
vec2 snap(vec2 uv) { return (floor(uv / uTexel) + 0.5) * uTexel; }

vec3 viewAt(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}

void main() {
  vec2 base = snap(vUv);
  float d = texture2D(tDepth, base).r;
  if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }
  vec3 p = viewAt(base);
  // The surface's facing, over two texels each way (steadier than one), from
  // whichever neighbour is on the same surface.
  vec2 ex = vec2(uTexel.x * 2.0, 0.0), ey = vec2(0.0, uTexel.y * 2.0);
  vec3 pr = viewAt(base + ex), pl = viewAt(base - ex);
  vec3 pu = viewAt(base + ey), pd = viewAt(base - ey);
  vec3 dx = abs(pr.z - p.z) < abs(p.z - pl.z) ? pr - p : p - pl;
  vec3 dy = abs(pu.z - p.z) < abs(p.z - pd.z) ? pu - p : p - pd;
  vec3 n = normalize(cross(dx, dy));

  // Look around in a disc of uRadius (scene units) for anything rising above this surface.
  float reach = uRadius * uProjY / -p.z * 0.5;
  float aspect = uTexel.x / uTexel.y;
  float spin = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2832;
  float occlusion = 0.0;
  for (int i = 0; i < 14; i++) {
    float f = (float(i) + 0.5) / 14.0;
    float a = float(i) * 2.39996 + spin;
    vec2 o = vec2(cos(a) * aspect, sin(a)) * reach * sqrt(f);
    vec3 v = viewAt(snap(base + o)) - p;
    float l = max(length(v), 1e-4);
    float rise = dot(v, n);
    // Only real rises count: steeper than a gentle slope, and higher than the depth
    // buffer's own jitter at this distance. Flat or gently rolling ground stays clean.
    float steep = max(0.0, rise / l - 0.2);
    float real = smoothstep(0.004 * -p.z + 0.01, 0.008 * -p.z + 0.03, rise);
    occlusion += steep * real * (1.0 - smoothstep(uRadius * 0.6, uRadius * 1.6, l));
  }
  float ao = clamp(1.0 - occlusion / 14.0 * 2.6, 0.0, 1.0);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform mat4 uProjInv;
uniform vec2 uAOTexel;
uniform float uStrength;
varying vec2 vUv;

float viewZ(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return v.z / v.w;
}

void main() {
  vec4 col = texture2D(tColor, vUv);
  // Smooth the occlusion, but only across the same surface (never bleed over an edge).
  float z = viewZ(vUv);
  float total = 0.0, weight = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 uv = vUv + vec2(float(i), float(j)) * uAOTexel;
      float w = 1.0 / (0.02 + abs(viewZ(uv) - z) * 8.0);
      total += texture2D(tAO, uv).r * w;
      weight += w;
    }
  }
  float ao = total / weight;
  col.rgb *= mix(1.0, ao, uStrength);
  gl_FragColor = col;
}
`;

/** Ambient occlusion from the scene's depth (needs the render target to carry a depth texture). */
export class AmbientPass extends Pass {
  private ao = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
  private aoQuad: FullScreenQuad;
  private quad: FullScreenQuad;
  private aoMaterial: THREE.ShaderMaterial;
  private material: THREE.ShaderMaterial;

  constructor(private camera: THREE.PerspectiveCamera) {
    super();
    this.aoMaterial = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uProjY: { value: 1 }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 0.4 } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: AO_FRAGMENT,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, tDepth: { value: null }, tAO: { value: this.ao.texture }, uProjInv: { value: new THREE.Matrix4() }, uAOTexel: { value: new THREE.Vector2() }, uStrength: { value: 0.85 } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
    });
    this.aoQuad = new FullScreenQuad(this.aoMaterial);
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number): void {
    // Worked out at half size: it is soft anyway, and that keeps it cheap.
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.ao.setSize(w, h);
    this.aoMaterial.uniforms.uTexel.value.set(1 / width, 1 / height);
    this.material.uniforms.uAOTexel.value.set(1 / w, 1 / h);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const projInv = this.camera.projectionMatrixInverse;
    this.aoMaterial.uniforms.tDepth.value = readBuffer.depthTexture;
    this.aoMaterial.uniforms.uProjInv.value.copy(projInv);
    this.aoMaterial.uniforms.uProjY.value = this.camera.projectionMatrix.elements[5];
    renderer.setRenderTarget(this.ao);
    this.aoQuad.render(renderer);

    const u = this.material.uniforms;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.uProjInv.value.copy(projInv);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.ao.dispose();
    this.aoMaterial.dispose();
    this.material.dispose();
    this.aoQuad.dispose();
    this.quad.dispose();
  }
}

/** The film look, applied to the lit picture before tone mapping. */
export const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uResolution: { value: new THREE.Vector2(1, 1) }, uSun: { value: new THREE.Vector2(-0.3, 1.2) } },
  vertexShader: QUAD_VERTEX,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uTime;
uniform vec2 uResolution;
/** Where the sun is, in screen coordinates (usually off the picture). */
uniform vec2 uSun;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 c = vUv - 0.5;
  float r2 = dot(c, c);
  // Faint colour fringes, only toward the edges of the picture.
  vec2 fringe = c * r2 * 0.010;
  vec3 col = vec3(texture2D(tDiffuse, vUv + fringe).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - fringe).b);
  // Warm light washing in from the sun's side of the picture.
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  float toSun = length((vUv - uSun) * aspect);
  col += vec3(1.0, 0.62, 0.30) * 0.085 * exp(-toSun * 1.25);
  col *= 1.0 + vec3(0.10, 0.05, -0.02) * exp(-toSun * 1.6);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  // Teal in the shade, warm in the light.
  col *= mix(vec3(0.90, 1.0, 1.10), vec3(1.07, 1.0, 0.91), smoothstep(0.03, 0.9, lum));
  // A little richer colour, a little more contrast.
  col = max(mix(vec3(lum), col, 1.14), 0.0);
  col = pow(col / 0.2, vec3(1.07)) * 0.2;
  // Vignette.
  col *= mix(1.0, 0.5, smoothstep(0.12, 0.62, r2 * 1.7));
  // A whisper of grain.
  col += (hash(vUv * uResolution + fract(uTime) * 61.0) - 0.5) * 0.010;
  gl_FragColor = vec4(col, 1.0);
}
`,
};
