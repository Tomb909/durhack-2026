// A world as a handful of numbers, so worlds can be compared without looking
// at pictures: how much is flooded, forested, raining, frozen. No graphics.
import { cardDef } from '../cards/defs';
import { hashText } from '../cards/words';
import { settledCard, type LiveCard } from '../cards/store';
import { placeProps, type PlacedObject } from '../sim/props';
import { RULES, WorldSim, type WorldFrame } from '../sim/world';
import type { Placement, Scenario } from './codes';

export interface Metrics {
  /** Sea level. */
  sea: number;
  /** Highest ground. */
  peak: number;
  /** The rest are percentages of the map. */
  flooded: number; // under the sea
  fresh: number; // rivers and lakes on land
  rain: number;
  snow: number;
  forest: number; // well covered by plants
  frozen: number; // below freezing
  desert: number; // dry land with almost no moisture
  homes: number; // villages
  farms: number; // farmland
  /** Objects standing (from word cards): a count, not a share. */
  objects: number;
  /** Fingerprint of the whole world: equal worlds have equal fingerprints. */
  hash: string;
}

export const METRIC_KEYS = ['sea', 'peak', 'flooded', 'fresh', 'rain', 'snow', 'forest', 'frozen', 'desert', 'homes', 'farms', 'objects'] as const;

/** Plain names for the numbers, for people. `share` ones are percentages of the map. */
export const METRIC_LABELS: Record<(typeof METRIC_KEYS)[number], { label: string; share: boolean }> = {
  sea: { label: 'Sea level', share: false },
  peak: { label: 'Highest peak', share: false },
  flooded: { label: 'Sea', share: true },
  fresh: { label: 'Rivers and lakes', share: true },
  rain: { label: 'Rain', share: true },
  snow: { label: 'Snow', share: true },
  forest: { label: 'Forest', share: true },
  frozen: { label: 'Frozen', share: true },
  desert: { label: 'Desert', share: true },
  homes: { label: 'Villages', share: true },
  farms: { label: 'Farmland', share: true },
  objects: { label: 'Objects placed', share: false },
};

export function liveCards(cards: Placement[], prefix = 'h'): LiveCard[] {
  return cards.map((p, k) => settledCard(`${prefix}:${k}`, cardDef(p.id)!, p.x, p.y));
}

/**
 * The world's numbers. With the cards, the objects they put down are counted
 * too (and, when there are any, fingerprinted with where they stand).
 */
export function measure(frame: WorldFrame, cards: LiveCard[] = [], objects: PlacedObject[] = placeProps(frame, cards)): Metrics {
  const n = frame.w * frame.h;
  const { height, temperature, wetness, vegetation, waterSurface, river, precipitation, homes, farms, fishing, logging, cleared, seaLevel } = frame;
  let peak = -Infinity;
  let flooded = 0, fresh = 0, rain = 0, snow = 0, forest = 0, frozen = 0, desert = 0, village = 0, farmland = 0;
  let hash = 0x811c9dc5;
  const mix = (v: number) => {
    // FNV-1a over values rounded to 4 places, so harmless float noise does not change it.
    hash = Math.imul(hash ^ (Math.round(v * 1e4) | 0), 0x01000193);
  };
  for (let i = 0; i < n; i++) {
    const h = height[i];
    if (h > peak) peak = h;
    const sea = h < seaLevel;
    const cold = temperature[i] < RULES.freezing;
    if (sea) flooded++;
    else if (waterSurface[i] - h > 0.0005) fresh++;
    if (precipitation[i] > 0.05) cold ? snow++ : rain++;
    if (vegetation[i] > 0.4) forest++;
    if (cold) frozen++;
    if (!sea && wetness[i] < 0.1) desert++;
    if (homes[i] > 0.25) village++;
    if (farms[i] > 0.25) farmland++;
    mix(h); mix(temperature[i]); mix(wetness[i]); mix(vegetation[i]); mix(waterSurface[i]); mix(river[i]); mix(precipitation[i]);
    mix(homes[i]); mix(farms[i]); mix(fishing[i]); mix(logging[i]); mix(cleared[i]);
  }
  mix(seaLevel);
  // Only worlds with objects mix them in, so every world without one keeps the fingerprint it always had.
  for (const o of objects) {
    mix(parseInt(hashText(o.def.id), 16) / 1e4); mix(o.x); mix(o.y); mix(o.ground); mix(o.size);
  }
  const pct = (count: number) => Math.round((count / n) * 1000) / 10;
  return {
    sea: Math.round(seaLevel * 1e4) / 1e4,
    peak: Math.round(peak * 1e3) / 1e3,
    flooded: pct(flooded), fresh: pct(fresh), rain: pct(rain), snow: pct(snow), forest: pct(forest), frozen: pct(frozen), desert: pct(desert), homes: pct(village), farms: pct(farmland),
    objects: objects.length,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
  };
}

export interface Row {
  name: string;
  code: string;
  metrics: Metrics;
}

/** Settle every scenario and measure it. One sim is reused; each world starts from scratch. */
export function measureAll(scenarios: Scenario[]): { rows: Row[]; ms: number } {
  const sim = new WorldSim();
  const start = performance.now();
  const rows = scenarios.map((s) => {
    const cards = liveCards(s.cards);
    return { name: s.name, code: s.code, metrics: measure(sim.settleNow(cards), cards) };
  });
  return { rows, ms: performance.now() - start };
}

/** Plain-text table, one world per line. */
export function formatTable(rows: Row[]): string {
  const head = ['#', 'world', ...METRIC_KEYS.map((k) => (METRIC_LABELS[k].share ? `${k}%` : k)), 'hash'];
  const body = rows.map((r, i) => [
    String(i + 1).padStart(2, '0'), r.name, ...METRIC_KEYS.map((k) => String(r.metrics[k])), r.metrics.hash,
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...body.map((b) => b[c].length)));
  const line = (cells: string[]) => cells.map((cell, c) => (c === 1 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join('  ');
  return [line(head), ...body.map(line)].join('\n');
}
