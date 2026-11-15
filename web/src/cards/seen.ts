// Words the camera reads that are no built-in card. The tracker sends such a scrap as a card
// with a `word` (server/deck/vision/tracker.py); here each word is made into a card once, the
// same way as a typed word (words.ts: a card made before, then the model, then a guess), and
// the scrap is then tracked as that card. Until its card exists the scrap is "being read".
import type { TrackedCard } from './store';
import { findCard, isGuess, normaliseWord, resolveWord, type Resolved } from './words';

/** A word that could only be guessed is asked for again this often while it is on the table. */
export const RETRY_MS = 15_000;

interface Seen {
  /** The card shown for this word, once there is one. */
  id?: string;
  pending: boolean;
  /** A guess: ask again at this time. */
  retryAt: number;
  guess: boolean;
}

export class SeenWords {
  /** False: words that are no card are left as "being read" and nothing is asked. */
  enabled = true;
  /** A word is being read for the first time. */
  onReading: (word: string) => void = () => {};
  /** A word has its card (or, the model not answering, its guess; again when a guess is replaced). */
  onMade: (word: string, result: Resolved) => void = () => {};
  private words = new Map<string, Seen>();

  constructor(
    private resolve: (word: string) => Promise<Resolved> = resolveWord,
    private now: () => number = () => performance.now(),
  ) {}

  /**
   * The tracked cards with each written word swapped for its card. `reading` holds the scraps
   * whose word has no card yet; asking for one starts here.
   */
  apply(tracked: TrackedCard[]): { cards: TrackedCard[]; reading: TrackedCard[] } {
    const cards: TrackedCard[] = [];
    const reading: TrackedCard[] = [];
    for (const t of tracked) {
      if (!t.word) {
        cards.push(t);
        continue;
      }
      const word = normaliseWord(t.word);
      if (!word) continue;
      if (!this.enabled) {
        reading.push(t);
        continue;
      }
      const known = findCard(word);
      // A guess is not an answer: the model may be reachable now.
      if (!known || isGuess(known)) this.ask(word);
      const id = known?.id ?? this.words.get(word)?.id;
      if (id) cards.push({ ...t, card: id });
      else reading.push(t);
    }
    return { cards, reading };
  }

  private ask(word: string): void {
    let seen = this.words.get(word);
    if (!seen) this.words.set(word, (seen = { pending: false, retryAt: 0, guess: false }));
    if (seen.pending || this.now() < seen.retryAt) return;
    const state = seen;
    const first = state.id === undefined;
    state.pending = true;
    if (first) this.onReading(word);
    this.resolve(word)
      .then((result) => {
        const guess = result.source === 'near' || result.source === 'fallback';
        const tell = first || (state.guess && !guess);
        state.id = result.def.id;
        state.guess = guess;
        state.retryAt = this.now() + RETRY_MS;
        if (tell) this.onMade(word, result);
      })
      .catch(() => {
        state.retryAt = this.now() + RETRY_MS;
      })
      .finally(() => {
        state.pending = false;
      });
  }
}
