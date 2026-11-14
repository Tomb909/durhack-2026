// Puts the world on screen. Input: a WorldFrame and the card list. Nothing
// outside render/ knows how the picture is made.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import type { LiveCard } from '../cards/store';
import { DEFAULT_SHAPE, GW, gridHeight, outlineDistance, type WorldFrame, type WorldShape } from '../sim/world';
import { makeBackdrop } from './backdrop';
import { Beacons } from './beacons';
import { CameraRig } from './camera';
import { MAX_PULSES, makeSharedUniforms, setSharedWorld, setWorldAspect, world, type SharedUniforms } from './common';
import { FieldTextures } from './fields';
import { CALM, worldMood, type Mood } from './mood';
import { makePalettes } from './palette';
import { makeSlabSides } from './slab';
import { makeTerrain } from './terrain';
import { makePeople } from './people';
import { makeTrees } from './trees';
import { makeWater } from './water';
import { makeWeather } from './weather';

const FOV = 30;
const SWAY = THREE.MathUtils.degToRad(22); // never a full spin: left stays left
const SWAY_PERIOD = 52;
const TARGET = new THREE.Vector3(0, 0.55, 0.25);

export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly gpuName: string;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private shared: SharedUniforms;
  private fields!: FieldTextures;
  private palettes = makePalettes();
  /** Meshes that depend on the play area's shape; rebuilt by setShape. */
  private shaped: THREE.Object3D[] = [];
  private outline: number[][] = DEFAULT_SHAPE.outline;
  private beacons: Beacons;
  private time = 0;
  private quality = 1.5;
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.25);
  private fixed: { width: number; height: number } | null = null;
  private lookAt = new THREE.Vector3();
  /** The conditions the sky is heading for, and the frame they were read from. */
  private mood: Mood = { ...CALM };
  private moodVersion = -1;
  /** Where the camera is and how it moves (see camera.ts for the controls). */
  readonly rig = new CameraRig();
  showBeacons = true;
  /** The gentle side-to-side drift while nobody is holding the camera. */
  sway = true;
  /** Above 1 moves the camera closer than "the whole world fits". */
  zoom = 1;

  constructor(private canvas: HTMLCanvasElement, labelLayer: HTMLElement) {
    this.beacons = new Beacons(labelLayer);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x05060a, 1);

    const gl = this.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown GPU';

    this.shared = makeSharedUniforms();
    this.scene.add(makeBackdrop(this.shared));
    this.setShape(DEFAULT_SHAPE);
    this.scene.add(makeTrees(this.shared));
    this.scene.add(makePeople(this.shared));
    this.scene.add(makeWeather(this.shared));
    this.scene.add(this.beacons.group);

    const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.22, 0.55, 1.6);
    this.composer.addPass(this.bloom);
    const vignette = new ShaderPass(VignetteShader);
    vignette.uniforms.offset.value = 1.05;
    vignette.uniforms.darkness.value = 1.0;
    this.composer.addPass(vignette);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Rebuild everything that depends on the play area's shape and proportions. */
  setShape(shape: WorldShape): void {
    setWorldAspect(shape.aspect);
    const gw = GW;
    const gh = gridHeight(shape.aspect);
    this.outline = shape.outline;
    for (const object of this.shaped) {
      this.scene.remove(object);
      object.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    if (this.fields) this.fields.dispose();
    this.fields = new FieldTextures(gw, gh, this.renderer.extensions.has('OES_texture_float_linear'));
    this.shared.uFieldA.value = this.fields.a;
    this.shared.uFieldB.value = this.fields.b;
    this.shared.uFieldC.value = this.fields.c;
    this.shared.uFieldD.value = this.fields.d;
    setSharedWorld(this.shared, gw, gh);
    this.shaped = [makeTerrain(this.shared, this.palettes, gw, gh), makeSlabSides(this.shared, shape.outline, gw), makeWater(this.shared, gw, gh)];
    for (const object of this.shaped) this.scene.add(object);
  }

  setQuality(pixelRatio: number): void {
    this.quality = pixelRatio;
    this.resize();
  }

  /** Draw at exactly this many pixels, whatever the window or screen (used by the harness). */
  setFixedSize(width: number, height: number): void {
    this.fixed = { width, height };
    this.resize();
  }

  resize(): void {
    const width = this.fixed?.width ?? (this.canvas.clientWidth || window.innerWidth);
    const height = this.fixed?.height ?? (this.canvas.clientHeight || window.innerHeight);
    const ratio = this.fixed ? 1 : Math.min(window.devicePixelRatio || 1, this.quality);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private placeCamera(): void {
    const half = THREE.MathUtils.degToRad(FOV / 2);
    const halfH = Math.atan(Math.tan(half) * this.camera.aspect);
    const sway = this.sway ? SWAY * Math.sin((this.time * Math.PI * 2) / SWAY_PERIOD) : 0;
    // Real time, not the world's: the camera still answers the hand when the picture is frozen.
    const pose = this.rig.step(sway, performance.now() / 1000);
    // Far enough back that the whole chunk fits, whatever the window shape.
    const distance = Math.max((world.w / 2 + 0.9) / Math.tan(halfH), (world.d / 2 + 1.9) / Math.tan(half)) / (this.zoom * pose.zoom);
    const viewHeight = this.fixed?.height ?? (this.canvas.clientHeight || window.innerHeight);
    this.rig.frameInfo(world.w / 2, world.d / 2, (2 * distance * Math.tan(half)) / viewHeight);
    const flat = Math.cos(pose.elevation) * distance;
    this.lookAt.set(TARGET.x + pose.panX, TARGET.y, TARGET.z + pose.panZ);
    this.camera.position.set(
      this.lookAt.x + Math.sin(pose.azimuth) * flat, this.lookAt.y + Math.sin(pose.elevation) * distance, this.lookAt.z + Math.cos(pose.azimuth) * flat,
    );
    this.camera.lookAt(this.lookAt);
  }

  /** The ground point under a screen position, relative to the looked-at middle of the world (for zooming toward the pointer). */
  groundPoint(clientX: number, clientY: number): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, hit)) return null;
    return { x: hit.x - TARGET.x, z: hit.z - TARGET.z };
  }

  /** Where on the table (0..1, 0..1) a screen point lands, or null if it misses the world. */
  pickTable(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, hit)) return null;
    const x = hit.x / world.w + 0.5;
    const y = hit.z / world.d + 0.5;
    if (x < -0.03 || x > 1.03 || y < -0.03 || y > 1.03) return null;
    const near = outlineDistance(this.outline, x, y);
    if (!near.inside && near.distance > 0.03) return null;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  /** The sky follows the world's conditions: slowly while time runs, at once when the picture is a still. */
  private followMood(frame: WorldFrame, dt: number): void {
    if (frame.version !== this.moodVersion) {
      this.moodVersion = frame.version;
      this.mood = worldMood(frame);
    }
    const k = dt > 0 ? 1 - Math.exp(-dt / 1.6) : 1;
    const now = this.shared.uMood.value;
    now.x += (this.mood.hot - now.x) * k;
    now.y += (this.mood.cold - now.y) * k;
    now.z += (this.mood.wet - now.z) * k;
    now.w += (this.mood.life - now.w) * k;
  }

  /** Let time pass without drawing (the world is hidden behind something). */
  advance(dt: number): void {
    this.time += dt;
  }

  /** Draw the world as it looks at one fixed moment: same inputs, same picture. */
  renderAt(frame: WorldFrame, cards: LiveCard[], time: number): void {
    this.time = time;
    this.render(frame, cards, 0);
  }

  render(frame: WorldFrame, cards: LiveCard[], dt: number): void {
    this.time += dt;
    this.shared.uTime.value = this.time;
    this.shared.uSea.value = frame.seaLevel;
    this.fields.update(frame);
    this.followMood(frame, dt);
    const count = Math.min(MAX_PULSES, cards.length);
    for (let i = 0; i < count; i++) {
      const card = cards[i];
      this.shared.uPulse.value[i].set(card.x, card.y, card.age, card.strength);
      this.shared.uPulseColor.value[i].set(card.def.color);
    }
    this.shared.uPulseCount.value = count;
    this.placeCamera();
    this.camera.updateMatrixWorld();
    this.beacons.setVisible(this.showBeacons);
    if (this.showBeacons) {
      this.beacons.update(cards, frame, this.time, this.camera, this.canvas.clientWidth, this.canvas.clientHeight);
    }
    this.composer.render(dt);
  }
}
