// One list of cards for the whole app. Real (tracked) cards and simulated
// (mouse) cards live here together and are smoothed the same way, so the world
// never sees a jump: positions glide and strength fades in and out.
import { cardDef, type CardDef } from './defs';

export interface TrackedCard {
  id: number;
  card: string;
  x: number;
  y: number;
  /** Radians clockwise from the card's printed left-to-right direction. */
  angle?: number;
  visible: boolean;
  /** A written word that is no built-in card: its card is made from this (see seen.ts). */
  word?: string;
}

export interface LiveCard {
  key: string;
  def: CardDef;
  source: 'camera' | 'sim';
  /** Smoothed position, 0..1 across the play area (x left to right, y far to near). */
  x: number;
  y: number;
  /** Directional card orientation in radians. */
  angle: number;
  targetAngle: number;
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

/** A card that has already arrived: full strength, at rest, no arrival pulse. */
export function settledCard(key: string, def: CardDef, x: number, y: number, angle = 0): LiveCard {
  return { key, def, source: 'sim', x, y, angle, targetAngle: angle, tx: x, ty: y, vx: 0, vy: 0, strength: 1, fade: 1, present: true, visible: true, age: 99 };
}

export class CardStore {
  cards: LiveCard[] = [];
  private nextSim = 1;
  /** Bumps whenever anything changed this frame. */
  moving = false;
  /** True: no gliding or fading. Cards are where they are told to be, at once. */
  instant = false;
  /** Set when a card's definition changed under it (a word read again): the world must look again. */
  private dirty = false;

  private find(key: string): LiveCard | undefined {
    return this.cards.find((c) => c.key === key);
  }

  private add(key: string, def: CardDef, source: 'camera' | 'sim', x: number, y: number, angle = 0): LiveCard {
    const card: LiveCard = {
      key, def, source, x, y, angle, targetAngle: angle, tx: x, ty: y, vx: 0, vy: 0, strength: 0, fade: 0, present: true, visible: true, age: 0,
    };
    this.cards.push(card);
    return card;
  }

  // --- simulated cards (mouse) ------------------------------------------------

  addSim(cardId: string, x: number, y: number): string | null {
    const def = cardDef(cardId);
    if (!def || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const key = `sim:${this.nextSim++}`;
    this.add(key, def, 'sim', x, y);
    return key;
  }

  moveSim(key: string, x: number, y: number): void {
    const card = this.find(key);
    if (card && card.source === 'sim' && Number.isFinite(x) && Number.isFinite(y)) {
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

  /** Replace every simulated card at once, already arrived (no fade in or out). */
  setSim(placements: { id: string; x: number; y: number; angle?: number }[]): void {
    this.cards = this.cards.filter((c) => c.source !== 'sim');
    for (const p of placements) {
      const def = cardDef(p.id);
      if (def) this.cards.push(settledCard(`sim:${this.nextSim++}`, def, p.x, p.y, p.angle ?? 0));
    }
    this.moving = true;
  }

  // --- tracked cards (camera) ---------------------------------------------------

  /** Replace the set of camera-tracked cards with the latest snapshot. */
  setTracked(tracked: TrackedCard[]): void {
    const seen = new Set<string>();
    for (const t of tracked) {
      const def = cardDef(t.card);
      // A position that is not a number would spread through every field of the world.
      if (!def || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
      const key = `cam:${t.id}`;
      seen.add(key);
      let card = this.find(key);
      if (!card || card.def !== def) {
        if (card) card.present = false, (card.key += `:old${this.nextSim++}`); // its own key: two old cards must not share one
        card = this.add(key, def, 'camera', t.x, t.y);
      }
      card.present = true;
      card.visible = t.visible;
      card.targetAngle = t.angle ?? 0;
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

  /**
   * Card definitions changed (a word card made, read again or removed): point every
   * card at its current definition, take away cards whose definition is gone.
   */
  refreshDefs(): void {
    for (const card of this.cards) {
      const def = cardDef(card.def.id);
      if (!def) card.present = false;
      else card.def = def;
    }
    this.dirty = true;
  }

  // --- per-frame smoothing --------------------------------------------------------

  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    const decay = Math.exp(-SPRING * dt);
    let moving = false;
    for (const card of this.cards) {
      card.age += dt;
      if (this.instant) {
        const target = card.present ? 1 : 0;
        if (card.x !== card.tx || card.y !== card.ty || card.angle !== card.targetAngle || card.fade !== target) moving = true;
        card.x = card.tx;
        card.y = card.ty;
        card.angle = card.targetAngle;
        card.vx = card.vy = 0;
        card.fade = card.strength = target;
        if (card.present) card.age = Math.max(card.age, 99); // no arrival pulse
        continue;
      }
      // Critically damped spring towards the target position, solved exactly for this step.
      // (Stepping it by simple addition overshoots further every frame once frames take longer
      // than about 75 ms: cards fly off the table just when the machine is struggling.)
      const ex = card.x - card.tx;
      const ey = card.y - card.ty;
      const jx = card.vx + SPRING * ex;
      const jy = card.vy + SPRING * ey;
      card.x = card.tx + (ex + jx * dt) * decay;
      card.y = card.ty + (ey + jy * dt) * decay;
      card.vx = (card.vx - SPRING * jx * dt) * decay;
      card.vy = (card.vy - SPRING * jy * dt) * decay;
      const angleDelta = Math.atan2(Math.sin(card.targetAngle - card.angle), Math.cos(card.targetAngle - card.angle));
      card.angle += angleDelta * (1 - Math.exp(-SPRING * dt));
      if (Math.abs(angleDelta) > 1e-4) moving = true;
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
    this.moving = moving || this.dirty;
    this.dirty = false;
  }
}
