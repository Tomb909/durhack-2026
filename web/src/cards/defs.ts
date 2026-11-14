// Card definitions are plain data (cards.json). Adding a card means adding an
// entry there: no new logic. The server reads the same file for the words.
//
// A card can do three things, in any mix: push on the world's fields
// (`effects`), change the air (`atmosphere`), and stand an object in the world
// (`prop`). Built-in cards use only the first. Cards made from a typed word
// (see words.ts) may use all three, and are still only data.
import raw from './cards.json';

/** The underlying world properties a card may push on. */
export type FieldName = 'height' | 'temperature' | 'wetness' | 'life' | 'people' | 'seaLevel';

export interface CardEffect {
  field: FieldName;
  /** How much one copy adds at the card's own position. */
  amount: number;
  /** Reach of the effect, as a fraction of the world's width. Ignored for global effects. */
  radius?: number;
  /** True: applies to the whole world equally (position is ignored). */
  global?: boolean;
}

export interface CardModifier {
  type: 'radius';
  multiplier: number;
  heightMultiplier?: number;
  /** Maximum center distance to the target, as a fraction of table width. */
  maxDistance: number;
}

export const PARTICLE_MOTIONS = ['rise', 'fall', 'drift', 'swirl'] as const;
export type ParticleMotion = (typeof PARTICLE_MOTIONS)[number];

/** Things in the air near the card: smoke rising, petals falling, fog drifting. */
export interface Particles {
  motion: ParticleMotion;
  color: string;
  /** 0..1: dust to snowflake-sized. */
  size: number;
  /** 0..1: a few to a cloud. */
  density: number;
  /** Lit from within (embers, fireflies). */
  glow: boolean;
}

/** How a card changes the air. Tint and light are for the whole world; particles stay by the card. */
export interface Atmosphere {
  /** A colour the sky and light lean towards. */
  tint: string;
  /** 0..1: how far they lean. */
  strength: number;
  /** -1 night, 0 unchanged, +1 bright. */
  light: number;
  particles: Particles | null;
}

export const PART_SHAPES = ['box', 'cylinder', 'cone', 'pyramid', 'prism', 'sphere'] as const;
export type PartShape = (typeof PART_SHAPES)[number];
export const PROP_SCALES = ['small', 'medium', 'large', 'landmark'] as const;
export const PROP_COUNTS = ['one', 'few', 'many'] as const;
export const HABITATS = ['land', 'water', 'shore', 'air', 'anywhere'] as const;
export const PROP_MOTIONS = ['still', 'bob', 'sway', 'spin', 'drift'] as const;
export type Habitat = (typeof HABITATS)[number];
export type PropMotion = (typeof PROP_MOTIONS)[number];

/** One primitive of an object. The object fits a unit cube: x, z -0.5..0.5, y 0 (the ground) .. 1. */
export interface PropPart {
  shape: PartShape;
  /** Centre. */
  at: [number, number, number];
  /** Width, height, depth. */
  size: [number, number, number];
  /** Degrees about x, y, z. */
  rotate: [number, number, number];
  color: string;
}

/** An object made of primitives that the card stands in the world. */
export interface Prop {
  parts: PropPart[];
  scale: (typeof PROP_SCALES)[number];
  count: (typeof PROP_COUNTS)[number];
  habitat: Habitat;
  motion: PropMotion;
  glow: boolean;
}

export interface CardDef {
  id: string;
  word: string;
  aliases?: string[];
  icon: string;
  color: string;
  effects: CardEffect[];
  modifier?: CardModifier;
  atmosphere?: Atmosphere;
  prop?: Prop;
  /** Only on cards made from a typed word: read by the model, or guessed in the page. */
  origin?: 'llm' | 'fallback';
  /** Only on cards made from a typed word: one plain sentence on how the word was understood. */
  reading?: string;
  /** Milliseconds it took to make (shown in the Combinations view). */
  ms?: number;
}

export const CARD_DEFS: CardDef[] = raw as CardDef[];

/** The cards in cards.json. Only these answer to the "start of an id" shorthand in codes. */
export const BUILT_IN_IDS: ReadonlySet<string> = new Set(CARD_DEFS.map((d) => d.id));

const byId = new Map<string, CardDef>(CARD_DEFS.map((d) => [d.id, d]));
const listeners = new Set<() => void>();

export function cardDef(id: string): CardDef | undefined {
  return byId.get(id);
}

/** Hear about cards added, replaced or removed (the card panel and the Combinations view redraw). */
export function onCardsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tell everyone listening that the list of cards changed (after registering several quietly). */
export function cardsChanged(): void {
  for (const listener of listeners) listener();
}
const changed = cardsChanged;

/**
 * Register a card at runtime (cards made from typed words). A built-in card is
 * never replaced. Pass cards through cleanCard (words.ts) first.
 */
export function registerCard(def: CardDef, quiet = false): void {
  if (BUILT_IN_IDS.has(def.id)) return;
  const old = byId.get(def.id);
  if (old) CARD_DEFS[CARD_DEFS.indexOf(old)] = def;
  else CARD_DEFS.push(def);
  byId.set(def.id, def);
  if (!quiet) changed();
}

/** Take a card made from a typed word away again. Built-in cards stay. */
export function unregisterCard(id: string): void {
  const old = byId.get(id);
  if (!old || BUILT_IN_IDS.has(id)) return;
  CARD_DEFS.splice(CARD_DEFS.indexOf(old), 1);
  byId.delete(id);
  changed();
}
