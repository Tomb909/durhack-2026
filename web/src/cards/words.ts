// Any word becomes a card. Type a word or phrase and this finds or makes its card:
//
//   1. a built-in card, by word or alias        (no new card)
//   2. a card already made and stored            (instant)
//   3. the model, through the Python server      (a few seconds; stored there)
//   4. a near match: a known word a letter or two away   (a guess)
//   5. the abstract fallback, from the sound of the word  (a guess; always answers)
//
// Whatever the source, a card passes through cleanCard before it is registered:
// the one gate between untrusted data and the sim, the shaders and the page.
// Guesses are kept in this browser only, so trying again later can replace them.
import {
  BUILT_IN_IDS, CARD_DEFS, HABITATS, LAND_SHAPES, PART_MIRRORS, PART_SHAPES, PARTICLE_MOTIONS, PROP_COUNTS, PROP_MOTIONS, PROP_SCALES,
  cardDef, cardsChanged, registerCard, unregisterCard,
  type Atmosphere, type Biome, type CardDef, type CardEffect, type FieldName, type Particles, type Prop, type PropPart,
} from './defs';

export const MAX_WORD = 40;
const MAX_READING = 200;
/** Parts as written, and primitives once mirrors and repeats are drawn out. */
export const MAX_PARTS = 100;
export const MAX_PRIMITIVES = 400;
const MAX_REPEAT = 12;

/** How many primitives a part draws: itself, round the axis, and mirrored. */
export const copiesOf = (part: PropPart): number => (part.repeat ?? 1) * (part.mirror === 'xz' ? 4 : part.mirror ? 2 : 1);

/** The scale word for a real size in metres (keep in step with scale_for in server/deck/words.py). */
export const scaleForMetres = (m: number): Prop['scale'] => (m < 4 ? 'small' : m < 15 ? 'medium' : m < 45 ? 'large' : 'landmark');
const MAX_EFFECTS = 6;
const LOCAL_STORE = 'deck.words.1';

// --- words and ids ------------------------------------------------------------------

/** Trim, collapse spaces, at most 40 characters, capitals. Markup characters go. */
export function normaliseWord(text: string): string {
  const clean = String(text ?? '')
    .replace(/[<>&"'`\\{}\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return [...clean].slice(0, MAX_WORD).join('').trim();
}

/** FNV-1a over the UTF-8 bytes, as 8 hex digits. The server computes the same. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A card id that fits the code grammar ([a-z][a-z0-9-]*): `haunted house` is
 * `haunted-house`, `café` is `cafe`. A word with no Latin letters gets a stable
 * id from a hash. Keep in step with word_id() in server/deck/words.py.
 */
export function wordId(text: string): string {
  const word = normaliseWord(text);
  const latin = word.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/[a-z]/.test(latin)) return `w-${hashText(word)}`;
  let id = latin.slice(0, MAX_WORD).replace(/-+$/, '');
  // Codes read "empty" and "x3" as words of their own, and an id must start with a letter.
  if (!/^[a-z]/.test(id) || id === 'empty' || /^x\d+$/.test(id)) id = `w-${id}`;
  return id;
}

// --- the one gate ---------------------------------------------------------------------

const num = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
/**
 * A colour as #rrggbb. Models also write `c8d3de`, ` #cfc6b4` and `#abc`: those are read as the
 * colours they plainly are (a card whose every part fell back to grey was the alternative).
 */
const colour = (v: unknown, fallback: string): string => {
  const hex = typeof v === 'string' ? /^\s*#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\s*$/.exec(v)?.[1] : undefined;
  if (!hex) return fallback;
  return `#${hex.length === 3 ? hex.replace(/./g, '$&$&') : hex}`.toLowerCase();
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
/** Plain text only: no markup characters, no control characters, bounded. */
const plain = (v: unknown, max: number): string =>
  [...String(typeof v === 'string' ? v : '').replace(/[<>&"'`\\{}\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
const triple = (v: unknown, lo: number, hi: number, fallback: number): [number, number, number] => {
  const a = Array.isArray(v) ? v : [];
  return [num(a[0], lo, hi, fallback), num(a[1], lo, hi, fallback), num(a[2], lo, hi, fallback)];
};

/** How far each field may be pushed by one copy of a generated card. (Lakes, towns and cities are left to the built-in cards.) */
const FIELD_LIMITS: Partial<Record<FieldName, [number, number]>> = {
  height: [-0.4, 0.6],
  temperature: [-0.9, 0.9],
  wetness: [-0.9, 0.9],
  forest: [-1, 1],
  settlement: [0, 1],
  lava: [0, 1.2],
  seaLevel: [-0.015, 0.02],
};

/** A round patch fades out over about three times its radius, so it is kept small; a shape ends at its radius. */
const PATCH_RADIUS: [number, number] = [0.05, 0.3];
const SHAPE_RADIUS: [number, number] = [0.04, 0.6];

function cleanEffects(v: unknown): CardEffect[] {
  if (!Array.isArray(v)) return [];
  const out: CardEffect[] = [];
  for (const e of v.slice(0, 16)) {
    if (!e || typeof e !== 'object' || out.length >= MAX_EFFECTS) continue;
    const r = e as Record<string, unknown>;
    // Cards made before a field was renamed still say `people`; the word server still says `life`.
    const named = r.field === 'people' ? 'settlement' : r.field === 'life' ? 'forest' : r.field;
    // Own names only: `constructor` or `toString` is not a field, though `in` would say it is.
    if (!(typeof named === 'string' && Object.hasOwn(FIELD_LIMITS, named))) continue;
    const field = named as FieldName;
    const [lo, hi] = FIELD_LIMITS[field]!;
    const amount = num(r.amount, lo, hi, 0);
    if (amount === 0) continue;
    // Sea level is the one world-wide push; the sim ignores "global" on anything else.
    if (field === 'seaLevel') {
      out.push({ field, amount, global: true });
      continue;
    }
    const shape = LAND_SHAPES.includes(r.shape as never) ? (r.shape as CardEffect['shape']) : undefined;
    const [near, far] = shape ? SHAPE_RADIUS : PATCH_RADIUS;
    out.push({ field, amount, radius: num(r.radius, near, far, 0.18), ...(shape ? { shape } : {}) });
  }
  return out;
}

function cleanParticles(v: unknown): Particles | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!PARTICLE_MOTIONS.includes(r.motion as never)) return null;
  const density = num(r.density, 0, 1, 0);
  if (density <= 0) return null;
  return {
    motion: oneOf(r.motion, PARTICLE_MOTIONS, 'drift'),
    color: colour(r.color, '#ffffff'),
    size: num(r.size, 0, 1, 0.4),
    density,
    glow: r.glow === true,
  };
}

/**
 * The card's biome. Cards made before biomes carry `ground` (one colour painted on the land):
 * that is read as a biome with only its ground colour.
 */
function cleanBiome(v: unknown, old: unknown): Biome | undefined {
  const given = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  const before = old && typeof old === 'object' ? (old as Record<string, unknown>) : null;
  const r = given ?? before;
  if (!r) return undefined;
  const strength = num(r.strength, 0, 1, 0);
  if (strength <= 0) return undefined;
  const biome: Biome = {
    radius: num(r.radius, 0.05, 0.6, 0.2),
    strength,
    ground: colour(given ? r.ground : r.color, '#8a8378'),
    trees: r.trees !== false,
  };
  const plants = colour(r.plants, '');
  if (plants) biome.plants = plants;
  const rock = colour(r.rock, '');
  if (rock) biome.rock = rock;
  const liquid = r.liquid && typeof r.liquid === 'object' ? (r.liquid as Record<string, unknown>) : null;
  const liquidColour = colour(liquid?.color, '');
  if (liquidColour) biome.liquid = { color: liquidColour, glow: num(liquid?.glow, 0, 1, 0) };
  return biome;
}

function cleanAtmosphere(v: unknown): Atmosphere | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const air: Atmosphere = {
    tint: colour(r.tint, '#ffffff'),
    strength: num(r.strength, 0, 1, 0),
    light: num(r.light, -1, 1, 0),
    particles: cleanParticles(r.particles),
  };
  return air.strength > 0 || air.light !== 0 || air.particles ? air : undefined;
}

function cleanPart(v: unknown): PropPart | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!PART_SHAPES.includes(r.shape as never)) return null;
  const size = triple(r.size, 0.01, 1, 0.2);
  const part: PropPart = {
    shape: r.shape as PropPart['shape'],
    at: [num((r.at as unknown[] | undefined)?.[0], -0.5, 0.5, 0), num((r.at as unknown[] | undefined)?.[1], 0, 1, size[1] / 2), num((r.at as unknown[] | undefined)?.[2], -0.5, 0.5, 0)],
    size,
    rotate: triple(r.rotate, -180, 180, 0),
    color: colour(r.color, '#9a8f80'),
  };
  // Only the shapes with a flat top take a taper; left out when it would change nothing.
  const taper = num(r.taper, 0, 2, 1);
  if (taper !== 1 && (part.shape === 'box' || part.shape === 'cylinder')) part.taper = taper;
  if (PART_MIRRORS.includes(r.mirror as never)) part.mirror = r.mirror as PropPart['mirror'];
  const repeat = Math.round(num(r.repeat, 1, MAX_REPEAT, 1));
  if (repeat > 1) part.repeat = repeat;
  return part;
}

function cleanProp(v: unknown): Prop | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const parts = (Array.isArray(r.parts) ? r.parts.slice(0, MAX_PARTS * 2) : []).map(cleanPart).filter((p): p is PropPart => !!p).slice(0, MAX_PARTS);
  if (!parts.length) return undefined;
  // Mirrors and repeats multiply. Every part is kept; past the limit, the later ones lose their copies.
  let drawn = 0;
  parts.forEach((part, k) => {
    if (drawn + copiesOf(part) > MAX_PRIMITIVES - (parts.length - k - 1)) { delete part.mirror; delete part.repeat; }
    drawn += copiesOf(part);
  });
  const metres = typeof r.metres === 'number' && Number.isFinite(r.metres) ? Math.min(400, Math.max(0.1, r.metres)) : undefined;
  return {
    parts,
    scale: metres === undefined ? oneOf(r.scale, PROP_SCALES, 'medium') : scaleForMetres(metres),
    ...(metres === undefined ? {} : { metres }),
    count: oneOf(r.count, PROP_COUNTS, 'one'),
    habitat: oneOf(r.habitat, HABITATS, 'land'),
    motion: oneOf(r.motion, PROP_MOTIONS, 'still'),
    glow: r.glow === true,
  };
}

/** One emoji or a few plain characters for the label; nothing that could be markup. */
function cleanIcon(v: unknown): string {
  const icon = [...plain(v, 8)].slice(0, 4).join('');
  return icon || '✦';
}

/**
 * The one gate. Every card made from a word passes through here before it is
 * registered, whatever its source. Input is treated as hostile: every number is
 * clamped, every list limited, colours must be #rrggbb, unknown shapes and fields
 * are dropped, and text loses its markup characters. The id always comes from the
 * word, so a card cannot claim a built-in card's id.
 */
export function cleanCard(input: unknown): CardDef | null {
  if (!input || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  const word = normaliseWord(plain(r.word, MAX_WORD * 2));
  if (!word) return null;
  const id = wordId(word);
  if (BUILT_IN_IDS.has(id)) return null;
  const def: CardDef = {
    id,
    word,
    icon: cleanIcon(r.icon),
    color: colour(r.color, '#c8c0b0'),
    effects: cleanEffects(r.effects),
    origin: r.origin === 'llm' ? 'llm' : 'fallback',
    reading: plain(r.reading, MAX_READING),
  };
  const atmosphere = cleanAtmosphere(r.atmosphere);
  if (atmosphere) def.atmosphere = atmosphere;
  const biome = cleanBiome(r.biome, r.ground);
  if (biome) def.biome = biome;
  const prop = cleanProp(r.prop);
  if (prop) def.prop = prop;
  const ms = num(r.ms, 0, 600_000, Number.NaN);
  if (Number.isFinite(ms)) def.ms = Math.round(ms);
  // Every word shows something: a card that would do nothing gets the abstract shape instead.
  // (The fallback always has an object, so this cannot loop.)
  if (!def.effects.length && !def.atmosphere && !def.biome && !def.prop) return cleanCard(fallbackCard(word));
  return def;
}

/** True for a card that was guessed rather than read by the model. */
export const isGuess = (def: CardDef) => def.origin === 'fallback';

// --- the abstract fallback (bouba / kiki) -------------------------------------------

// The letters people hear as sharp and as soft. The rest (a, c, e, h, n, r, s…) lean neither way,
// so ordinary words spread across spiky, blocky and round instead of all landing on one.
const SPIKY = new Set('ktzxivwyfj');
const ROUND = new Set('bomuldgq');
const VOWELS = new Set('aeiouy');

/** A small seeded random source (mulberry32), so the same word always gives the same shape. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hsl(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** How spiky (+1) or round (-1) a word sounds, and how open (share of vowels). */
export function wordSound(word: string): { spike: number; open: number; letters: number } {
  const letters = [...word.toLowerCase().normalize('NFKD')].filter((c) => /[a-z]/.test(c));
  if (!letters.length) {
    // No Latin letters: the look of the word is unknown to us, so the hash decides.
    const h = parseInt(hashText(word), 16);
    return { spike: ((h & 0xff) / 255) * 2 - 1, open: ((h >>> 8) & 0xff) / 255, letters: Math.max(2, [...word].length * 2) };
  }
  let spike = 0;
  for (const c of letters) spike += SPIKY.has(c) ? 1 : ROUND.has(c) ? -1 : 0;
  return { spike: spike / letters.length, open: letters.filter((c) => VOWELS.has(c)).length / letters.length, letters: letters.length };
}

/**
 * A card from the sound and look of the word alone. Knows nothing of meaning:
 * spiky letters give cones and hot bright colours, round letters give spheres
 * and cool pale ones; length sets height and number of parts; vowels set how
 * open it is; a hash sets the hue. Same word, same card.
 */
export function fallbackCard(text: string): CardDef {
  const word = normaliseWord(text) || '?';
  const { spike, open, letters } = wordSound(word);
  const hash = parseInt(hashText(word), 16);
  const random = seeded(hash);
  // Clearly one or the other, or in between (blocks and drums).
  const spiky = spike > 0.25;
  const round = spike < -0.25;
  const sharp = Math.max(0, spike);
  const soft = Math.max(0, -spike);
  // Hue: spiky words lean to red-orange-yellow, round ones to teal-blue-violet; the hash picks where.
  const pick = (hash >>> 16) / 65536;
  const hue = spiky ? -15 + 70 * pick : round ? 175 + 95 * pick : 360 * pick;
  const sat = 0.5 + 0.35 * sharp - 0.2 * soft;
  const light = 0.5 + 0.06 * sharp + 0.16 * soft;
  const main = hsl(hue, sat, light);
  const second = hsl(hue + (spike > 0 ? 25 : -30), sat * 0.85, Math.min(0.82, light + 0.1));
  const dark = hsl(hue + 10, sat * 0.6, light * 0.55);

  const count = Math.round(Math.min(12, Math.max(4, 2 + letters * 0.9)));
  const tall = Math.min(1, 0.62 + letters * 0.05);
  const spread = 0.12 + 0.26 * open; // open words stand apart, closed ones huddle
  const parts: PropPart[] = [];
  // A plinth, so it reads as made and placed rather than grown.
  parts.push({ shape: spiky ? 'box' : 'cylinder', at: [0, 0.04, 0], size: [0.7, 0.08, 0.7], rotate: [0, 45 * sharp, 0], color: dark });
  for (let k = 0; k < count - 1; k++) {
    const angle = (k / (count - 1)) * Math.PI * 2 + random() * 0.8;
    const r = k === 0 ? 0 : spread * (0.55 + 0.45 * random());
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const color = k % 3 === 2 ? second : main;
    if (spiky) {
      // Spiky: shards. Tall thin cones and pyramids, leaning out at sharp angles.
      const h = tall * (k === 0 ? 0.92 : 0.35 + 0.5 * random());
      const w = 0.1 + 0.12 * random();
      const lean = k === 0 ? 0 : 12 + 26 * random();
      parts.push({
        shape: k % 2 ? 'pyramid' : 'cone', at: [x, 0.08 + h / 2, z], size: [w, h, w],
        rotate: [Math.sin(angle) * lean, random() * 90, -Math.cos(angle) * lean], color,
      });
    } else if (round) {
      // Round: soft stacked spheres, a pebble cairn.
      const s = (k === 0 ? 0.42 : 0.18 + 0.18 * random()) * (0.8 + 0.4 * tall);
      const y = k === 0 ? 0.08 + s * 0.45 : 0.08 + s * 0.4 + random() * tall * 0.55;
      parts.push({ shape: 'sphere', at: [x * 0.8, Math.min(1 - s / 2, y), z * 0.8], size: [s * 1.1, s * 0.85, s * 1.1], rotate: [0, 0, 0], color });
    } else {
      // In between: blocks and drums, stacked like a small totem.
      const h = 0.12 + 0.2 * random();
      const w = 0.16 + 0.16 * random();
      const y = 0.08 + (k === 0 ? tall * 0.45 : random() * tall * 0.7);
      parts.push({ shape: k % 2 ? 'cylinder' : 'box', at: [x, Math.min(1 - h / 2, y), z], size: [w, k === 0 ? tall * 0.9 : h, w], rotate: [0, random() * 90, 0], color });
    }
  }
  return {
    id: wordId(word),
    word,
    icon: spiky ? '✴️' : round ? '🫧' : '✳️',
    color: main,
    effects: [],
    atmosphere: {
      tint: main,
      strength: 0.12 + 0.08 * Math.abs(spike),
      light: 0,
      particles: { motion: spiky ? 'rise' : 'drift', color: second, size: 0.25 + 0.2 * soft, density: 0.35, glow: spiky },
    },
    // Large: the sculpture is all a guess has to show, so it must read from across the table.
    prop: { parts, scale: letters > 9 ? 'landmark' : 'large', count: 'one', habitat: 'land', motion: 'still', glow: false },
    origin: 'fallback',
    reading: `Not read: an abstract ${spiky ? 'spiky' : round ? 'rounded' : 'blocky'} shape from the sound of the word.`,
  };
}

// --- near matches -----------------------------------------------------------------------

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = keep;
    }
  }
  return prev[b.length];
}

/** A known card whose word is a letter or two away (volcanoe → VOLCANO), or none. Guesses do not count. */
export function nearMatch(text: string): CardDef | null {
  const word = normaliseWord(text);
  if ([...word].length < 4) return null;
  const allowed = word.length <= 5 ? 1 : 2;
  let best: CardDef | null = null;
  let bestDistance = allowed + 1;
  for (const def of CARD_DEFS) {
    if (def.modifier || isGuess(def)) continue;
    for (const known of [def.word, ...(def.aliases ?? [])]) {
      const d = editDistance(word, known.toUpperCase());
      if (d > 0 && d < bestDistance) {
        best = def;
        bestDistance = d;
      }
    }
  }
  return best;
}

/** A card by its word, id or alias, built-in or already made. */
export function findCard(text: string): CardDef | null {
  const word = normaliseWord(text);
  if (!word) return null;
  const id = wordId(word);
  return CARD_DEFS.find((d) => d.id === id || d.word === word || (d.aliases ?? []).includes(word)) ?? null;
}

// --- where a word's card comes from -------------------------------------------------------

export type Source = 'built-in' | 'stored' | 'model' | 'near' | 'fallback';

export interface Resolved {
  def: CardDef;
  source: Source;
  /** The model could not be asked, or did not answer: why, in plain words. */
  why?: string;
  ms: number;
}

/** Asks the server for a card. Swappable in tests. */
export type AskServer = (text: string, fresh: boolean) => Promise<{ card: unknown; source: string; ms: number }>;

export const askServer: AskServer = async (text, fresh) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50_000);
  try {
    const response = await fetch('/api/word', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, fresh }), signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    // A reply without a reason is not our server talking (the dev server's proxy with nothing behind it, say).
    if (!response.ok) throw new Error(typeof body.reason === 'string' ? body.reason : 'no server');
    return body;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error('no answer in time');
    if (error instanceof TypeError) throw new Error('no server');
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Find or make the card for a typed word, in the order at the top of this file.
 * `fresh` skips straight to asking the model again (Try again). Always answers.
 */
export async function resolveWord(text: string, options: { fresh?: boolean; ask?: AskServer } = {}): Promise<Resolved> {
  const started = performance.now();
  const word = normaliseWord(text);
  if (!word) throw new Error('Type a word first');
  const ask = options.ask ?? askServer;
  const elapsed = () => Math.round(performance.now() - started);

  if (!options.fresh) {
    const known = findCard(word);
    // A guess is not an answer: the model may be reachable now.
    if (known && !isGuess(known)) return { def: known, source: BUILT_IN_IDS.has(known.id) ? 'built-in' : 'stored', ms: elapsed() };
  }
  let why = '';
  try {
    const reply = await ask(word, !!options.fresh);
    const def = cleanCard({ ...(reply.card as object), word, origin: 'llm', ms: reply.ms });
    if (def && def.origin === 'llm') {
      register(def);
      return { def, source: reply.source === 'store' ? 'stored' : 'model', ms: elapsed() };
    }
    why = 'the reply was not a usable card';
  } catch (error) {
    why = (error as Error).message || 'the model could not be reached';
  }
  // A guess never takes the place of a card the model has already made: this ask may have been a
  // second one for the same word (Try again, or the same word typed in the other box).
  const made = findCard(word);
  if (made && !isGuess(made)) return { def: made, source: BUILT_IN_IDS.has(made.id) ? 'built-in' : 'stored', why, ms: elapsed() };
  const near = nearMatch(word);
  if (near) return { def: near, source: 'near', why, ms: elapsed() };
  const guess = cleanCard({ ...fallbackCard(word), ms: elapsed() })!;
  register(guess);
  return { def: guess, source: 'fallback', why, ms: elapsed() };
}

// --- keeping cards: the server's store, and a copy in this browser --------------------------

function readLocal(): unknown[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_STORE) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return []; // storage blocked or spoiled: start empty
  }
}

function writeLocal(): void {
  try {
    const mine = CARD_DEFS.filter((d) => !BUILT_IN_IDS.has(d.id));
    localStorage.setItem(LOCAL_STORE, JSON.stringify(mine));
  } catch {
    /* storage blocked: the cards last until the page is reloaded */
  }
}

/** Register a card and keep a copy in this browser, so it survives a reload with the server off. */
export function register(def: CardDef, quiet = false): void {
  registerCard(def, quiet);
  writeLocal();
}

/** Remove a made card here (the server's stored copy stays, so typing the word again is instant). */
export function removeWord(id: string): void {
  unregisterCard(id);
  writeLocal();
}

/** Asks the server to forget its stored cards. Swappable in tests. */
export type ForgetServer = () => Promise<void>;

export const forgetServer: ForgetServer = async () => {
  const response = await fetch('/api/words', { method: 'DELETE' });
  const body = await response.json().catch(() => null);
  // An answer without a count is not our server talking (the dev server with nothing behind it, say).
  if (!response.ok || typeof body?.removed !== 'number') throw new Error('no server');
};

/**
 * Forget every card made from a typed word: here, in this browser's copy, and in the server's
 * store, so each word is read afresh the next time it is typed. Built-in cards stay.
 * `server` is false when the server could not be told: its stored cards will come back on a reload.
 */
export async function forgetWords(forget: ForgetServer = forgetServer): Promise<{ removed: number; server: boolean }> {
  const server = await forget().then(() => true, () => false);
  const made = CARD_DEFS.filter((d) => !BUILT_IN_IDS.has(d.id)).map((d) => d.id);
  for (const id of made) unregisterCard(id);
  writeLocal();
  return { removed: made.length, server };
}

/** Register a list of stored cards, each through the gate. Returns how many were taken. */
export function loadCards(list: unknown, quiet = true): number {
  if (!Array.isArray(list)) return 0;
  let taken = 0;
  for (const raw of list.slice(0, 500)) {
    const def = cleanCard(raw);
    if (!def) continue;
    // A guess never replaces a card the model made.
    const existing = cardDef(def.id);
    if (existing && !isGuess(existing) && isGuess(def)) continue;
    registerCard(def, true);
    taken++;
  }
  if (!quiet && taken) cardsChanged(); // one notice for the lot
  return taken;
}

/** Register the abstract fallback for each of these words (comma separated): for drawing them in the harness. */
export function guessCards(words: string): string[] {
  const ids: string[] = [];
  for (const word of words.split(',')) {
    const def = cleanCard(fallbackCard(word));
    if (def && !cardDef(def.id)) registerCard(def, true);
    if (def) ids.push(def.id);
  }
  cardsChanged();
  return ids;
}

/** Stored cards from the server, or from the dev server's read-only copy when the Python server is off. */
async function fetchStored(): Promise<unknown[] | null> {
  for (const url of ['/api/words', '/__harness/words']) {
    // A server that takes the connection and then says nothing must not hold up the page.
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(), 4000);
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: giveUp.signal });
      if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) continue;
      const body = await response.json();
      if (body && Array.isArray(body.cards)) return body.cards;
    } catch {
      /* not there, or too slow: try the next */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * At startup: the cards kept in this browser, then the server's stored cards over
 * them (a model's card beats a guess). Never throws; the page works with neither.
 */
export async function loadStoredCards(options: { local?: boolean } = {}): Promise<number> {
  let taken = options.local === false ? 0 : loadCards(readLocal());
  const stored = await fetchStored();
  if (stored) taken += loadCards(stored);
  if (taken) {
    if (options.local !== false) writeLocal();
    cardsChanged(); // tell the listeners once
  }
  return taken;
}
