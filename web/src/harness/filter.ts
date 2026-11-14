// Which combinations the Combinations view shows: every way of choosing from
// the cards that are switched on. Five cards on is 32 worlds; switch one off
// and it is 16. Each card can also be given 2 or 3 copies.
import { CARD_DEFS, isEvent } from '../cards/defs';
import { nameOf, parseCode, type Scenario } from './codes';

export interface ComboFilter {
  /** Card ids switched off. A card not listed (a new one, say) is on. */
  off: string[];
  /** Copies per card id, 1 to 3. A card not listed has one. */
  copies: Record<string, number>;
}

export const MOST_COPIES = 3;
export const defaultFilter = (): ComboFilter => ({ off: [], copies: {} });

export const copiesOf = (filter: ComboFilter, id: string) => Math.min(MOST_COPIES, Math.max(1, Math.round(filter.copies[id] ?? 1)));

/** Every combination of the cards that are on: fewest cards first, then in the cards' own order. */
export function combinations(filter: ComboFilter, ids: string[] = CARD_DEFS.filter((d) => !isEvent(d)).map((d) => d.id)): Scenario[] {
  const on = ids.filter((id) => !filter.off.includes(id));
  const modifiers = new Set(CARD_DEFS.filter((d) => d.modifier).map((d) => d.id));
  const sets: string[][] = [];
  for (let mask = 0; mask < 1 << on.length; mask++) sets.push(on.filter((_, i) => mask & (1 << i)));
  sets.sort((a, b) => a.length - b.length);
  return sets
    .filter((set) => set.length === 0 || set.some((id) => !modifiers.has(id)))
    .map((set) => {
      const code = set.map((id) => (copiesOf(filter, id) > 1 ? `${id}*${copiesOf(filter, id)}` : id)).join('+') || 'empty';
      return { name: nameOf(code), code, cards: parseCode(code, 'cluster') };
    });
}
