// Which combinations the Combinations view shows: every way of choosing from
// the cards that are switched on. Five cards on is 32 worlds; switch one off
// and it is 16. Each card can also be given 2 or 3 copies, and any card can be
// marked "only with": then only the combinations that include it are shown.
//
// With many cards (every typed word is a card) there are far too many
// combinations to list, so they are made in order and only as many as asked for.
import { CARD_DEFS } from '../cards/defs';
import { nameOf, parseCode, type Scenario } from './codes';

export interface ComboFilter {
  /** Card ids switched off. A card not listed (a new one, say) is on. */
  off: string[];
  /** Copies per card id, 1 to 3. A card not listed has one. */
  copies: Record<string, number>;
  /** "Only with": show only the combinations that include every one of these cards. */
  only?: string[];
}

export const MOST_COPIES = 3;
export const defaultFilter = (): ComboFilter => ({ off: [], copies: {}, only: [] });

export const copiesOf = (filter: ComboFilter, id: string) => Math.min(MOST_COPIES, Math.max(1, Math.round(filter.copies[id] ?? 1)));

function split(filter: ComboFilter, ids: string[]) {
  const on = ids.filter((id) => !filter.off.includes(id));
  const only = on.filter((id) => (filter.only ?? []).includes(id));
  const free = on.filter((id) => !only.includes(id));
  const modifiers = new Set(CARD_DEFS.filter((d) => d.modifier).map((d) => d.id));
  return { on, only, free, modifiers };
}

/** How many combinations the filter allows (a modifier alone is not a combination). */
export function countCombinations(filter: ComboFilter, ids: string[] = CARD_DEFS.map((d) => d.id)): number {
  const { only, free, modifiers } = split(filter, ids);
  const all = 2 ** free.length;
  if (only.some((id) => !modifiers.has(id))) return all;
  const freeModifiers = free.filter((id) => modifiers.has(id)).length;
  return all - (2 ** freeModifiers - (only.length ? 0 : 1));
}

/**
 * Every combination of the cards that are on: fewest cards first, then in the
 * cards' own order (the order of counting in binary, as it always was). Stops
 * after `limit`.
 */
export function combinations(filter: ComboFilter, ids: string[] = CARD_DEFS.map((d) => d.id), limit = Infinity): Scenario[] {
  const { on, only, free, modifiers } = split(filter, ids);
  const out: Scenario[] = [];
  const n = free.length;
  for (let k = 0; k <= n && out.length < limit; k++) {
    // k of the free cards, in colex order: c[0] < c[1] < ... (the same order as counting masks upwards).
    const c = Array.from({ length: k }, (_, i) => i);
    for (;;) {
      const chosen = new Set([...only, ...c.map((i) => free[i])]);
      const set = on.filter((id) => chosen.has(id));
      if (set.length === 0 || set.some((id) => !modifiers.has(id))) {
        const code = set.map((id) => (copiesOf(filter, id) > 1 ? `${id}*${copiesOf(filter, id)}` : id)).join('+') || 'empty';
        out.push({ name: nameOf(code), code, cards: parseCode(code, 'cluster') });
        if (out.length >= limit) break;
      }
      // Next combination: raise the lowest index that can rise, and reset the ones below it.
      let i = 0;
      while (i < k && c[i] + 1 === (i + 1 < k ? c[i + 1] : n)) i++;
      if (i >= k) break;
      c[i]++;
      for (let j = 0; j < i; j++) c[j] = j;
    }
  }
  return out;
}
