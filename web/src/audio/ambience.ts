// The world's background sound: sea, river, wind, rain, snow, insects and
// birdsong, each a layer of shaped noise (or, for birds, little chirps)
// whose volume follows what is in earshot of the camera (see listen.ts).
import type { WorldFrame } from '../sim/world';
import type { AudioEngine } from './engine';
import { listen, SILENT, type Focus, type Soundscape } from './listen';

/** Each layer's volume when its value is 1. */
const LOUDEST = {
  sea: 0.55,
  river: 0.22,
  wind: 0.2,
  rain: 0.15,
  snow: 0.14,
  birds: 0.05, // per chirp
  insects: 0.035,
} satisfies Partial<Record<keyof Soundscape, number>>;
type Layer = keyof typeof LOUDEST;
/** Seconds for a layer to follow a change: slow, so nothing jumps. */
const EASE = 1.2;
/** How often the world is listened to. */
const LISTEN_EVERY = 0.25;

export class Ambience {
  private levels = new Map<Layer, GainNode>();
  private scape: Soundscape = { ...SILENT };
  private sinceListen = Infinity;
  private lastVersion = -1;
  private lastFocus: Focus | null = null;
  private engine: AudioEngine | null = null;

  constructor(engine: AudioEngine) {
    engine.whenStarted((e) => this.build(e));
  }

  /** The current reading, for debugging and tests. */
  get soundscape(): Readonly<Soundscape> {
    return this.scape;
  }

  private build(e: AudioEngine): void {
    this.engine = e;
    const ctx = e.ctx!;
    const out = e.bus('ambience');
    const level = (name: Layer) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(out);
      this.levels.set(name, g);
      return g;
    };
    const filter = (type: BiquadFilterType, frequency: number, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = frequency;
      f.Q.value = q;
      return f;
    };
    const swell = (rate: number, depth: number, base = 1) => {
      const g = ctx.createGain();
      g.gain.value = base;
      e.wobble(g.gain, rate, depth);
      return g;
    };

    // Sea: a deep roll and a brighter wash, each swelling slowly like waves coming in.
    const sea = level('sea');
    e.loop('brown').connect(filter('lowpass', 520)).connect(swell(0.11, 0.45, 0.6)).connect(sea);
    e.loop('pink').connect(filter('bandpass', 1100, 0.5)).connect(swell(0.073, 0.3, 0.35)).connect(sea);

    // River: a bright trickle whose pitch wanders and whose level flutters.
    const river = level('river');
    const trickle = filter('bandpass', 2400, 1.1);
    e.wobble(trickle.frequency, 0.31, 500);
    e.loop('white').connect(trickle).connect(swell(6.5, 0.18, 0.8)).connect(river);

    // Wind: a hollow breath that rises and falls in pitch and gusts.
    const wind = level('wind');
    const howl = filter('bandpass', 480, 1.4);
    e.wobble(howl.frequency, 0.047, 240);
    e.loop('pink').connect(howl).connect(swell(0.09, 0.4, 0.6)).connect(wind);

    // Rain: a soft patter rather than a hiss, swelling a little as showers pass.
    const rain = level('rain');
    const shower = ctx.createGain();
    shower.gain.value = 0.75;
    e.wobble(shower.gain, 0.06, 0.2);
    e.loop('pink').connect(filter('highpass', 500)).connect(filter('lowpass', 3200)).connect(shower).connect(rain);
    // Snow: a muffled hush.
    const snow = level('snow');
    e.loop('pink').connect(filter('lowpass', 800)).connect(snow);

    // Insects: a high, narrow buzz, pulsing fast like crickets and slowly in and out.
    const insects = level('insects');
    e.loop('white').connect(filter('bandpass', 4600, 9)).connect(swell(27, 0.5, 0.5)).connect(swell(0.55, 0.35, 0.65)).connect(insects);

    // Birds are chirps made as they are needed (see `birdsong`); they share this level.
    const birds = level('birds');
    birds.gain.value = 1;
  }

  update(frame: WorldFrame, focus: Focus, dt: number): void {
    if (!this.engine) return;
    this.sinceListen += dt;
    const moved = this.lastFocus && (Math.abs(this.lastFocus.x - focus.x) + Math.abs(this.lastFocus.y - focus.y) > 0.02 || Math.abs(this.lastFocus.zoom - focus.zoom) > 0.05);
    if (this.sinceListen >= LISTEN_EVERY && (frame.version !== this.lastVersion || moved || !this.lastFocus)) {
      this.sinceListen = 0;
      this.lastVersion = frame.version;
      this.lastFocus = { ...focus };
      this.scape = listen(frame, focus);
      const now = this.engine.ctx!.currentTime;
      for (const [name, g] of this.levels) {
        if (name === 'birds') continue;
        g.gain.setTargetAtTime(this.scape[name] * LOUDEST[name], now, EASE);
      }
    }
    // Birdsong comes in little phrases, more often where it is greener.
    if (Math.random() < this.scape.birds * 0.9 * dt) this.birdsong(this.scape.birds);
  }

  /** A phrase of two to five chirps from somewhere left or right. */
  private birdsong(amount: number): void {
    const e = this.engine!;
    const ctx = e.ctx!;
    const out = this.levels.get('birds')!;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(out);
    const notes = 2 + Math.floor(Math.random() * 4);
    const pitch = 2400 + Math.random() * 2200;
    const falling = Math.random() < 0.5;
    let t = ctx.currentTime + 0.05;
    const peak = LOUDEST.birds * (0.5 + 0.5 * amount) * (0.5 + Math.random() * 0.5);
    for (let n = 0; n < notes; n++) {
      const length = 0.05 + Math.random() * 0.08;
      const osc = ctx.createOscillator();
      const f0 = pitch * (0.9 + Math.random() * 0.25);
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * (falling ? 0.7 : 1.35), t + length);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t + length);
      osc.connect(env).connect(pan);
      osc.start(t);
      osc.stop(t + length + 0.02);
      t += length + 0.03 + Math.random() * 0.09;
    }
    setTimeout(() => pan.disconnect(), (t - ctx.currentTime + 0.5) * 1000);
  }
}
