// Card definitions are plain data (cards.json). Adding a card means adding an
// entry there: no new logic. The server reads the same file for the words.
//
// A card can do four things, in any mix: push on the world's fields
// (`effects`, as a round patch or as a landform with an edge), say what the land
// round it is made of (`biome`), change the air (`atmosphere`), and stand an
// object in the world (`prop`). Built-in cards use only the first. Cards made
// from a typed word (see words.ts) may use all four, and are still only data.
//
// Some cards make something else when they lie next to each other (MOUNTAIN + LAVA: a
// volcano; CIVILIZATION cards together: a town, a city). Those recipes, and the data
// for what they make, are in recipes.ts.
import raw from './cards.json';

/** The underlying world properties a card may push on. */
export type FieldName =
  | 'height' | 'temperature' | 'wetness' | 'forest' | 'seaLevel'
  /** A basin dug at the card and kept full. `radius` is the lake's size; `amount` is unused. */
  | 'lake'
  /** People: how far they reach (houses, farms, boats), and what kind of place it is. */
  | 'settlement' | 'town' | 'city' | 'plaza'
  /** Molten rock welling up at the card. */
  | 'lava';

export interface CardEffect {
  field: FieldName;
  /** How much one copy adds at the card's own position. */
  amount: number;
  /** Reach of the effect, as a fraction of the world's width. Ignored for global effects. */
  radius?: number;
  /** True: applies to the whole world equally (position is ignored). */
  global?: boolean;
  /**
   * Makes the effect a crack instead of a round patch: it keeps to the fault line running
   * through the card. The number is the crack's width, as a fraction of the world's width.
   * With a negative height this is a ravine.
   */
  crack?: number;
  /**
   * Height only: a volcano's cone instead of a round patch. `amount` is the height of the
   * rim and `radius` the reach of the foot (a fraction of the world's width). Copies do not
   * pile up into one blob: each is its own cone, and the higher ground wins where they meet
   * (copies standing close together lift each other a little).
   */
  cone?: ConeShape;
  /**
   * A landform with a hard edge instead of a round patch that fades out a long way. `radius` is
   * then where the effect ends (not the width of a bell curve), so it cannot leak across the world.
   * On height it is the shape of the land; on any other field only `mound` and `flat` differ
   * (every other shape acts as `flat`).
   */
  shape?: LandShape;
}

/**
 * Landforms. `amount` is the height of the top (or, below zero, the depth of the floor).
 * - mound: a smooth dome, or a bowl
 * - flat: a level top or floor with steep sides (a mesa, a plateau, a basin)
 * - ridges: sharp parallel-ish crests and valleys (a mountain range, badlands)
 * - spires: many separate needles (stalagmites, hoodoos, crystals, termite mounds)
 * - dunes: long rounded waves
 * - terraces: a dome cut into level steps (rice terraces, a ziggurat hill, a stepped canyon)
 * - rim: a whole crater (also an atoll, a caldera): a raised crest with a gentle slope outside and a
 *   floor sunk below the ground inside. `amount` is the height of the crest; its sign is ignored.
 */
export const LAND_SHAPES = ['mound', 'flat', 'ridges', 'spires', 'dunes', 'terraces', 'rim'] as const;
export type LandShape = (typeof LAND_SHAPES)[number];

/** The shape of a volcano. Every share is of the cone's own size, so BIG scales it as a whole. */
export interface ConeShape {
  /** Crater radius, as a share of the base radius. */
  crater: number;
  /** How far the crater floor sits below the rim, as a share of the rim's height. */
  craterDepth: number;
  /**
   * The flank falls as (1 - d)^power from the rim (d = 0) to the foot (d = 1). Above 1 it is
   * concave: steepest right under the rim, flattening into a long apron.
   */
  power: number;
  /** How many gullies run down the flanks, and how deep (a share of the flank's height there). */
  gullies: number;
  gullyDepth: number;
  /**
   * Low gaps in the rim, each at the head of a gully, and how deep the deepest is (a share of the
   * crater's depth; the others are 0.82 of that). The crater leans towards the deepest, so the
   * crater lake spills there.
   */
  notches: number;
  notchDepth: number;
  /** Molten rock pouring out of the first notch (lava flow units); each next notch gets 0.6 of the one before. */
  lava?: number;
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

/**
 * What the land round the card is made of: its own colours for ground, plant cover, rock and
 * whatever liquid stands there. The world's rules still decide where there are hills, plants and
 * water; a biome only says what they look like here. So the Nether's sea is lava, a swamp's lakes
 * are green, and the Moon is grey with no trees, with no rule written for any of them.
 */
export interface Biome {
  /** Where the region ends, as a share of the world's width (its edge is ragged, not a circle). */
  radius: number;
  /** 0..1: how far the region takes these materials. */
  strength: number;
  /** Bare land. */
  ground: string;
  /** Land under plant cover, and the leaves of the world's own trees. Left out: the world's greens. */
  plants?: string;
  /** Steep faces and cliffs. Left out: a darker shade of `ground`. */
  rock?: string;
  /** What lakes, rivers and sea are made of here. Left out: water. */
  liquid?: Liquid;
  /** False: the world's own trees do not grow here (the card's object may stand in for them). */
  trees: boolean;
}

export interface Liquid {
  color: string;
  /** 0 an ordinary liquid that reflects the sky (a green swamp, a sea of milk) .. 1 lit from within (lava, plasma). */
  glow: number;
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

export const PART_SHAPES = ['box', 'cylinder', 'cone', 'pyramid', 'prism', 'sphere', 'capsule', 'dome', 'ring'] as const;
/** Copies of a part across the object's middle: left and right (x), front and back (z), or all four. */
export const PART_MIRRORS = ['x', 'z', 'xz'] as const;
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
  /** Width and depth at the top as a share of the bottom (1 straight, 0 a point, above 1 flaring). Box and cylinder. */
  taper?: number;
  /** Also drawn mirrored across the object's middle: four legs are one part with `xz`. */
  mirror?: (typeof PART_MIRRORS)[number];
  /** Drawn this many times, evenly round the object's upright axis (spokes, petals, battlements). */
  repeat?: number;
}

/** An object made of primitives that the card stands in the world. */
export interface Prop {
  parts: PropPart[];
  scale: (typeof PROP_SCALES)[number];
  /** The real thing's longest side in metres. When given it sets the drawn size (see propSize) and `scale` follows it. */
  metres?: number;
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
  /**
   * True for a card that is several simpler cards in one (a made card that is a cone, a crater and lava, say).
   * Left out of the every-combination sets, which double with each card in them.
   */
  compound?: boolean;
  atmosphere?: Atmosphere;
  biome?: Biome;
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
