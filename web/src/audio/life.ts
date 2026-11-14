// The sounds of people living on the land, from real recordings (CC0, see
// sounds/CREDITS.md): soft chatter and a crackling fire in the village,
// chickens and sheep on the farms, oars and gulls by the fishing
// boats, an axe in the woods. Each place has a quiet looping bed that fades in
// with how much of it is in earshot, plus the odd one-off sound. Everything
// passes through a gentle cut of the highs and a little room echo, so it is
// heard from a distance and sits behind the world rather than on top of it.
import axeUrl from './sounds/axe.mp3';
import chatterUrl from './sounds/village-chatter.mp3';
import chickensUrl from './sounds/chickens.mp3';
import fireplaceUrl from './sounds/fireplace.mp3';
import gullsUrl from './sounds/gulls.mp3';
import oarsUrl from './sounds/oars.mp3';
import sheepUrl from './sounds/sheep.mp3';
import type { AudioEngine } from './engine';
import type { Soundscape } from './listen';

type Life = Pick<Soundscape, 'village' | 'farm' | 'fishing' | 'logging'>;
type Amount = keyof Life;

const FILES = { chatter: chatterUrl, fireplace: fireplaceUrl, chickens: chickensUrl, oars: oarsUrl, sheep: sheepUrl, gulls: gullsUrl, axe: axeUrl };
type Sound = keyof typeof FILES;

/**
 * Looping beds: which recording, what brings it in, its level at full strength,
 * and how muffled it is (the highest pitch let through, Hz). The chatter is
 * muffled hard, as if through walls and across a square: voices, not words.
 */
const BEDS: { sound: Sound; amount: Amount; level: number; muffle: number }[] = [
  { sound: 'chatter', amount: 'village', level: 0.14, muffle: 650 },
  { sound: 'fireplace', amount: 'village', level: 0.2, muffle: 3000 },
  { sound: 'chickens', amount: 'farm', level: 0.15, muffle: 2500 },
  { sound: 'oars', amount: 'fishing', level: 0.22, muffle: 2500 },
];

/**
 * One-off sounds: how often (a second, at full strength), how loud, and how much
 * of the recording to play (seconds; 0 = all of it, otherwise a slice from a random point).
 */
const ONE_OFFS: { sound: Sound; amount: Amount; rate: number; level: number; slice: number }[] = [
  { sound: 'sheep', amount: 'farm', rate: 0.05, level: 0.3, slice: 0 },
  { sound: 'gulls', amount: 'fishing', rate: 0.05, level: 0.45, slice: 4 },
  { sound: 'axe', amount: 'logging', rate: 0.1, level: 0.22, slice: 5 },
];

/** Seconds for a bed to follow a change: slow, so nothing jumps. */
const EASE = 1.5;

export class VillageLife {
  private e: AudioEngine | null = null;
  /** Where every sound goes in: through the distance filter, dry and into the echo. */
  private input: GainNode | null = null;
  private buffers = new Map<Sound, AudioBuffer>();
  private beds: { amount: Amount; level: number; gain: GainNode }[] = [];
  /** Close up, people are louder than when the whole world is in view. */
  private near = 0.5;

  constructor(engine: AudioEngine) {
    engine.whenStarted((e) => this.build(e));
  }

  private build(e: AudioEngine): void {
    this.e = e;
    const ctx = e.ctx!;
    this.input = ctx.createGain();
    const far = ctx.createBiquadFilter();
    far.type = 'lowpass';
    far.frequency.value = 3500;
    far.Q.value = 0.5;
    this.input.connect(far);
    const dry = ctx.createGain();
    dry.gain.value = 0.8;
    far.connect(dry).connect(e.bus('life'));
    const room = ctx.createConvolver();
    room.buffer = this.echo(1.8);
    const wet = ctx.createGain();
    wet.gain.value = 0.28;
    far.connect(room).connect(wet).connect(e.bus('life'));

    for (const [name, url] of Object.entries(FILES) as [Sound, string][]) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data))
        .then((buffer) => {
          this.buffers.set(name, buffer);
          for (const bed of BEDS) if (bed.sound === name) this.startBed(bed, buffer);
        })
        .catch((err) => console.warn(`[audio] could not load ${name}`, err));
    }
  }

  /** Loop a recording from a random point, silent until its amount brings it in. */
  private startBed(bed: (typeof BEDS)[number], buffer: AudioBuffer): void {
    const ctx = this.e!.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = bed.muffle;
    muffle.Q.value = 0.4;
    src.connect(muffle).connect(gain).connect(this.input!);
    src.start(ctx.currentTime, Math.random() * buffer.duration);
    this.beds.push({ amount: bed.amount, level: bed.level, gain });
  }

  /** A room's echo: a couple of seconds of decaying noise, a little different in each ear. */
  private echo(seconds: number): AudioBuffer {
    const ctx = this.e!.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    }
    return buffer;
  }

  update(life: Life, zoom: number, dt: number): void {
    if (!this.e) return;
    this.near = 0.35 + 0.65 * Math.min(1, Math.max(0, (zoom - 0.8) / 2.5));
    const now = this.e.ctx!.currentTime;
    for (const bed of this.beds) bed.gain.gain.setTargetAtTime(bed.level * life[bed.amount] * this.near, now, EASE);
    for (const one of ONE_OFFS) {
      const amount = life[one.amount];
      if (amount > 0.02 && Math.random() < one.rate * amount * dt) this.play(one);
    }
  }

  /** Play a one-off from somewhere left or right, slightly varied in pitch so repeats differ. */
  private play(one: (typeof ONE_OFFS)[number]): void {
    const buffer = this.buffers.get(one.sound);
    if (!buffer) return;
    const ctx = this.e!.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 1.4;
    const gain = ctx.createGain();
    const t = ctx.currentTime + 0.02;
    const level = one.level * this.near;
    const length = one.slice > 0 ? Math.min(one.slice, buffer.duration) : buffer.duration;
    const from = one.slice > 0 ? Math.random() * Math.max(0, buffer.duration - length) : 0;
    // Slices fade in and out so they never start or stop with a click.
    const fade = one.slice > 0 ? 0.3 : 0.01;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + fade);
    gain.gain.setValueAtTime(level, t + length - fade);
    gain.gain.linearRampToValueAtTime(0, t + length);
    src.connect(gain).connect(pan).connect(this.input!);
    src.start(t, from, length + 0.05);
    src.onended = () => pan.disconnect();
  }
}
