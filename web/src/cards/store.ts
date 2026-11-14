// One list of cards for the whole app. Real (tracked) cards and simulated
// (mouse) cards live here together and are smoothed the same way, so the world
// never sees a jump: positions glide and strength fades in and out.
import { cardDef, type CardDef } from './defs';

export interface TrackedCard {
  id: number;
  card: string;
  x: number;
  y: number;
  visible: boolean;
}

export interface LiveCard {
  key: string;
  def: CardDef;
  source: 'camera' | 'sim';
  /** Smoothed position, 0..1 across the play area (x left to right, y far to near). */
  x: number;
  y: number;
  /** Where it is heading. */
  tx: number;
  ty: number;
  vx: number;
  vy: number;
  /** 0..1, eased. The world multiplies every effect by this. */
  strength: number;
  /** Linear fade progress behind `strength`. */
  fade: number;
  present: boolean;
  /** False while the camera cannot see it (held in place under a hand). */
  visible: boolean;
  /** Seconds since it appeared. */
  age: number;
}

const FADE_SECONDS = 0.8;
const SPRING = 11; // higher = snappier following

const smooth = (t: number) => t * t * (3 - 2 * t);

export class CardStore {
  cards: LiveCard[] = [];
  private nextSim = 1;
  /** Bumps whenever anything changed this frame. */
  moving = false;

  private find(key: string): LiveCard | undefined {
    return this.cards.find((c) => c.key === key);
  }

  private add(key: string, def: CardDef, source: 'camera' | 'sim', x: number, y: number): LiveCard {
    const card: LiveCard = {
      key, def, source, x, y, tx: x, ty: y, vx: 0, vy: 0, strength: 0, fade: 0, present: true, visible: true, age: 0,
    };
    this.cards.push(card);
    return card;
  }

  // --- simulated cards (mouse) ------------------------------------------------

  addSim(cardId: string, x: number, y: number): string | null {
    const def = cardDef(cardId);
    if (!def) return null;
    const key = `sim:${this.nextSim++}`;
    this.add(key, def, 'sim', x, y);
    return key;
  }

  moveSim(key: string, x: number, y: number): void {
    const card = this.find(key);
    if (card && card.source === 'sim') {
      card.tx = Math.min(1, Math.max(0, x));
      card.ty = Math.min(1, Math.max(0, y));
    }
  }

  removeSim(key: string): void {
    const card = this.find(key);
    if (card && card.source === 'sim') card.present = false;
  }

  clearSim(): void {
    for (const card of this.cards) if (card.source === 'sim') card.present = false;
  }

  // --- tracked cards (camera) ---------------------------------------------------

  /** Replace the set of camera-tracked cards with the latest snapshot. */
  setTracked(tracked: TrackedCard[]): void {
    const seen = new Set<string>();
    for (const t of tracked) {
      const def = cardDef(t.card);
      if (!def) continue;
      const key = `cam:${t.id}`;
      seen.add(key);
      let card = this.find(key);
      if (!card || card.def !== def) {
        if (card) card.present = false, (card.key += ':old');
        card = this.add(key, def, 'camera', t.x, t.y);
      }
      card.present = true;
      card.visible = t.visible;
      card.tx = t.x;
      card.ty = t.y;
    }
    for (const card of this.cards) {
      if (card.source === 'camera' && !seen.has(card.key)) card.present = false;
    }
  }

  /** Camera lost: keep the cards where they are, now movable with the mouse. */
  adoptTracked(): number {
    let adopted = 0;
    for (const card of this.cards) {
      if (card.source === 'camera' && card.present) {
        card.source = 'sim';
        card.key = `sim:${this.nextSim++}:adopted`;
        card.visible = true;
        adopted++;
      }
    }
    return adopted;
  }

  /** Camera is back: hand adopted cards back to tracking. */
  releaseAdopted(): void {
    for (const card of this.cards) if (card.key.endsWith(':adopted')) card.present = false;
  }

  // --- per-frame smoothing --------------------------------------------------------

  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    let moving = false;
    for (const card of this.cards) {
      card.age += dt;
      // Critically damped spring towards the target position.
      const ax = SPRING * SPRING * (card.tx - card.x) - 2 * SPRING * card.vx;
      const ay = SPRING * SPRING * (card.ty - card.y) - 2 * SPRING * card.vy;
      card.vx += ax * dt;
      card.vy += ay * dt;
      card.x += card.vx * dt;
      card.y += card.vy * dt;
      const target = card.present ? 1 : 0;
      const before = card.fade;
      if (card.fade < target) card.fade = Math.min(target, card.fade + dt / FADE_SECONDS);
      else if (card.fade > target) card.fade = Math.max(target, card.fade - dt / FADE_SECONDS);
      card.strength = smooth(card.fade);
      if (
        before !== card.fade ||
        Math.abs(card.vx) + Math.abs(card.vy) > 1e-4 ||
        Math.abs(card.tx - card.x) + Math.abs(card.ty - card.y) > 1e-4
      ) {
        moving = true;
      }
    }
    const kept = this.cards.filter((c) => c.present || c.fade > 0);
    if (kept.length !== this.cards.length) moving = true;
    this.cards = kept;
    this.moving = moving;
  }
}
