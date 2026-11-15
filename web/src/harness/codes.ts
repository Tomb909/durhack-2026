// Combination codes: a short text saying which cards are on the table and where.
//
//   rain                     one card, in the default place
//   rain*3                   three copies side by side (also: rain_x3)
//   forest+rain+sun          several cards (also: forest_rain_sun, "forest rain sun")
//   rain*3+forest@0.8,0.6    a card at a table position: x left to right, y far to near, 0..1
//   wind~90@0.5,0.5          a card rotated 90 degrees clockwise
//   m+rai*2                  any unambiguous start of a built-in card's id
//   haunted-house+rain       a card made from a typed word, by its full id
//   empty                    no cards
//
// Card ids come from cards.json, so a new card can be used in codes straight away.
// Cards made from typed words (cards/words.ts) work too, by their full id only: the
// shorthand matches built-in cards alone, so adding MUD never makes `m+rai` ambiguous.
// (Codes split on "_", so an id containing "_" cannot be written in one.)
import { BUILT_IN_IDS, CARD_DEFS } from '../cards/defs';

export interface Placement {
  id: string;
  x: number;
  y: number;
  /** Radians clockwise from the card's printed left-to-right direction. */
  angle?: number;
}

export interface Scenario {
  name: string;
  code: string;
  cards: Placement[];
}

/** Where cards go when a code gives no position. */
export type Layout = 'cluster' | 'spread';
export const LAYOUTS: Layout[] = ['cluster', 'spread'];

/** cluster: everything together here, so the cards act on the same ground. */
const CLUSTER_CENTRE = { x: 0.4, y: 0.42 };
/** spread: each kind of card in its own place, so you see where they meet. */
const SPREAD_ANCHORS = [
  { x: 0.28, y: 0.3 }, { x: 0.62, y: 0.32 }, { x: 0.34, y: 0.68 }, { x: 0.66, y: 0.6 }, { x: 0.48, y: 0.48 }, { x: 0.5, y: 0.8 },
];
const COPY_STEP = 0.05; // copies sit side by side, this far apart
const ROW_STEP = 0.08;
const PER_ROW = 5;

interface Group {
  id: string;
  copies: number;
  angle: number | null;
  at: { x: number; y: number } | null;
}

function resolveId(token: string): string {
  // Built-in cards first, by full id and then by any unambiguous start. Only then a made card, by
  // its full id: a made card called `m` must not change what `m+wa` means.
  const builtIn = CARD_DEFS.filter((d) => BUILT_IN_IDS.has(d.id));
  const exact = builtIn.find((d) => d.id.toLowerCase() === token);
  if (exact) return exact.id;
  const starts = builtIn.filter((d) => d.id.toLowerCase().startsWith(token));
  if (starts.length === 1) return starts[0].id;
  // A built-in card by the word written on it, or another word it answers to (`hot` is the card whose id is `sun`).
  const named = starts.length ? undefined : builtIn.find((d) => [d.word, ...(d.aliases ?? [])].some((word) => word.toLowerCase() === token));
  if (named) return named.id;
  const made = CARD_DEFS.find((d) => !BUILT_IN_IDS.has(d.id) && d.id.toLowerCase() === token);
  if (made && !starts.length) return made.id;
  const known = CARD_DEFS.filter((d) => BUILT_IN_IDS.has(d.id)).map((d) => d.id).join(', ');
  throw new Error(starts.length ? `"${token}" could be ${starts.map((d) => d.id).join(' or ')}` : `no card called "${token}" (cards: ${known})`);
}

function parseGroups(code: string): Group[] {
  const groups: Group[] = [];
  for (const token of code.toLowerCase().split(/[\s+_]+/).filter(Boolean)) {
    if (token === 'empty') continue;
    const times = /^[x*](\d+)$/.exec(token);
    if (times) {
      if (!groups.length) throw new Error(`"${token}" has no card before it`);
      groups[groups.length - 1].copies *= Number(times[1]);
      continue;
    }
    const m = /^([a-z][a-z0-9-]*)(?:\*(\d+))?(?:~(-?(?:\d+(?:\.\d*)?|\.\d+)))?(?:@(\d*\.?\d+),(\d*\.?\d+))?$/.exec(token);
    if (!m) throw new Error(`cannot read "${token}" (try: rain, rain*3, wind~90@0.5,0.5)`);
    groups.push({
      id: resolveId(m[1]),
      copies: m[2] ? Number(m[2]) : 1,
      angle: m[3] === undefined ? null : Number(m[3]),
      at: m[4] ? { x: Number(m[4]), y: Number(m[5]) } : null,
    });
  }
  for (const g of groups) if (g.copies < 1 || g.copies > 24) throw new Error(`${g.id}: copies must be 1 to 24`);
  return groups;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** `count` places in rows centred on a point. */
function rowAround(centre: { x: number; y: number }, count: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const rows = Math.ceil(count / PER_ROW);
  for (let k = 0; k < count; k++) {
    const row = Math.floor(k / PER_ROW);
    const inRow = Math.min(PER_ROW, count - row * PER_ROW);
    const col = k - row * PER_ROW;
    out.push({
      x: round(clamp01(centre.x + (col - (inRow - 1) / 2) * COPY_STEP)),
      y: round(clamp01(centre.y + (row - (rows - 1) / 2) * ROW_STEP)),
    });
  }
  return out;
}

/** Turn a code into card positions. Throws with a readable message if the code is wrong. */
export function parseCode(code: string, layout: Layout = 'cluster'): Placement[] {
  const groups = parseGroups(code);
  const cards: Placement[] = [];
  const loose = groups.filter((g) => !g.at);
  // cluster: every card without a position shares one block of places.
  const shared = layout === 'cluster' ? rowAround(CLUSTER_CENTRE, loose.reduce((n, g) => n + g.copies, 0)) : [];
  let anchor = 0;
  for (const g of groups) {
    const places = g.at
      ? rowAround(g.at, g.copies)
      : layout === 'cluster'
        ? shared.splice(0, g.copies)
        : rowAround(SPREAD_ANCHORS[anchor++ % SPREAD_ANCHORS.length], g.copies);
    for (const p of places) {
      const card: Placement = { id: g.id, x: p.x, y: p.y };
      if (g.angle !== null) card.angle = (g.angle * Math.PI) / 180;
      cards.push(card);
    }
  }
  return cards;
}

/** The same code written one standard way: `rain*3+forest@0.8,0.6`. */
export function tidyCode(code: string): string {
  const groups = parseGroups(code);
  if (!groups.length) return 'empty';
  return groups.map((g) =>
    g.id + (g.copies > 1 ? `*${g.copies}` : '') + (g.angle !== null ? `~${g.angle}` : '') + (g.at ? `@${g.at.x},${g.at.y}` : ''),
  ).join('+');
}

/** A file-friendly name: `rain_x3_forest`. */
export function nameOf(code: string): string {
  const groups = parseGroups(code);
  if (!groups.length) return 'empty';
  return groups.map((g) => g.id + (g.copies > 1 ? `_x${g.copies}` : '') + (g.angle !== null ? `_${g.angle}deg` : '')).join('_');
}

function scenario(code: string, layout: Layout, name?: string): Scenario {
  return { name: name ?? nameOf(code), code: tidyCode(code), cards: parseCode(code, layout) };
}

// --- ready-made sets ---------------------------------------------------------------

/**
 * The built-in cards that do something by themselves. A modifier (BIG) only changes a card beside it,
 * so it is left out of the ready-made sets: write it in a code (`big+mountain`) to see it. Cards made
 * from typed words have their own set (`words`), so the others stay the same size and the same worlds.
 */
const ids = () => CARD_DEFS.filter((d) => !d.modifier && BUILT_IN_IDS.has(d.id)).map((d) => d.id);
/** The cards mixed in every-combination sets. A compound card (one that is already a mix of simpler cards) is left out: each card here doubles the list. */
const mixable = () => CARD_DEFS.filter((d) => !d.modifier && !d.compound && BUILT_IN_IDS.has(d.id)).map((d) => d.id);
/** Cards made from typed words, in the order they were made. */
const wordIds = () => CARD_DEFS.filter((d) => !BUILT_IN_IDS.has(d.id)).map((d) => d.id);

/** Every way of choosing cards, one copy each: 2^n codes, fewest cards first. */
function subsets(): string[] {
  const all = mixable();
  const out: string[][] = [];
  for (let mask = 0; mask < 1 << all.length; mask++) out.push(all.filter((_, i) => mask & (1 << i)));
  out.sort((a, b) => a.length - b.length);
  return out.map((s) => s.join('+') || 'empty');
}

function pairs(): string[] {
  const all = mixable();
  const out: string[] = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) out.push(`${all[i]}+${all[j]}`);
  return out;
}

/** The hand-picked tour of what the rules can do. */
const SHOWCASE: [code: string, name?: string][] = [
  ['empty'], ['mountain'], ['mountain*3'], ['rain'], ['rain*3'], ['sun'], ['ice'], ['mountain+ice'], ['rain+ice'],
  ['rain+sun'], ['forest'], ['forest+rain'], ['forest+rain+sun'], ['forest+rain+ice'], ['forest+sun'], ['mountain+rain'],
  ['lake'], ['big+lake'], ['lake+ice'], ['river'],
  ['mountain@0.25,0.5+river@0.5,0.5', 'river_from_the_mountain'],
  ['mountain@0.15,0.4+river@0.45,0.5+lake@0.7,0.55+forest@0.6,0.35', 'river_through_a_lake'],
  ['civilization'], ['civilization*2'], ['civilization*3'], ['civilization+rain+forest'],
  ['civilization@0.15,0.5+civilization*2@0.5,0.45+civilization*3@0.85,0.5+rain@0.5,0.75', 'village_town_city'],
  ['big+mountain'],
  ['ravine'], ['ravine*3'], ['ravine+rain'], ['ravine+rain*3'], ['mountain+ravine'], ['lava'], ['lava+ravine'], ['lava+rain'], ['lava+ice'],
  ['mountain@0.25,0.4+lava@0.7,0.55', 'lava_far_from_the_mountain'],
  // MOUNTAIN next to LAVA is a volcano.
  ['mountain+lava', 'volcano'], ['mountain+lava+rain', 'volcano_rain'], ['mountain+lava+forest+rain', 'volcano_forest_rain'], ['mountain+lava+ice', 'volcano_ice'],
  ['big+mountain+lava', 'big_volcano'], ['mountain*2+lava', 'volcano_by_a_mountain'], ['mountain+lava+rain*3', 'volcano_rain_x3'],
  ['mountain@0.42,0.5+lava@0.48,0.5+ravine@0.62,0.5', 'volcano_by_ravine'],
  ['mountain@0.27,0.45+lava@0.33,0.45+mountain@0.67,0.55+lava@0.73,0.55', 'two_volcanoes'],
];

export const SETS: Record<string, () => [code: string, name?: string][]> = {
  showcase: () => SHOWCASE,
  singles: () => [['empty'], ...ids().map((id): [string] => [id])],
  pairs: () => pairs().map((c): [string] => [c]),
  subsets: () => subsets().map((c): [string] => [c]),
  copies: () => ids().flatMap((id) => [1, 2, 3].map((n): [string] => [n > 1 ? `${id}*${n}` : id])),
  all: () => [...SETS.subsets(), ...SETS.copies(), ...SHOWCASE],
  /** Every card made from a typed word, alone. */
  words: () => wordIds().map((id): [string] => [id]),
  /** Every card made from a typed word beside rain, a mountain, and forest with rain: does it find its place? */
  'words-mixed': () => wordIds().flatMap((id): [string][] => [[`${id}+rain*3`], [`${id}+mountain`], [`${id}+forest+rain`]]),
};

export interface ScenarioRequest {
  /** One or more set names, comma separated. */
  set?: string | null;
  /** Codes separated by ";" or "|" or new lines. Each may be given a name: `wet=rain*3`. */
  codes?: string | null;
  layout?: Layout;
}

/** The list of worlds to make. Repeats are dropped. With nothing asked for, the showcase. */
export function resolveScenarios(request: ScenarioRequest): Scenario[] {
  const layout = request.layout ?? 'cluster';
  const wanted: [string, string?][] = [];
  for (const name of (request.set ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const make = SETS[name];
    if (!make) throw new Error(`no set called "${name}" (sets: ${Object.keys(SETS).join(', ')})`);
    wanted.push(...make());
  }
  for (const part of (request.codes ?? '').split(/[;|\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const named = /^([\w-]+)=(.*)$/.exec(part);
    wanted.push(named ? [named[2], named[1]] : [part]);
  }
  if (!wanted.length) wanted.push(...SHOWCASE);
  const seen = new Set<string>();
  const out: Scenario[] = [];
  for (const [code, name] of wanted) {
    const s = scenario(code, layout, name);
    if (seen.has(s.code)) continue;
    seen.add(s.code);
    out.push(s);
  }
  return out;
}
