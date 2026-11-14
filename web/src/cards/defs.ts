// Card definitions are plain data (cards.json). Adding a card means adding an
// entry there: no new logic. The server reads the same file for the words.
import raw from './cards.json';

/** The underlying world properties a card may push on. */
export type FieldName = 'height' | 'temperature' | 'wetness' | 'life' | 'people' | 'lava' | 'seaLevel';

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
}

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

export interface CardDef {
  id: string;
  word: string;
  aliases?: string[];
  icon: string;
  color: string;
  effects: CardEffect[];
  modifier?: CardModifier;
  /**
   * True for a card that is several simpler cards in one (VOLCANO: a cone, a crater and lava).
   * Left out of the every-combination sets, which double with each card in them.
   */
  compound?: boolean;
}

export const CARD_DEFS: CardDef[] = raw as CardDef[];

const byId = new Map<string, CardDef>(CARD_DEFS.map((d) => [d.id, d]));

export function cardDef(id: string): CardDef | undefined {
  return byId.get(id);
}

/** Register a card at runtime (the hook for AI-generated cards later). */
export function registerCard(def: CardDef): void {
  if (!byId.has(def.id)) CARD_DEFS.push(def);
  byId.set(def.id, def);
}
