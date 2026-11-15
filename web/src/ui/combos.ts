// The Combinations view: every way of combining the cards, side by side, for
// looking over by eye. Opened from the button on the world page (or V).
//
// One row of controls: a switch per card (with its number of copies), the kind
// of picture, and the tile size. Each tile has its own "Spaced" switch.
//
// Each world is settled at once and drawn at one frozen moment (see harness/),
// so the same choices always show the same pictures. The cards come from
// cards.json: a new card gets its own switch here with no extra work.
//
// "Add a word" makes a card from any typed word or phrase (cards/words.ts) and
// switches "Only with" on for it, so its combinations are the ones shown.
import { BUILT_IN_IDS, CARD_DEFS, cardDef, onCardsChanged, type CardDef } from '../cards/defs';
import { isGuess, normaliseWord, removeWord, resolveWord, type Resolved } from '../cards/words';
import { parseCode, type Layout, type Placement, type Scenario } from '../harness/codes';
import { combinations, copiesOf, countCombinations, defaultFilter, MOST_COPIES, type ComboFilter } from '../harness/filter';
import { METRIC_KEYS, METRIC_LABELS, type Metrics } from '../harness/metrics';
import { tileHeight, TileRenderer, type View } from '../harness/tiles';

type Size = 's' | 'm' | 'l';

interface Prefs extends ComboFilter {
  view: View;
  size: Size;
}

/** Smallest width a tile may be on screen, and the width it is drawn at (sharp when stretched a little). */
const SIZES: Record<Size, { min: number; draw: number; label: string; name: string }> = {
  s: { min: 250, draw: 520, label: 'S', name: 'Small tiles' },
  m: { min: 380, draw: 760, label: 'M', name: 'Medium tiles' },
  l: { min: 600, draw: 1100, label: 'L', name: 'Large tiles' },
};
const DETAIL_WIDTH = 1600;
const MOMENT = 6; // seconds: the instant every picture is taken at
const ZOOM = 1.3;
const MOST = 64; // more tiles than this is not a view any more
const STORE = 'deck.combinations.2';

const VIEW_LABEL: Record<View, string> = { '3d': '3D', map: 'Map', both: 'Both' };
const VIEW_NAME: Record<View, string> = { '3d': 'The world in 3D', map: 'Flat map from above', both: '3D with the map in the corner' };

const esc = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const titleCase = (word: string) => word.charAt(0) + word.slice(1).toLowerCase();

function loadPrefs(): Prefs {
  // A modifier card (BIG) only changes the card beside it, and a compound card (VOLCANO) is
  // already a mix of simpler ones: both start switched off, so the first thing you see is
  // every combination of the plain cards. Each card switched on doubles the list.
  const prefs: Prefs = { ...defaultFilter(), off: CARD_DEFS.filter((d) => d.modifier || d.compound).map((d) => d.id), view: '3d', size: 'm' };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<Prefs>;
    if (Array.isArray(saved.off)) prefs.off = saved.off.filter((id) => typeof id === 'string');
    if (Array.isArray(saved.only)) prefs.only = saved.only.filter((id) => typeof id === 'string');
    if (saved.copies && typeof saved.copies === 'object') {
      for (const [id, n] of Object.entries(saved.copies)) if (Number.isInteger(n)) prefs.copies[id] = n;
    }
    if (saved.view && saved.view in VIEW_LABEL) prefs.view = saved.view;
    if (saved.size && saved.size in SIZES) prefs.size = saved.size;
  } catch {
    /* no saved choices, or storage is blocked: the defaults are fine */
  }
  return prefs;
}

/** What is on the table in a combination, grouped: [card id, copies]. */
function contents(scenario: Scenario): [string, number][] {
  const counts = new Map<string, number>();
  for (const card of scenario.cards) counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
  return [...counts];
}

function chips(scenario: Scenario): string {
  const items = contents(scenario);
  if (!items.length) return '<span class="combo-chip none">Empty table</span>';
  return items
    .map(([id, count]) => {
      const def = cardDef(id)!;
      return `<span class="combo-chip${def.origin === 'fallback' ? ' guess' : ''}" style="--c:${esc(def.color)}"><span aria-hidden="true">${esc(def.icon)}</span>${esc(def.word)}${count > 1 ? ` ×${count}` : ''}</span>`;
    })
    .join('');
}

function spoken(scenario: Scenario): string {
  const items = contents(scenario).map(([id, count]) => titleCase(cardDef(id)!.word) + (count > 1 ? ` times ${count}` : ''));
  return items.length ? items.join(', ') : 'Empty table';
}

/** The numbers worth a glance: shares of the map that are not zero, and objects placed. */
function summary(metrics: Metrics): string {
  const parts = METRIC_KEYS.filter((k) => METRIC_LABELS[k].share && metrics[k] > 0).map((k) => `${METRIC_LABELS[k].label} ${metrics[k]}%`);
  if (metrics.objects > 0) parts.push(`${metrics.objects} object${metrics.objects === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'Bare, dry land';
}

const signed = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100) / 100}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** What a card made from a word does, in plain words, as list items (already escaped). */
function doings(def: CardDef): string[] {
  const out: string[] = [];
  if (def.effects.length) {
    // A shape ends at its radius ("to 30%"); a round patch fades out well beyond it ("reach 30%").
    const where = (e: CardDef['effects'][number]) => e.global ? '' : e.shape ? ` (${e.shape}, to ${Math.round((e.radius ?? 0.2) * 100)}%)` : ` (reach ${Math.round((e.radius ?? 0.2) * 100)}%)`;
    out.push(`Pushes ${def.effects.map((e) => `${e.field === 'seaLevel' ? 'sea level' : e.field} ${signed(e.amount)}${where(e)}`).join(', ')}`);
  }
  const biome = def.biome;
  if (biome) {
    const swatch = (label: string, colour: string) => `<span class="combos-swatch" style="--s:${esc(colour)}"></span>${label}`;
    const bits = [swatch('ground', biome.ground)];
    if (biome.plants) bits.push(swatch('plants', biome.plants));
    if (biome.rock) bits.push(swatch('rock', biome.rock));
    if (biome.liquid) bits.push(swatch(biome.liquid.glow > 0.5 ? 'glowing liquid' : 'liquid', biome.liquid.color));
    if (!biome.trees) bits.push('no trees');
    out.push(`Biome to ${Math.round(biome.radius * 100)}%: ${bits.join(', ')}`);
  }
  const air = def.atmosphere;
  if (air) {
    const bits: string[] = [];
    if (air.strength > 0) bits.push(`<span class="combos-swatch" style="--s:${esc(air.tint)}"></span>tint ${Math.round(air.strength * 100)}%`);
    if (air.light < 0) bits.push(air.light <= -0.7 ? 'night' : 'darker');
    if (air.light > 0) bits.push('brighter');
    if (air.particles) bits.push(`${air.particles.glow ? 'glowing ' : ''}particles that ${air.particles.motion}`);
    if (bits.length) out.push(`Air: ${bits.join(', ')}`);
  }
  const prop = def.prop;
  if (prop) {
    const where = { land: 'on land', water: 'on water', shore: 'by the shore', air: 'in the air', anywhere: 'anywhere' }[prop.habitat];
    const many = { one: 'one', few: 'a few', many: 'many' }[prop.count];
    out.push(`Object: ${many}, ${prop.scale}, ${where}, ${prop.parts.length} part${prop.parts.length === 1 ? '' : 's'}${prop.glow ? ', glowing' : ''}`);
  }
  return out;
}

interface Tile {
  canvas: HTMLCanvasElement;
  metrics: Metrics | null;
}

interface Job {
  key: string;
  cards: Placement[];
}

export class Combinations {
  private root: HTMLElement;
  private cards: HTMLElement;
  private options: HTMLElement;
  private scroller: HTMLElement;
  private grid: HTMLElement;
  private count: HTMLElement;
  private detail: HTMLElement;
  private prefs = loadPrefs();
  private tiles: TileRenderer | null = null;
  private cache = new Map<string, Tile>();
  private shown: Scenario[] = [];
  /** Combinations whose cards are placed apart rather than together (by which cards, so it survives a change of copies). */
  private spaced = new Set<string>();
  private queue: Job[] = [];
  private pumping = false;
  private detailIndex = -1;
  private returnFocus: HTMLElement | null = null;
  private wordForm: HTMLFormElement;
  private wordInput: HTMLInputElement;
  private wordStatus: HTMLElement;
  private pendingList: HTMLElement;
  /** Words being read right now. */
  private pending = new Set<string>();
  /** Total of all combinations for the current choices (only the first MOST are shown). */
  private total = 0;

  /**
   * @param behind  parts of the page to switch off while the view is open
   * @param onShow  "show this one in the live world"
   */
  constructor(private behind: HTMLElement[], private onShow: (code: string, layout: Layout) => void) {
    const root = document.createElement('section');
    root.id = 'combos';
    root.className = 'combos';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'combos-title');
    root.innerHTML = `
      <header class="combos-bar">
        <h2 id="combos-title" tabindex="-1">Combinations</h2>
        <p class="combos-count" role="status" aria-live="polite"></p>
        <div class="combos-cards" role="group" aria-label="Cards to combine"></div>
        <div class="combos-options"></div>
        <button type="button" class="combos-btn combos-x" data-do="close" aria-label="Close" title="Close (Esc)"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" /></svg></button>
        <div class="combos-wordrow">
          <form class="combos-add" autocomplete="off">
            <label for="combos-word">Add a word</label>
            <input id="combos-word" name="word" type="text" maxlength="60" spellcheck="false" placeholder="castle, haunted house, jazz…" aria-describedby="combos-word-status">
            <button type="submit" class="combos-btn">Add</button>
          </form>
          <span class="combos-pending" aria-hidden="true"></span>
          <p id="combos-word-status" class="combos-word-status" role="status" aria-live="polite"></p>
        </div>
      </header>
      <div class="combos-body">
        <ul class="combos-grid"></ul>
        <div class="combos-detail" hidden></div>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    this.cards = root.querySelector('.combos-cards')!;
    this.options = root.querySelector('.combos-options')!;
    this.scroller = root.querySelector('.combos-body')!;
    this.grid = root.querySelector('.combos-grid')!;
    this.count = root.querySelector('.combos-count')!;
    this.detail = root.querySelector('.combos-detail')!;
    this.wordForm = root.querySelector('.combos-add')!;
    this.wordInput = root.querySelector('#combos-word')!;
    this.wordStatus = root.querySelector('.combos-word-status')!;
    this.pendingList = root.querySelector('.combos-pending')!;
    this.wordForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.wordInput.value;
      this.wordInput.value = '';
      void this.addWord(text);
    });
    // A card made, read again or removed (here or anywhere): new switches, fresh pictures.
    onCardsChanged(() => {
      if (!this.isOpen) return;
      this.cache.clear();
      this.buildControls();
      this.refresh();
    });

    root.addEventListener('click', (e) => this.click(e));
    root.addEventListener('change', (e) => this.change(e));
    root.addEventListener('keydown', (e) => this.key(e));
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    if (this.isOpen) return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.root.hidden = false;
    for (const el of this.behind) el.inert = true;
    this.buildControls();
    this.refresh();
    (this.root.querySelector('#combos-title') as HTMLElement).focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.closeDetail(false);
    this.root.hidden = true;
    this.queue = [];
    for (const el of this.behind) el.inert = false;
    this.returnFocus?.focus();
  }

  // --- the controls ---------------------------------------------------------------

  private choice(name: string, legend: string, options: [value: string, label: string, title: string][], current: string): string {
    const inputs = options
      .map(([value, label, title]) =>
        `<label title="${esc(title)}"><input type="radio" name="combos-${esc(name)}" value="${esc(value)}" aria-label="${esc(title)}"${value === current ? ' checked' : ''}><span>${esc(label)}</span></label>`)
      .join('');
    return `<fieldset class="combos-seg"><legend class="combos-sr">${esc(legend)}</legend>${inputs}</fieldset>`;
  }

  private buildControls(): void {
    const p = this.prefs;
    // Rebuilding the switches must not lose the hand: note what had focus, and put it back after.
    const had = document.activeElement instanceof HTMLElement && this.cards.contains(document.activeElement)
      ? { card: document.activeElement.closest<HTMLElement>('.combos-card')?.dataset.card, does: document.activeElement.dataset.do }
      : null;
    // One switch per card, with its number of copies and "only with" beside it. Cards made from
    // words say where they came from; any of them can be read again by the model, or removed.
    this.cards.innerHTML = CARD_DEFS.map((def) => {
      const name = esc(titleCase(def.word));
      const made = !BUILT_IN_IDS.has(def.id);
      const guess = made && isGuess(def);
      const tag = made
        ? `<span class="combos-tag" title="${guess ? 'A guess from the sound of the word: the model could not be asked' : 'Read by the model'}">${guess ? 'guess' : 'AI'}</span>`
        : '';
      const madeButtons = made
        ? (guess
          ? `<button type="button" data-do="retry" aria-label="Try ${name} again with the model" title="Try again with the model">Try again</button>`
          : `<button type="button" data-do="retry" aria-label="Have the model read ${name} again" title="Ask the model again and replace this card (one model call)">Read again</button>`) +
          `<button type="button" data-do="remove" aria-label="Remove ${name}" title="Remove this card">✕</button>`
        : '';
      return `
      <span class="combos-card${made ? ' made' : ''}${guess ? ' guess' : ''}" data-card="${esc(def.id)}" style="--c:${esc(def.color)}">
        <button type="button" class="combos-toggle" data-do="card" role="switch"><span class="combos-switch" aria-hidden="true"></span><span class="combos-icon" aria-hidden="true">${esc(def.icon)}</span>${esc(def.word)}${tag}</button>
        <span class="combos-copies" role="group" aria-label="Copies of ${name}">
          <button type="button" data-do="fewer" aria-label="Fewer copies of ${name}" title="One copy fewer">−</button>
          <output></output>
          <button type="button" data-do="more" aria-label="More copies of ${name}" title="One copy more">+</button>
          <button type="button" class="combos-only" data-do="only" aria-label="Only combinations with ${name}" title="Only show combinations that include ${name}">only</button>
        </span>${madeButtons ? `<span class="combos-made">${madeButtons}</span>` : ''}
      </span>`;
    }).join('');
    if (had?.card) {
      const back = this.cards.querySelector<HTMLElement>(`.combos-card[data-card="${CSS.escape(had.card)}"] [data-do="${CSS.escape(had.does ?? 'card')}"]`)
        ?? this.cards.querySelector<HTMLElement>(`.combos-card[data-card="${CSS.escape(had.card)}"] [data-do="card"]`);
      (back ?? this.wordInput).focus();
    }
    this.options.innerHTML =
      this.choice('view', 'Picture', (['3d', 'map', 'both'] as View[]).map((v): [string, string, string] => [v, VIEW_LABEL[v], VIEW_NAME[v]]), p.view) +
      this.choice('size', 'Tile size', (['s', 'm', 'l'] as Size[]).map((s): [string, string, string] => [s, SIZES[s].label, SIZES[s].name]), p.size);
    this.syncCards();
  }

  /** Make the card switches say what the choices are (without rebuilding them, so focus stays put). */
  private syncCards(): void {
    for (const el of this.cards.querySelectorAll<HTMLElement>('.combos-card')) {
      const id = el.dataset.card!;
      const word = titleCase(cardDef(id)?.word ?? id);
      const on = !this.prefs.off.includes(id);
      const copies = copiesOf(this.prefs, id);
      el.classList.toggle('off', !on);
      const toggle = el.querySelector('.combos-toggle') as HTMLElement;
      toggle.setAttribute('aria-checked', String(on));
      toggle.title = on ? `Leave ${word} out of the combinations` : `Bring ${word} into the combinations`;
      const count = el.querySelector('.combos-copies') as HTMLElement;
      count.hidden = !on;
      (count.querySelector('output') as HTMLElement).textContent = `×${copies}`;
      (count.querySelector('[data-do="fewer"]') as HTMLButtonElement).disabled = copies <= 1;
      (count.querySelector('[data-do="more"]') as HTMLButtonElement).disabled = copies >= MOST_COPIES;
      (count.querySelector('[data-do="only"]') as HTMLElement).setAttribute('aria-pressed', String((this.prefs.only ?? []).includes(id)));
    }
  }

  // --- adding a word ---------------------------------------------------------------

  /** Make a card from a typed word (or read a guess again), then show its combinations. */
  private async addWord(text: string, fresh = false): Promise<void> {
    const word = normaliseWord(text);
    if (!word) {
      this.wordStatus.textContent = 'Type a word or a short phrase first.';
      return;
    }
    if (this.pending.has(word)) return;
    this.pending.add(word);
    this.showPending();
    this.wordStatus.textContent = `Reading ${word}…`;
    let result: Resolved;
    try {
      result = await resolveWord(word, { fresh });
    } catch (error) {
      this.wordStatus.textContent = `Could not add ${word}: ${(error as Error).message}`;
      return;
    } finally {
      this.pending.delete(word);
      this.showPending();
    }
    const { def, source, why, ms } = result;
    this.wordStatus.textContent =
      source === 'built-in' ? `${def.word} is a built-in card.`
      : source === 'stored' ? `${def.word}: made before, so straight away.`
      : source === 'model' ? `${def.word}: read in ${seconds(ms)}. ${def.reading ?? ''}`
      : source === 'near' ? `Read ${word} as ${def.word}, a guess (${why}).`
      : `${def.word}: a guess from the sound of the word, because ${why}. Try again later.`;
    // Bring the card in and show only the combinations that include it, so it does not drown.
    const p = this.prefs;
    p.off = p.off.filter((id) => id !== def.id);
    if (!def.modifier) p.only = [def.id];
    this.save();
    if (!this.isOpen) return;
    this.syncCards();
    this.refresh();
  }

  private showPending(): void {
    this.pendingList.replaceChildren(...[...this.pending].map((word) => {
      const chip = document.createElement('span');
      chip.className = 'combo-chip busy';
      chip.textContent = `${word}…`;
      return chip;
    }));
  }

  private change(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.name === 'combos-view') this.prefs.view = input.value as View;
    else if (input.name === 'combos-size') this.prefs.size = input.value as Size;
    else return;
    this.save();
    this.refresh();
  }

  private save(): void {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.prefs));
    } catch {
      /* storage blocked: the choices just do not carry over */
    }
  }

  private click(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-do]');
    if (!target) return;
    const p = this.prefs;
    const card = target.closest<HTMLElement>('.combos-card')?.dataset.card;
    const tile = target.closest<HTMLElement>('.combo');
    switch (target.dataset.do) {
      case 'close':
        this.close();
        break;
      case 'card':
        if (!card) break;
        p.off = p.off.includes(card) ? p.off.filter((id) => id !== card) : [...p.off, card];
        this.save();
        this.syncCards();
        this.refresh();
        break;
      case 'only':
        if (!card) break;
        p.only = (p.only ?? []).includes(card) ? (p.only ?? []).filter((id) => id !== card) : [...(p.only ?? []), card];
        // "Only with" a card that is switched off would show nothing: switch it on.
        p.off = p.off.filter((id) => id !== card);
        this.save();
        this.syncCards();
        this.refresh();
        break;
      case 'retry': {
        const def = card ? cardDef(card) : undefined;
        if (def) void this.addWord(def.word, true);
        break;
      }
      case 'remove':
        if (!card) break;
        p.only = (p.only ?? []).filter((id) => id !== card);
        this.save();
        this.wordInput.focus(); // the button pressed is about to go
        this.wordStatus.textContent = `${titleCase(cardDef(card)?.word ?? card)} removed.`;
        removeWord(card);
        break;
      case 'fewer':
      case 'more': {
        if (!card) break;
        const next = Math.min(MOST_COPIES, Math.max(1, copiesOf(p, card) + (target.dataset.do === 'more' ? 1 : -1)));
        if (next === copiesOf(p, card)) break;
        p.copies[card] = next;
        this.save();
        this.syncCards();
        // The button just pressed may now be at its limit and switched off: keep the hand on the pair.
        if ((target as HTMLButtonElement).disabled) (target.parentElement!.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
        this.refresh();
        break;
      }
      case 'open':
        if (tile) this.openDetail(Number(tile.dataset.index));
        break;
      case 'spaced':
        // On a tile: that tile alone. In the large view: the combination being looked at.
        this.setSpaced(tile ? Number(tile.dataset.index) : this.detailIndex, target.getAttribute('aria-pressed') !== 'true');
        if (!tile) this.openDetail(this.detailIndex, 'spaced');
        break;
      case 'back':
        this.closeDetail(true);
        break;
      case 'prev':
        this.step(-1);
        break;
      case 'next':
        this.step(1);
        break;
      case 'show': {
        const s = this.shown[this.detailIndex];
        const layout = this.layoutOf(s);
        this.close();
        this.onShow(s.code, layout);
        break;
      }
    }
  }

  private key(e: KeyboardEvent): void {
    e.stopPropagation(); // the world page's own keys must not fire underneath
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.detailIndex >= 0) this.closeDetail(true);
      else this.close();
    } else if (this.detailIndex >= 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      this.step(e.key === 'ArrowLeft' ? -1 : 1);
    }
  }

  // --- together or spaced, per combination -------------------------------------------

  private kinds(s: Scenario): string {
    return contents(s).map(([id]) => id).join('+');
  }

  /** Spacing only means something when there are at least two kinds of card. */
  private canSpace(s: Scenario): boolean {
    return contents(s).length > 1;
  }

  private layoutOf(s: Scenario): Layout {
    return this.canSpace(s) && this.spaced.has(this.kinds(s)) ? 'spread' : 'cluster';
  }

  private placed(s: Scenario): Placement[] {
    return this.layoutOf(s) === 'spread' ? parseCode(s.code, 'spread') : s.cards;
  }

  /** Switch one combination between together and spaced. Only its own tile is redrawn: nothing else moves. */
  private setSpaced(index: number, on: boolean): void {
    const s = this.shown[index];
    if (!s) return;
    if (on) this.spaced.add(this.kinds(s));
    else this.spaced.delete(this.kinds(s));
    const li = this.grid.querySelector<HTMLElement>(`.combo[data-index="${index}"]`);
    if (li) this.fill(li, s);
    this.pump();
  }

  // --- the grid -------------------------------------------------------------------

  private keyOf(s: Scenario, width: number): string {
    return `${s.code}|${this.layoutOf(s)}|${this.prefs.view}|${width}`;
  }

  private refresh(): void {
    this.closeDetail(false); // a changed choice goes back to the whole set
    const p = this.prefs;
    this.total = countCombinations(p);
    this.shown = combinations(p, undefined, MOST);
    const total = this.total;
    this.count.textContent = total > MOST ? `First ${MOST} of ${total.toLocaleString()}: switch a card off, or use "only", to see fewer` : `${total}`;
    this.count.title = total === 1 ? '1 combination' : `${total} combinations`;

    const width = SIZES[p.size].draw;
    // Keep only pictures that match the current choices, so memory stays level.
    const wanted = new Set(this.shown.map((s) => this.keyOf(s, width)));
    for (const key of this.cache.keys()) if (!wanted.has(key)) this.cache.delete(key);

    // Rebuilding the list must not move the reader: put the scroll back where it was.
    const scroll = this.scroller.scrollTop;
    this.grid.style.setProperty('--tile', `${SIZES[p.size].min}px`);
    this.grid.replaceChildren();
    this.queue = [];
    this.shown.forEach((s, index) => {
      const li = document.createElement('li');
      li.className = 'combo';
      li.dataset.index = String(index);
      li.innerHTML =
        `<button type="button" class="combo-open" data-do="open"><span class="combo-caption"><span class="combo-chips">${chips(s)}</span><span class="combo-numbers"></span></span></button>` +
        (this.canSpace(s) ? '<button type="button" class="combo-spaced" data-do="spaced" title="Place these cards apart instead of together">Spaced</button>' : '');
      this.grid.appendChild(li);
      this.fill(li, s);
    });
    this.scroller.scrollTop = scroll;
    this.pump();
  }

  /** Give a tile its picture for the current choices: the one already drawn, or a blank one queued for drawing. */
  private fill(li: HTMLElement, s: Scenario): void {
    const width = SIZES[this.prefs.size].draw;
    const key = this.keyOf(s, width);
    let tile = this.cache.get(key);
    if (!tile) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = tileHeight(width, this.prefs.view);
      canvas.setAttribute('aria-hidden', 'true');
      tile = { canvas, metrics: null };
      this.cache.set(key, tile);
    }
    // Not drawn yet (new, or its place in the queue was lost when the list was rebuilt): queue it.
    if (!tile.metrics && !this.queue.some((job) => job.key === key)) this.queue.push({ key, cards: this.placed(s) });
    li.dataset.key = key;
    const open = li.querySelector('.combo-open') as HTMLElement;
    open.querySelector('canvas')?.remove();
    open.prepend(tile.canvas);
    li.querySelector('.combo-spaced')?.setAttribute('aria-pressed', String(this.layoutOf(s) === 'spread'));
    this.describe(li, s, tile);
  }

  private describe(li: HTMLElement, s: Scenario, tile: Tile): void {
    const numbers = tile.metrics ? summary(tile.metrics) : 'Drawing…';
    (li.querySelector('.combo-numbers') as HTMLElement).textContent = numbers;
    li.classList.toggle('ready', !!tile.metrics);
    const where = this.layoutOf(s) === 'spread' ? ' Cards spaced apart.' : '';
    li.querySelector('.combo-open')!.setAttribute('aria-label', `${spoken(s)}.${where} ${numbers}. Open larger.`);
  }

  /** Draw the waiting tiles a few at a time, so the page stays responsive while they fill in. */
  private pump(): void {
    if (this.pumping || !this.queue.length) return;
    const work = () => {
      this.pumping = false;
      if (!this.isOpen) return;
      const p = this.prefs;
      const width = SIZES[p.size].draw;
      const height = tileHeight(width, p.view);
      const started = performance.now();
      while (this.queue.length && performance.now() - started < 24) {
        const job = this.queue.shift()!;
        const tile = this.cache.get(job.key);
        if (!tile || tile.metrics || tile.canvas.width !== width) continue; // no longer wanted
        this.tiles ??= new TileRenderer();
        const drawn = this.tiles.draw(tile.canvas.getContext('2d')!, 0, 0, job.cards, { width, height, view: p.view, time: MOMENT, zoom: ZOOM, beacons: true });
        tile.metrics = drawn.metrics;
        const li = this.grid.querySelector<HTMLElement>(`.combo[data-key="${CSS.escape(job.key)}"]`);
        if (li) this.describe(li, this.shown[Number(li.dataset.index)], tile);
      }
      if (this.queue.length) {
        this.pumping = true;
        setTimeout(work, 0);
      }
    };
    // A timer, not an animation frame: it gives the page a turn to paint between
    // batches and still runs when the window is in the background.
    this.pumping = true;
    setTimeout(work, 0);
  }

  // --- one combination, large -------------------------------------------------------

  private openDetail(index: number, focus = 'back'): void {
    const s = this.shown[index];
    if (!s) return;
    this.detailIndex = index;
    const p = this.prefs;
    const width = DETAIL_WIDTH;
    const height = tileHeight(width, p.view);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute('role', 'img');
    this.tiles ??= new TileRenderer();
    const { metrics } = this.tiles.draw(canvas.getContext('2d')!, 0, 0, this.placed(s), { width, height, view: p.view, time: MOMENT, zoom: ZOOM, beacons: true });
    canvas.setAttribute('aria-label', `${spoken(s)}. ${summary(metrics)}.`);

    const numbers = METRIC_KEYS.map((k) => `<div><dt>${METRIC_LABELS[k].label}</dt><dd>${metrics[k]}${METRIC_LABELS[k].share ? '%' : ''}</dd></div>`).join('');
    const spacedOn = this.layoutOf(s) === 'spread';
    this.detail.innerHTML = `
      <div class="combos-detail-bar">
        <button type="button" class="combos-btn" data-do="back">← All</button>
        <span class="combo-chips">${chips(s)}</span>
        ${this.canSpace(s) ? `<button type="button" class="combos-btn" data-do="spaced" aria-pressed="${spacedOn}" title="Place these cards apart instead of together">Spaced</button>` : ''}
        <span class="combos-pos">${index + 1} of ${this.shown.length}</span>
        <button type="button" class="combos-btn" data-do="prev" aria-label="Previous combination">←</button>
        <button type="button" class="combos-btn" data-do="next" aria-label="Next combination">→</button>
        <button type="button" class="combos-btn primary" data-do="show">Show in the live world</button>
      </div>
      <div class="combos-detail-main">
        <div class="combos-picture"></div>
        <aside>
          ${this.wordsPanel(s)}
          <dl class="combos-numbers">${numbers}</dl>
          <p class="combos-code">Code <code>${esc(s.code)}</code></p>
        </aside>
      </div>`;
    this.detail.querySelector('.combos-picture')!.appendChild(canvas);
    this.grid.hidden = true;
    this.detail.hidden = false;
    // Keep the hand where it was: stepping or spacing with a button leaves focus on that button.
    ((this.detail.querySelector(`[data-do="${focus}"]`) ?? this.detail.querySelector('[data-do="back"]')) as HTMLElement).focus();
  }

  /** For cards made from words: how each was read, what it does, and how long it took. */
  private wordsPanel(s: Scenario): string {
    return contents(s)
      .map(([id]) => cardDef(id)!)
      .filter((def) => !BUILT_IN_IDS.has(def.id))
      .map((def) => {
        const made = isGuess(def) ? `A guess, made in the page${def.ms ? ` after ${seconds(def.ms)}` : ''}` : `Read by the model${def.ms ? ` in ${seconds(def.ms)}` : ''}`;
        const items = [...doings(def), esc(made)].map((line) => `<li>${line}</li>`).join('');
        return `<section class="combos-word" style="--c:${esc(def.color)}"><h3><span aria-hidden="true">${esc(def.icon)}</span> ${esc(def.word)}</h3>` +
          `<p>${esc(def.reading || 'No reading.')}</p><ul>${items}</ul></section>`;
      })
      .join('');
  }

  private step(by: number): void {
    const n = this.shown.length;
    if (!n) return;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.do;
    this.openDetail((this.detailIndex + by + n) % n, focused === 'prev' || focused === 'next' ? focused : 'back');
  }

  private closeDetail(refocus: boolean): void {
    if (this.detailIndex < 0) return;
    const index = this.detailIndex;
    this.detailIndex = -1;
    this.detail.hidden = true;
    this.detail.replaceChildren();
    this.grid.hidden = false;
    if (refocus) this.grid.querySelector<HTMLElement>(`.combo[data-index="${index}"] .combo-open`)?.focus();
  }
}
