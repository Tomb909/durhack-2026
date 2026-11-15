// The reading board: a word that no card covers is sent to the model, which takes a few seconds
// to read it and make its card. Until now that showed as one line of small text; here each such
// word gets its own scrap of paper at the top of the screen, plainly being read ("the AI is
// reading this word"), with a clock, and then shows what it was made into.
//
// Used for words the camera reads (main.ts) and words typed into the card panel (table.ts,
// combos.ts). Built as elements, not markup: the words are typed or written by players.
import type { Resolved } from '../cards/words';

/** A word looked up quicker than this (a built-in or stored card) never shows as being read. */
const SHOW_AFTER_MS = 250;
/** How long a made card stays on the board. */
const DONE_SECONDS = 7;
const GUESS_SECONDS = 9;

interface Row {
  el: HTMLElement;
  scrap: HTMLElement;
  title: HTMLElement;
  detail: HTMLElement;
  clock: HTMLElement;
  started: number;
  ticker: number;
  timer: number;
}

export class ReadingBoard {
  private rows = new Map<string, Row>();

  constructor(private root: HTMLElement) {}

  /** A word is being read by the model. */
  start(word: string): void {
    const key = word.toUpperCase();
    let row = this.rows.get(key);
    if (row && row.el.classList.contains('busy')) return;
    if (row) this.drop(key, true);
    row = this.make(key);
    row.el.classList.add('busy');
    row.title.textContent = 'AI is reading this word';
    row.detail.textContent = 'Imagining what it makes in the world…';
    row.ticker = window.setInterval(() => this.tick(row!), 100);
    this.tick(row);
  }

  /** The word's card is made (or guessed). Shows even if the word was never seen being read. */
  finish(word: string, { def, source, why, ms }: Resolved): void {
    const key = word.toUpperCase();
    const row = this.rows.get(key) ?? this.make(key);
    clearInterval(row.ticker);
    const guess = source === 'near' || source === 'fallback';
    row.el.classList.remove('busy');
    row.el.classList.add(guess ? 'guess' : 'done');
    row.scrap.style.setProperty('--c', def.color);
    row.scrap.textContent = def.word;
    row.clock.textContent = source === 'model' ? `${(ms / 1000).toFixed(1)} s` : '';
    row.title.textContent =
      source === 'model' ? (def.word === key ? 'New card made' : `Made ${key} into a card`)
      : source === 'near' ? `Read ${key} as ${def.word}`
      : source === 'fallback' ? 'Could not read it: a guess'
      : 'Card ready';
    row.detail.textContent = guess ? `A guess, because ${why ?? 'the model did not answer'}.` : def.reading ?? '';
    clearTimeout(row.timer);
    row.timer = window.setTimeout(() => this.drop(key), (guess ? GUESS_SECONDS : DONE_SECONDS) * 1000);
  }

  /** Reading failed outright. */
  fail(word: string, message: string): void {
    const key = word.toUpperCase();
    const row = this.rows.get(key) ?? this.make(key);
    clearInterval(row.ticker);
    row.el.classList.remove('busy');
    row.el.classList.add('guess');
    row.title.textContent = `Could not read ${key}`;
    row.detail.textContent = message;
    row.clock.textContent = '';
    clearTimeout(row.timer);
    row.timer = window.setTimeout(() => this.drop(key), GUESS_SECONDS * 1000);
  }

  /**
   * Follow one lookup: shown as being read only if it takes long enough to be the model working,
   * so a built-in card does not flash up. Returns the same promise.
   */
  track(word: string, job: Promise<Resolved>): Promise<Resolved> {
    let settled = false;
    const timer = window.setTimeout(() => !settled && this.start(word), SHOW_AFTER_MS);
    job.then(
      (result) => {
        settled = true;
        clearTimeout(timer);
        const quick = result.source === 'built-in' || result.source === 'stored';
        if (this.rows.has(word.toUpperCase()) || !quick) this.finish(word, result);
      },
      (error: Error) => {
        settled = true;
        clearTimeout(timer);
        if (this.rows.has(word.toUpperCase())) this.fail(word, error.message);
      },
    );
    return job;
  }

  private make(key: string): Row {
    const el = document.createElement('div');
    el.className = 'reading-row';
    const scrap = document.createElement('span');
    scrap.className = 'reading-scrap';
    scrap.textContent = key;
    const text = document.createElement('div');
    text.className = 'reading-text';
    const head = document.createElement('div');
    head.className = 'reading-head';
    const title = document.createElement('span');
    title.className = 'reading-title';
    const clock = document.createElement('span');
    clock.className = 'reading-clock';
    head.append(title, clock);
    const detail = document.createElement('div');
    detail.className = 'reading-detail';
    const bar = document.createElement('div');
    bar.className = 'reading-bar';
    text.append(head, detail, bar);
    el.append(scrap, text);
    this.root.append(el);
    // Next frame, so the entrance plays.
    requestAnimationFrame(() => el.classList.add('in'));
    const row: Row = { el, scrap, title, detail, clock, started: performance.now(), ticker: 0, timer: 0 };
    this.rows.set(key, row);
    return row;
  }

  private tick(row: Row): void {
    row.clock.textContent = `${((performance.now() - row.started) / 1000).toFixed(1)} s`;
  }

  private drop(key: string, now = false): void {
    const row = this.rows.get(key);
    if (!row) return;
    this.rows.delete(key);
    clearInterval(row.ticker);
    clearTimeout(row.timer);
    if (now) return row.el.remove();
    row.el.classList.remove('in');
    window.setTimeout(() => row.el.remove(), 400);
  }
}

let board: ReadingBoard | null = null;
/** The page's one reading board (in #reading). */
export function readingBoard(): ReadingBoard {
  if (!board) {
    let root = document.getElementById('reading');
    if (!root) {
      root = document.createElement('div');
      root.id = 'reading';
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      (document.getElementById('ui') ?? document.body).append(root);
    }
    board = new ReadingBoard(root);
  }
  return board;
}
