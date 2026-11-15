// Cards that make something else when they lie next to each other.
//
//   MOUNTAIN + LAVA            a volcano: the mountain stays, and gets a crater at its top
//   CIVILIZATION               a village
//   CIVILIZATION x 2           a town, between them
//   CIVILIZATION x 3 or more   a city, in the middle of them, with a district at every card:
//                              a long line of cards is a long city
//   LAKE x 2 or more           one bigger lake, in the middle of them
//
// The world and the picture never see the cards that went in (but for the mountain under a
// volcano): `combine` hands them the volcano, village, town or city, as cards of their own (the `MADE` definitions
// below, which are not in cards.json, so nobody can write or drag one). Everything here
// is smooth in where the cards are and how strong they are, so sliding a card towards
// another grows the new thing; it does not pop in.
import type { CardDef } from './defs';
import type { LiveCard } from './store';

/**
 * How close is "next to": joined within `full`, apart beyond `none` (shares of the table's width).
 * The band between them is narrow on purpose: it is only there so that a card sliding in fades
 * from the one to the other, and a card left lying in it shows a faint mix of both.
 */
export const NEXT_TO = { full: 0.26, none: 0.3 };

const TABLE_ASPECT = 420 / 297;

/**
 * What the recipes make. Plain card data, like cards.json.
 * The volcano is only the top of one: a summit cone with a crater, sized to stand on a MOUNTAIN.
 */
export const MADE: Record<'volcano' | 'village' | 'town' | 'city' | 'district', CardDef> = {
  volcano: {
    id: 'volcano', word: 'VOLCANO', icon: '🌋', color: '#d9482b',
    effects: [
      {
        field: 'height', amount: 0.2, radius: 0.13,
        cone: { crater: 0.24, craterDepth: 0.42, power: 2.0, gullies: 10, gullyDepth: 0.22, notches: 4, notchDepth: 0.38, lava: 60 },
      },
      { field: 'lava', amount: 1.6, radius: 0.014 },
      { field: 'temperature', amount: 0.45, radius: 0.065 },
      { field: 'temperature', amount: 0.4, radius: 0.03 },
      { field: 'wetness', amount: -1.0, radius: 0.04 },
    ],
  },
  // Three sizes: a town covers about twice the ground a village does. A city is its middle (below)
  // and a district at each of its cards: three cards huddled together cover about three times a
  // village's ground, and it grows from there with every card and with how far out they lie.
  village: {
    id: 'village', word: 'VILLAGE', icon: '🏠', color: '#e8743b',
    effects: [{ field: 'settlement', amount: 1.0, radius: 0.13 }],
  },
  town: {
    id: 'town', word: 'TOWN', icon: '⛪', color: '#e0553a',
    effects: [
      { field: 'settlement', amount: 1.3, radius: 0.16 },
      { field: 'town', amount: 1.0, radius: 0.1 },
      { field: 'plaza', amount: 1.0, radius: 0.026 },
    ],
  },
  city: {
    id: 'city', word: 'CITY', icon: '🏰', color: '#c9413f',
    effects: [
      { field: 'settlement', amount: 1.6, radius: 0.13 },
      { field: 'city', amount: 1.0, radius: 0.11 },
      { field: 'plaza', amount: 1.0, radius: 0.048 },
    ],
  },
  // A city's streets round each of its cards, so the city reaches as far as the cards do.
  district: {
    id: 'district', word: 'CITY', icon: '🏰', color: '#c9413f',
    effects: [
      { field: 'settlement', amount: 1.0, radius: 0.13 },
      { field: 'city', amount: 1.0, radius: 0.09 },
    ],
  },
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 1 when two cards lie next to each other, 0 when they are apart, smooth in between. */
export function nextTo(a: LiveCard, b: LiveCard): number {
  const d = Math.hypot(b.x - a.x, (b.y - a.y) / TABLE_ASPECT);
  const t = clamp01((NEXT_TO.none - d) / (NEXT_TO.none - NEXT_TO.full));
  return t * t * (3 - 2 * t);
}

function made(def: CardDef, key: string, from: LiveCard, x: number, y: number, strength: number): LiveCard {
  return { ...from, key, def, x, y, tx: x, ty: y, vx: 0, vy: 0, strength, fade: strength };
}

/**
 * The cards as the world sees them: recipes carried out, every other card passed on untouched.
 * With `decided`, nothing is half way: cards in the band between "next to" and "apart" count as
 * whichever they are nearer to. That is for naming things (a label says TOWN or VILLAGE, not both).
 */
export function combine(cards: readonly LiveCard[], decided = false): LiveCard[] {
  const out: LiveCard[] = [];
  const mountains: LiveCard[] = [];
  const lavas: LiveCard[] = [];
  const people: LiveCard[] = [];
  const water: LiveCard[] = [];
  for (const card of cards) {
    const id = card.def.id;
    if (card.strength <= 0) out.push(card);
    else if (id === 'mountain') mountains.push(card);
    else if (id === 'lava') lavas.push(card);
    else if (id === 'civilization') people.push(card);
    else if (id === 'lake') water.push(card);
    else out.push(card);
  }
  volcanoes(mountains, lavas, out);
  settlements(people, out, decided);
  lakes(water, out);
  return out;
}

/** Each LAKE card past the first makes the one lake this much wider (the same as a BIG card), up to `most`. */
const LAKE_GROWTH = { each: 0.5, most: 2.5 };

/**
 * LAKE cards that lie next to each other (joined up the same way as CIVILIZATION cards, below)
 * are one bigger lake, in the middle of them.
 */
function lakes(water: LiveCard[], out: LiveCard[]): void {
  const n = water.length;
  if (n < 2) {
    out.push(...water);
    return;
  }
  // Joined or not, never half way: a half-dug basin holds no water, and three of them overlapping
  // (the two lakes and the one) left dry ground where there should be a lake. The world eases
  // from the one shape to the other by itself.
  const near = water.map((a) => water.map((b) => Math.round(nextTo(a, b))));
  const lines = [1];
  const bodies = new Map<string, LiveCard>();
  let below = 0;
  for (const line of lines) {
    const share = line - below;
    below = line;
    const group = water.map((_, i) => i);
    const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (near[i][j] >= line) group[find(i)] = find(j);
    const members = new Map<number, LiveCard[]>();
    water.forEach((card, i) => {
      const list = members.get(find(i));
      if (list) list.push(card);
      else members.set(find(i), [card]);
    });
    for (const cards of members.values()) {
      // A card still fading in counts for part of one, and pulls the middle less.
      let size = 0, x = 0, y = 0;
      for (const card of cards) {
        size += card.strength;
        x += card.strength * card.x;
        y += card.strength * card.y;
      }
      x /= size;
      y /= size;
      const strength = share * Math.min(1, size);
      const key = cards.length === 1 ? cards[0].key : `lake:${cards.map((c) => c.key).join('+')}`;
      const old = bodies.get(key);
      if (old) {
        old.strength = old.fade = Math.min(1, old.strength + strength);
        continue;
      }
      const wider = Math.min(LAKE_GROWTH.most, 1 + LAKE_GROWTH.each * Math.max(0, size - 1));
      const def = cards[0].def;
      const grown = wider === 1 ? def : { ...def, effects: def.effects.map((e) => (e.field === 'lake' ? { ...e, radius: (e.radius ?? 0.075) * wider } : e)) };
      bodies.set(key, made(grown, key, cards[0], x, y, strength));
    }
  }
  out.push(...bodies.values());
}

/**
 * Each LAVA next to a MOUNTAIN turns it into a volcano: the nearest pairs first, one lava to one
 * mountain. The mountain stays as it is, and as they close in a crater grows at its top while the
 * lava welling at the LAVA card gives way to the lava pouring from that crater.
 */
function volcanoes(mountains: LiveCard[], lavas: LiveCard[], out: LiveCard[]): void {
  const pairs: { m: number; l: number; near: number }[] = [];
  mountains.forEach((mountain, m) => lavas.forEach((lava, l) => {
    const near = nextTo(mountain, lava);
    if (near > 0) pairs.push({ m, l, near });
  }));
  pairs.sort((a, b) => b.near - a.near || a.m - b.m || a.l - b.l);
  const leftL = lavas.map((c) => c.strength);
  const usedM = new Set<number>();
  const usedL = new Set<number>();
  for (const { m, l, near } of pairs) {
    if (usedM.has(m) || usedL.has(l)) continue;
    usedM.add(m);
    usedL.add(l);
    const mountain = mountains[m];
    const lava = lavas[l];
    leftL[l] = lava.strength * (1 - near * mountain.strength);
    out.push(made(MADE.volcano, `volcano:${mountain.key}+${lava.key}`, mountain, mountain.x, mountain.y, near * mountain.strength * lava.strength));
  }
  out.push(...mountains);
  lavas.forEach((card, l) => out.push(leftL[l] === card.strength ? card : { ...card, strength: leftL[l] }));
}

/**
 * CIVILIZATION cards that lie next to each other (in a row or a huddle: a card counts as long as
 * it is next to one that counts) are one settlement, standing in the middle of them: one card a
 * village, two a town, three or more a city. A city also has a district at every one of its cards,
 * so it grows with each card added and follows a line of them.
 *
 * Cards are either joined or not: two cards are two villages, or one town between them, never two
 * half-towns. Only while a card crosses the narrow band between "next to" and "apart" is it both,
 * and then as a fade from the one picture to the other: the villages thin out as the town grows.
 */
function settlements(people: LiveCard[], out: LiveCard[], decided: boolean): void {
  const n = people.length;
  if (!n) return;
  const near = people.map((a) => people.map((b) => (decided ? Math.round(nextTo(a, b)) : nextTo(a, b))));
  // Every different closeness among the pairs is a line: draw the picture with only the pairs at
  // least that close joined, and give it the share of the whole between that line and the one below.
  const lines = [...new Set(near.flat().filter((v) => v > 0 && v < 1))].sort((x, y) => x - y);
  lines.push(1);
  const places = new Map<string, LiveCard>();
  let below = 0;
  for (const line of lines) {
    const share = line - below;
    below = line;
    // Which cards are one settlement, with pairs at least this close joined.
    const group = people.map((_, i) => i);
    const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (near[i][j] >= line) group[find(i)] = find(j);
    const members = new Map<number, LiveCard[]>();
    people.forEach((card, i) => {
      const list = members.get(find(i));
      if (list) list.push(card);
      else members.set(find(i), [card]);
    });
    for (const cards of members.values()) {
      // A card still fading in counts for part of one, and pulls the middle less.
      let size = 0, x = 0, y = 0;
      for (const card of cards) {
        size += card.strength;
        x += card.strength * card.x;
        y += card.strength * card.y;
      }
      x /= size;
      y /= size;
      const town = clamp01(size - 1);
      const city = clamp01(size - 2);
      const amounts = { village: 1 - town, town: town - city, city };
      const who = cards.map((c) => c.key).join('+');
      // A city has a district at each of its cards: more cards, or cards laid further out, a bigger city.
      for (const card of cards) {
        const strength = share * amounts.city * card.strength;
        if (strength <= 1e-4) continue;
        const key = `district:${who}:${card.key}`;
        const old = places.get(key);
        if (old) old.strength = old.fade = Math.min(1, old.strength + strength);
        else places.set(key, made(MADE.district, key, card, card.x, card.y, strength));
      }
      for (const kind of ['village', 'town', 'city'] as const) {
        const strength = share * Math.min(1, size) * amounts[kind];
        if (strength <= 1e-4) continue;
        const key = `${kind}:${who}`;
        const old = places.get(key);
        if (old) old.strength = old.fade = Math.min(1, old.strength + strength);
        else places.set(key, made(MADE[kind], key, cards[0], x, y, strength));
      }
    }
  }
  out.push(...places.values());
}

/**
 * The settlements among what `combine` made, one to a place: whichever of village, town and
 * city it is most (a town growing into a city is both for a moment), as strong as all of it.
 */
export function settlementsOf(made: readonly LiveCard[]): LiveCard[] {
  const places: LiveCard[][] = [];
  for (const card of made) {
    if (card.def !== MADE.village && card.def !== MADE.town && card.def !== MADE.city) continue;
    const place = places.find((p) => Math.hypot(p[0].x - card.x, p[0].y - card.y) < 0.001);
    if (place) place.push(card);
    else places.push([card]);
  }
  return places.map((place) => {
    const most = place.reduce((a, b) => (b.strength > a.strength ? b : a));
    return { ...most, strength: Math.min(1, place.reduce((sum, c) => sum + c.strength, 0)) };
  });
}
