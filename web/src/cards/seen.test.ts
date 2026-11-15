import { describe, expect, it } from 'vitest';
import { cardDef } from './defs';
import { RETRY_MS, SeenWords } from './seen';
import type { TrackedCard } from './store';
import { cleanCard, fallbackCard, register, removeWord, type Resolved } from './words';

const scrap = (id: number, card: string, word?: string): TrackedCard => ({ id, card, x: 0.4, y: 0.6, visible: true, ...(word ? { word } : {}) });
const settle = () => new Promise((done) => setTimeout(done, 0));

/** Stands in for resolveWord: the model answers (a made card) or does not (a guess). */
function resolver(answers: boolean[]) {
  const asked: string[] = [];
  const resolve = async (word: string): Promise<Resolved> => {
    asked.push(word);
    const made = answers.shift() ?? true;
    const def = made ? cleanCard({ word, origin: 'llm', reading: `A ${word.toLowerCase()}.`, effects: [{ field: 'height', amount: 0.3, radius: 0.1 }] })! : cleanCard(fallbackCard(word))!;
    register(def);
    return { def, source: made ? 'model' : 'fallback', ms: 1, ...(made ? {} : { why: 'no server' }) };
  };
  return { asked, resolve };
}

describe('words the camera reads that are no card', () => {
  it('leaves known cards alone and asks nothing', () => {
    const { asked, resolve } = resolver([]);
    const seen = new SeenWords(resolve);
    const tracked = [scrap(1, 'mountain'), scrap(2, 'forest')];
    expect(seen.apply(tracked)).toEqual({ cards: tracked, reading: [] });
    expect(asked).toEqual([]);
  });

  it('has a card made for a new word, once, and then tracks the scrap as that card', async () => {
    const { asked, resolve } = resolver([true]);
    const seen = new SeenWords(resolve);
    const told: string[] = [];
    seen.onReading = (word) => told.push(`reading ${word}`);
    seen.onMade = (word, result) => told.push(`${result.source} ${word}`);
    const tracked = [scrap(1, 'mountain'), scrap(3, 'rocketship', 'ROCKETSHIP')];

    const before = seen.apply(tracked);
    expect(before.cards).toEqual([tracked[0]]);
    expect(before.reading).toEqual([tracked[1]]);
    seen.apply(tracked); // the next snapshot arrives while the model is thinking
    expect(asked).toEqual(['ROCKETSHIP']);

    await settle();
    const after = seen.apply(tracked);
    expect(after.reading).toEqual([]);
    expect(after.cards[1]).toEqual({ ...tracked[1], card: 'rocketship' });
    expect(cardDef('rocketship')!.origin).toBe('llm');
    expect(told).toEqual(['reading ROCKETSHIP', 'model ROCKETSHIP']);
    // A second scrap with the same word, and a later visit: the card is there, nothing is asked.
    expect(seen.apply([scrap(9, 'rocketship', 'rocketship')]).cards[0].card).toBe('rocketship');
    expect(new SeenWords(resolve).apply(tracked).reading).toEqual([]);
    expect(asked).toEqual(['ROCKETSHIP']);
    removeWord('rocketship');
  });

  it('shows a guess when the model does not answer, and asks again later', async () => {
    const { asked, resolve } = resolver([false, false, true]);
    let now = 0;
    const seen = new SeenWords(resolve, () => now);
    const told: string[] = [];
    seen.onMade = (word, result) => told.push(`${result.source} ${word}`);
    const tracked = [scrap(4, 'zeppelin', 'ZEPPELIN')];

    seen.apply(tracked);
    await settle();
    expect(seen.apply(tracked).cards[0].card).toBe('zeppelin');
    expect(cardDef('zeppelin')!.origin).toBe('fallback');
    now = RETRY_MS - 1;
    seen.apply(tracked);
    expect(asked.length).toBe(1); // not yet
    now = RETRY_MS + 1;
    seen.apply(tracked);
    await settle();
    expect(asked.length).toBe(2);
    now = 2 * RETRY_MS + 2;
    seen.apply(tracked);
    await settle();
    expect(cardDef('zeppelin')!.origin).toBe('llm');
    now = 9 * RETRY_MS;
    seen.apply(tracked);
    expect(asked.length).toBe(3); // made: never asked again
    expect(told).toEqual(['fallback ZEPPELIN', 'model ZEPPELIN']); // the second guess is not news
    removeWord('zeppelin');
  });

  it('asks nothing when switched off: the scrap stays "being read"', () => {
    const { asked, resolve } = resolver([]);
    const seen = new SeenWords(resolve);
    seen.enabled = false;
    const tracked = [scrap(5, 'gondola', 'GONDOLA')];
    expect(seen.apply(tracked)).toEqual({ cards: [], reading: tracked });
    expect(asked).toEqual([]);
  });
});
