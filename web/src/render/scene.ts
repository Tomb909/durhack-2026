// Puts the world on screen. Input: a WorldFrame and the card list. Nothing
// outside render/ knows how the picture is made.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { combine } from '../cards/recipes';
import type { LiveCard } from '../cards/store';
import { DEFAULT_SHAPE, GW, gridHeight, outlineDistance, type WorldFrame, type WorldShape } from '../sim/world';
import { AirLayer, GradeShader } from './air';
import { makeBackdrop } from './backdrop';
import { makeGrass } from './grass';
import { Beacons } from './beacons';
import { CameraRig } from './camera';
import { HSCALE, MAX_BIOMES, MAX_PULSES, SUN_DIR, makeSharedUniforms, setSharedWorld, setWorldAspect, world, type SharedUniforms } from './common';
import { FieldTextures } from './fields';
import { makeLava } from './lava';
import { CALM, worldMood, type Mood } from './mood';
import { makePalettes } from './palette';
import { AmbientPass, castsShadow, GradeShader as FilmGradeShader, SunShadows } from './post';
import { makeSlabSides } from './slab';
import { makeTerrain } from './terrain';
import { Landmarks, makePeople, Merchants } from './people';
import { PropLayer } from './props';
import { QualityGovernor } from './quality';
import { WorldReach, type Culled } from './sites';
import { makeTrees } from './trees';
import { makeWater } from './water';
import { makePlume } from './plume';
import { makeWeather } from './weather';
import { makeWindEffects } from './wind';

const FOV = 30;
const SWAY = THREE.MathUtils.degToRad(22); // never a full spin: left stays left
const SWAY_PERIOD = 52;
const TARGET = new THREE.Vector3(0, 0.55, 0.25);
/** Never draw at fewer than this many picture pixels per screen pixel, however slow the machine. */
const LEAST_PIXEL_RATIO = 0.5;

/**
 * The last step of drawing: darken the corners (a vignette), then turn the picture's light
 * into screen colours (tone mapping and sRGB). One pass over the screen instead of two.
 */
class FinishPass extends Pass {
  private quad: FullScreenQuad;
  private material: THREE.ShaderMaterial;

  constructor(offset: number, darkness: number) {
    super();
    this.needsSwap = false; // it draws to the screen: there is nothing to hand on
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uOffset: { value: offset }, uDarkness: { value: darkness } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uOffset;
        uniform float uDarkness;
        varying vec2 vUv;
        void main() {
          vec4 texel = texture2D(tDiffuse, vUv);
          vec2 uv = (vUv - 0.5) * uOffset;
          gl_FragColor = vec4(mix(texel.rgb, vec3(1.0 - uDarkness), dot(uv, uv)), texel.a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly gpuName: string;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400);
  private composer: EffectComposer;
  private sun: SunShadows;
  private grade: ShaderPass;
  private sunOnScreen = new THREE.Vector3();
  private bloom: UnrealBloomPass;
  /** Word cards: their objects, their particles, and the grade of light they lend the picture. */
  private props: PropLayer;
  private air: AirLayer;
  /** The film look over everything (post.ts). */
  private film: ShaderPass;
  private shared: SharedUniforms;
  private fields!: FieldTextures;
  private palettes = makePalettes();
  /** Each card's colour, read from its text once rather than on every frame. */
  private pulseColours = new WeakMap<object, THREE.Color>();
  private biomeTone = new THREE.Color();
  /** Meshes that depend on the play area's shape; rebuilt by setShape. */
  private shaped: THREE.Object3D[] = [];
  /** The last shape's meshes, kept until the new ones have been drawn once (see setShape). */
  private retired: THREE.Object3D[] = [];
  /** Things drawn at fixed sites, told before each new world which sites are worth drawing (see sites.ts). */
  private culled: (THREE.Object3D & Culled)[] = [];
  /** Smoke over the vents, and the lava's level surface: each drawn only while there is some. */
  private plume!: THREE.Object3D;
  private lava: THREE.Object3D | null = null;
  private reach = new WorldReach();
  private reachFrame: WorldFrame | null = null;
  private reachRules = -1;
  private reachCull = true;
  private governor = new QualityGovernor();
  private lastDrawn = 0;
  private outline: number[][] = DEFAULT_SHAPE.outline;
  /** This renderer's own proportions. `world` (common.ts) is shared by every renderer on the page. */
  private aspect = DEFAULT_SHAPE.aspect;
  private beacons: Beacons;
  private merchants: Merchants;
  private landmarks: Landmarks;
  private time = 0;
  private quality = 1.5;
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.25);
  private fixed: { width: number; height: number } | null = null;
  private lookAt = new THREE.Vector3();
  /** The conditions the sky is heading for, and the frame they were read from. */
  private mood: Mood = { ...CALM };
  private moodFrame: WorldFrame | null = null;
  private moodVersion = -1;
  /** Where the camera is and how it moves (see camera.ts for the controls). */
  readonly rig = new CameraRig();
  showBeacons = true;
  /** The gentle side-to-side drift while nobody is holding the camera. */
  sway = true;
  /** Above 1 moves the camera closer than "the whole world fits". */
  zoom = 1;
  /**
   * True: when frames are slow, draw fewer pixels to stay smooth, and sharpen again when
   * there is time to spare. Never sharper than the chosen quality (the Q key).
   */
  get autoQuality(): boolean {
    return this.auto;
  }
  set autoQuality(on: boolean) {
    this.auto = on;
    if (this.composer) this.resize();
  }
  private auto = true;
  /** False draws every tree, house and person site whether or not anything shows there (slow: only to check that leaving them out changes nothing). */
  cull = true;

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
    this.sun = new SunShadows(this.renderer, this.shared);
    this.merchants = new Merchants(this.shared);
    this.landmarks = new Landmarks(this.shared);
    this.scene.add(makeBackdrop(this.shared));
    this.setShape(DEFAULT_SHAPE);
    // Everything that stands on the land casts a shadow.
    const trees = makeTrees(this.shared);
    const people = makePeople(this.shared);
    for (const o of [trees, people, this.merchants.group, this.landmarks.group]) castsShadow(o);
    this.scene.add(makeGrass(this.shared, this.palettes));
    this.culled = [trees, people, makeWeather(this.shared)];
    for (const part of this.culled) this.scene.add(part);
    this.plume = makePlume(this.shared);
    this.scene.add(this.plume);
    this.props = new PropLayer(this.shared);
    this.scene.add(this.props.group);
    this.air = new AirLayer(this.shared, this.props.night);
    this.scene.add(this.air.points);
    this.scene.add(this.merchants.group);
    this.scene.add(this.landmarks.group);
    this.scene.add(makeWindEffects(this.shared));
    this.scene.add(this.beacons.group);

    // HDR, multisampled, and keeping its depth for the ambient occlusion.
    const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    // Float depth: fine enough that flat ground stays flat to the ambient occlusion.
    target.depthTexture = new THREE.DepthTexture(4, 4);
    target.depthTexture.type = THREE.FloatType;
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new AmbientPass(this.camera));
    // Off unless a card changes the air, so a world of built-in cards is drawn exactly as before.
    this.grade = new ShaderPass(GradeShader);
    this.grade.enabled = false;
    this.composer.addPass(this.grade);
    // Only the brightest things bloom: the sun on water and snow, glitter, glowing leaves.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.42, 0.5, 1.7);
    this.composer.addPass(this.bloom);
    this.film = new ShaderPass(FilmGradeShader);
    this.composer.addPass(this.film);
    // The film grade has its own vignette: this pass only tone-maps and draws to the screen.
    this.composer.addPass(new FinishPass(0, 1.0));

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Rebuild everything that depends on the play area's shape and proportions. */
  setShape(shape: WorldShape): void {
    this.aspect = shape.aspect;
    setWorldAspect(shape.aspect);
    this.sun.fit();
    const gw = GW;
    const gh = gridHeight(shape.aspect);
    this.outline = shape.outline;
    // The old meshes go once the new ones have been drawn. Their shaders are the same programs:
    // letting go of the old first would throw the compiled programs away and build them all
    // again, a long stall on every change of shape.
    this.release(this.retired);
    for (const object of this.shaped) {
      this.scene.remove(object);
      this.retired.push(object);
    }
    if (this.fields) this.fields.dispose();
    this.fields = new FieldTextures(gw, gh, this.renderer.extensions.has('OES_texture_float_linear'));
    this.shared.uFieldA.value = this.fields.a;
    this.shared.uFieldB.value = this.fields.b;
    this.shared.uFieldC.value = this.fields.c;
    this.shared.uFieldD.value = this.fields.d;
    this.shared.uFieldE.value = this.fields.e;
    this.shared.uFieldF.value = this.fields.f;
    this.shared.uFieldG.value = this.fields.g;
    this.shared.uVent.value = this.fields.vents;
    setSharedWorld(this.shared, gw, gh);
    this.lava = makeLava(this.shared, gw, gh);
    this.shaped = [makeTerrain(this.shared, this.palettes, gw, gh), makeSlabSides(this.shared, shape.outline, gw), this.lava, makeWater(this.shared, gw, gh)];
    for (const object of this.shaped) this.scene.add(object);
  }

  /** Free these meshes' shapes and materials, and empty the list. */
  private release(objects: THREE.Object3D[]): void {
    for (const object of objects) {
      object.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    objects.length = 0;
  }

  setQuality(pixelRatio: number): void {
    this.quality = pixelRatio;
    this.governor.reset();
    this.resize();
  }

  /** Picture pixels per screen pixel right now (lower than the chosen quality while the machine is struggling). */
  get pixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  /** How many of the tree, house and people sites are being drawn. */
  get sitesDrawn(): { all: number; drawn: number } {
    const total = { all: 0, drawn: 0 };
    this.scene.traverse((o) => {
      const geometry = (o as THREE.Mesh).geometry as THREE.InstancedBufferGeometry | undefined;
      const sites = geometry?.getAttribute?.('aSite');
      if (!geometry || !sites) return;
      total.all += sites.count;
      total.drawn += o.visible ? Math.min(geometry.instanceCount, sites.count) : 0;
    });
    return total;
  }

  /** Draw at exactly this many pixels, whatever the window or screen (used by the harness). */
  setFixedSize(width: number, height: number): void {
    this.fixed = { width, height };
    this.resize();
  }

  resize(): void {
    const width = this.fixed?.width ?? (this.canvas.clientWidth || window.innerWidth);
    const height = this.fixed?.height ?? (this.canvas.clientHeight || window.innerHeight);
    const chosen = Math.min(window.devicePixelRatio || 1, this.quality);
    const ratio = this.fixed ? 1 : Math.max(Math.min(chosen, LEAST_PIXEL_RATIO), chosen * (this.autoQuality ? this.governor.scale : 1));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.film.uniforms.uResolution.value.set(width * ratio, height * ratio);
    this.shared.uViewHeight.value = height * ratio;
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
    setWorldAspect(this.aspect);
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, hit)) return null;
    return { x: hit.x - TARGET.x, z: hit.z - TARGET.z };
  }

  /** Where on the table (0..1, 0..1) a screen point lands, or null if it misses the world. */
  pickTable(clientX: number, clientY: number): { x: number; y: number } | null {
    setWorldAspect(this.aspect);
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
    if (frame !== this.moodFrame || frame.version !== this.moodVersion) {
      this.moodFrame = frame; // a new world starts counting versions again
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

  /** Leave out the tree, house and people sites with nothing to show. Only when the world has changed. */
  private cullSites(frame: WorldFrame): void {
    // `rules`, not `version`: the tests read only fields the rules produce (plants, climate, homes,
    // farms, fishing, logging, rain), none of which change while water eases or forest is felled.
    if (frame === this.reachFrame && frame.rules === this.reachRules && this.cull === this.reachCull) return;
    this.reachFrame = frame;
    this.reachRules = frame.rules;
    this.reachCull = this.cull;
    this.reach.reset(frame);
    for (const part of this.culled) part.cull(this.reach, !this.cull);
  }

  /** While time is running: watch how long frames take and give up or win back sharpness. */
  private pace(): void {
    const now = performance.now();
    const seconds = (now - this.lastDrawn) / 1000;
    this.lastDrawn = now;
    if (this.autoQuality && !this.fixed && !document.hidden && this.governor.frame(seconds)) this.resize();
  }

  render(frame: WorldFrame, cards: LiveCard[], dt: number): void {
    // Another renderer (the Combinations view's) may have drawn a world of other proportions since.
    setWorldAspect(this.aspect);
    if (dt > 0) this.pace();
    this.time += dt;
    this.shared.uTime.value = this.time;
    this.shared.uSea.value = frame.seaLevel;
    this.fields.update(frame);
    this.shared.uPeak.value = this.fields.peak * HSCALE;
    this.shared.uVentCount.value = this.fields.ventCount;
    // No vents, no smoke; no lava, no lava surface: neither is handed to the GPU at all.
    this.plume.visible = this.fields.ventCount > 0;
    if (this.lava) this.lava.visible = this.fields.lavaShows;
    this.cullSites(frame);
    this.followMood(frame, dt);
    // The settlements the CIVILIZATION cards make (a village, a town, a city), not the cards themselves.
    const made = combine(cards);
    this.merchants.update(made, frame, this.time);
    this.landmarks.update(made, frame);
    const count = Math.min(MAX_PULSES, cards.length);
    for (let i = 0; i < count; i++) {
      const card = cards[i];
      this.shared.uPulse.value[i].set(card.x, card.y, card.age, card.strength);
      let colour = this.pulseColours.get(card.def);
      if (!colour) this.pulseColours.set(card.def, (colour = new THREE.Color(card.def.color)));
      this.shared.uPulseColor.value[i].copy(colour);
    }
    this.shared.uPulseCount.value = count;
    let biomes = 0;
    const tone = this.biomeTone;
    for (const card of cards) {
      const b = card.def.biome;
      if (!b || card.strength <= 0 || biomes >= MAX_BIOMES) continue;
      const s = this.shared;
      s.uBiome.value[biomes].set(card.x, card.y, b.radius, b.strength * Math.min(1, card.strength));
      s.uBiomeGround.value[biomes].set(b.ground);
      // Cliffs with no colour of their own are a darker shade of the ground.
      if (b.rock) s.uBiomeRock.value[biomes].set(b.rock);
      else s.uBiomeRock.value[biomes].set(b.ground).multiplyScalar(0.7);
      if (b.plants) s.uBiomePlants.value[biomes].set(tone.set(b.plants).r, tone.g, tone.b, 1);
      else s.uBiomePlants.value[biomes].set(0, 0, 0, 0);
      if (b.liquid) s.uBiomeLiquid.value[biomes].set(tone.set(b.liquid.color).r, tone.g, tone.b, 1);
      else s.uBiomeLiquid.value[biomes].set(0, 0, 0, 0);
      s.uBiomeExtra.value[biomes].set(b.liquid?.glow ?? 0, b.trees ? 1 : 0, 0, 0);
      biomes++;
    }
    this.shared.uBiomeCount.value = biomes;
    this.props.update(frame, cards, dt > 0);
    this.air.update(frame, cards, (this.fixed?.height ?? (this.canvas.clientHeight || window.innerHeight)) * this.renderer.getPixelRatio());
    const grade = this.air.grade;
    this.props.night.value = Math.max(0, -grade.light);
    this.grade.enabled = grade.amount > 0.001 || Math.abs(grade.light) > 0.001;
    this.grade.uniforms.uTint.value.copy(grade.tint);
    this.grade.uniforms.uAmount.value = grade.amount;
    this.grade.uniforms.uLight.value = grade.light;
    this.placeCamera();
    this.camera.updateMatrixWorld();
    this.beacons.setVisible(this.showBeacons);
    if (this.showBeacons) {
      this.beacons.update(cards, frame, this.time, this.camera, this.canvas.clientWidth, this.canvas.clientHeight);
    }
    this.sun.render(this.scene);
    this.film.uniforms.uTime.value = this.time;
    // The sun's place on screen (far away along its direction), for the grade's warm wash.
    this.sunOnScreen.copy(SUN_DIR).multiplyScalar(60).project(this.camera);
    // Behind the camera, the projection flips: then there is no wash to see.
    if (this.sunOnScreen.z > 1) this.film.uniforms.uSun.value.set(-9, -9);
    else this.film.uniforms.uSun.value.set(this.sunOnScreen.x * 0.5 + 0.5, this.sunOnScreen.y * 0.5 + 0.5);
    this.composer.render(dt);
    this.release(this.retired);
  }
}
