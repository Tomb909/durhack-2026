// The sound engine: one Web Audio context, a master volume and three groups
// (ambience, life, cards). Browsers only allow sound after someone clicks or
// presses a key, so nothing is made until `start()` is called from one.
//
// Every sound is made in code from noise and simple tones: small, and in the
// same low-detail spirit as the pictures.

const MUTE_KEY = 'deck.muted';
/** The overall level: a calm world is quiet. */
const MASTER = 0.8;

export type Bus = 'ambience' | 'life' | 'cards';

function savedMute(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses = new Map<Bus, GainNode>();
  private noises = new Map<string, AudioBuffer>();
  muted = savedMute();
  private onStart: ((engine: AudioEngine) => void)[] = [];

  get started(): boolean {
    return this.ctx !== null;
  }

  /** Call from a click or key press. Safe to call again: it only resumes. */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    // A gentle limiter so a loud moment never clips.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 6;
    limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER;
    this.master.connect(limiter);
    for (const name of ['ambience', 'life', 'cards'] as Bus[]) {
      const g = ctx.createGain();
      g.connect(this.master);
      this.buses.set(name, g);
    }
    for (const f of this.onStart) f(this);
    this.onStart = [];
  }

  /** Run once the engine has started (now, if it already has). */
  whenStarted(f: (engine: AudioEngine) => void): void {
    if (this.ctx) f(this);
    else this.onStart.push(f);
  }

  bus(name: Bus): GainNode {
    const g = this.buses.get(name);
    if (!g) throw new Error('audio not started');
    return g;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      /* private window: only this visit remembers */
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : MASTER, this.ctx.currentTime, 0.15);
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** A few seconds of looping noise. White is hiss, pink is softer, brown is a deep rumble. */
  noise(kind: 'white' | 'pink' | 'brown', seconds = 4): AudioBuffer {
    const cached = this.noises.get(kind);
    if (cached) return cached;
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      if (kind === 'white') data[i] = white * 0.5;
      else if (kind === 'brown') {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      } else {
        // Paul Kellet's pink filter.
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    }
    // Fade the ends together so the loop has no click.
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[length - fade + i] = data[length - fade + i] * (1 - t) + data[i] * t;
    }
    this.noises.set(kind, buffer);
    return buffer;
  }

  /** A looping noise source, started at a random point so layers never line up. */
  loop(kind: 'white' | 'pink' | 'brown'): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(kind);
    src.loop = true;
    src.start(ctx.currentTime, Math.random() * src.buffer.duration);
    return src;
  }

  /** A slow wobble added to `param`: a sine LFO of `rate` Hz and `depth`. */
  wobble(param: AudioParam, rate: number, depth: number): OscillatorNode {
    const ctx = this.ctx!;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate;
    const amount = ctx.createGain();
    amount.gain.value = depth;
    lfo.connect(amount).connect(param);
    lfo.start(ctx.currentTime + Math.random());
    return lfo;
  }
}

export const audio = new AudioEngine();
