import type { LiveCard } from './store';

const TABLE_ASPECT = 420 / 297;

/** Map each target to nearby modifiers, regardless of which side they are on. */
export function modifierTargets(cards: LiveCard[]): Map<LiveCard, LiveCard[]> {
  const active = cards.filter((card) => card.strength > 0);
  const targets = new Map<LiveCard, LiveCard[]>();
  for (const source of active) {
    const modifier = source.def.modifier;
    if (!modifier) continue;
    let target: LiveCard | undefined;
    let nearestDistance = Infinity;
    for (const candidate of active) {
      if (candidate.def.modifier) continue;
      const dx = candidate.x - source.x;
      const dy = (candidate.y - source.y) / TABLE_ASPECT;
      const distance = Math.hypot(dx, dy);
      if (distance < nearestDistance) {
        target = candidate;
        nearestDistance = distance;
      }
    }
    if (!target || nearestDistance > modifier.maxDistance + 1e-9) continue;
    const attached = targets.get(target);
    if (attached) attached.push(source);
    else targets.set(target, [source]);
  }
  return targets;
}

export function radiusMultiplier(modifiers: LiveCard[]): number {
  return modifiers.reduce((multiplier, card) => {
    const modifier = card.def.modifier;
    return modifier?.type === 'radius'
      ? multiplier * (1 + (modifier.multiplier - 1) * card.strength)
      : multiplier;
  }, 1);
}

export function heightMultiplier(modifiers: LiveCard[]): number {
  return modifiers.reduce((multiplier, card) => {
    const factor = card.def.modifier?.heightMultiplier ?? 1;
    return multiplier * (1 + (factor - 1) * card.strength);
  }, 1);
}
