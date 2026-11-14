// Card definitions are plain data (cards.json). Adding a card means adding an
// entry there: no new logic. The server reads the same file for the words.
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

export interface CardDef {
  id: string;
  word: string;
  aliases?: string[];
  icon: string;
  color: string;
  effects: CardEffect[];
  modifier?: CardModifier;
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
