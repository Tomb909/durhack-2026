// The small table map in the corner. It shows where every card is (real cards
// seen by the camera and simulated ones), and it is also where simulated cards
// are made: drag one from the tray onto the map or straight onto the world.
import { CARD_DEFS, onCardsChanged } from '../cards/defs';
import { modifierTargets, radiusMultiplier } from '../cards/modifiers';
import type { CardStore, LiveCard } from '../cards/store';
import { resolveWord } from '../cards/words';
import type { Candidate } from '../net/link';
import { DEFAULT_SHAPE, type WorldShape } from '../sim/world';

type Point = { x: number; y: number };

interface Drag {
  cardId: string;
  key: string | null; // null until the card has been placed
  ghost: HTMLElement | null;
}

export class TablePanel {
  private table: HTMLElement;
  private tray: HTMLElement;
  private chips = new Map<string, HTMLElement>();
  private maybes: HTMLElement[] = [];
  private drag: Drag | null = null;

  /** True while a card is being carried by the pointer (the camera should leave that press alone). */
  get dragging(): boolean {
    return this.drag !== null;
  }
  private aspect = DEFAULT_SHAPE.aspect;
  private border: SVGSVGElement;

  constructor(
    private root: HTMLElement,
    private store: CardStore,
    private canvas: HTMLElement,
    private pickWorld: (clientX: number, clientY: number) => Point | null,
  ) {
    this.table = root.querySelector('#table') as HTMLElement;
    this.border = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.border.classList.add('border');
    this.border.setAttribute('viewBox', '0 0 1 1');
    this.border.setAttribute('preserveAspectRatio', 'none');
    this.table.prepend(this.border);
    this.setShape(DEFAULT_SHAPE);
    this.tray = root.querySelector('#tray') as HTMLElement;
    this.fillTray();
    // Cards made from typed words join the tray as soon as they exist.
    onCardsChanged(() => this.fillTray());
    this.bindWordBox(root);
    // Pick up a simulated card by grabbing it in the world itself.
    canvas.addEventListener('pointerdown', (e) => {
      const at = this.pickWorld(e.clientX, e.clientY);
      if (!at) return;
      let best: LiveCard | null = null;
      let bestDistance = 0.07;
      for (const card of this.store.cards) {
        if (card.source !== 'sim' || !card.present) continue;
        const d = Math.hypot(card.tx - at.x, (card.ty - at.y) / this.aspect);
        if (d < bestDistance) {
          best = card;
          bestDistance = d;
        }
      }
      if (best) this.drag = { cardId: best.def.id, key: best.key, ghost: null };
    });
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.drop(e));
    window.addEventListener('pointercancel', (e) => this.drop(e));
  }

  /** One card in the tray per card definition, built-in first, then the ones made from words. */
  private fillTray(): void {
    this.tray.replaceChildren();
    for (const def of CARD_DEFS) {
      const el = document.createElement('div');
      el.className = `tray-card${def.origin ? ' made' : ''}${def.origin === 'fallback' ? ' guess' : ''}`;
      el.title = `Drag ${def.word} onto the table${def.reading ? `. ${def.reading}` : ''}`;
      // Text, not markup: the icon and word of a made card come from a typed word.
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = def.icon;
      const word = document.createElement('span');
      word.className = 'word';
      word.textContent = def.word;
      el.append(icon, word);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const ghost = document.createElement('div');
        ghost.className = 'ghost';
        ghost.textContent = def.icon;
        document.body.appendChild(ghost);
        this.drag = { cardId: def.id, key: null, ghost };
        this.move(e);
      });
      this.tray.appendChild(el);
    }
  }

  /** The box under the tray: type any word, and its card joins the tray and lands on the table. */
  private bindWordBox(root: HTMLElement): void {
    const form = root.querySelector('#tray-add') as HTMLFormElement | null;
    const input = root.querySelector('#tray-word') as HTMLInputElement | null;
    const status = root.querySelector('#tray-status') as HTMLElement | null;
    if (!form || !input || !status) return;
    const button = form.querySelector('button') as HTMLButtonElement;
    // Typing a word must not steer the camera or open other panels: the page's keys stop here.
    // (Only key presses stop: a key let go must still reach the page, or a W held down while
    // clicking in here would walk the camera for ever.)
    form.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') input.blur();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || button.disabled) return;
      // Read-only, not disabled: a disabled box loses the keyboard, and the next letters typed
      // would go to the page (X clears every card, F goes full screen).
      button.disabled = input.readOnly = true;
      status.className = '';
      status.textContent = `Reading ${text.toUpperCase()}…`;
      try {
        const { def, source, why, ms } = await resolveWord(text);
        const seconds = `${(ms / 1000).toFixed(1)} s`;
        status.textContent =
          source === 'built-in' ? `${def.word} is a built-in card.`
          : source === 'stored' ? `${def.word}: made before, so straight away.`
          : source === 'model' ? `${def.word}: read in ${seconds}. ${def.reading ?? ''}`
          : source === 'near' ? `Read as ${def.word}, a guess (${why}).`
          : `${def.word}: a guess from its sound, because ${why}.`;
        status.className = source === 'near' || source === 'fallback' ? 'guess' : '';
        this.placeNew(def.id);
        input.value = '';
      } catch (error) {
        status.textContent = (error as Error).message;
        status.className = 'guess';
      } finally {
        button.disabled = input.readOnly = false;
        input.focus();
      }
    });
  }

  private placed = 0;
  /** Put a newly made card on the table, each one somewhere new, unless it is already there. */
  private placeNew(cardId: string): void {
    if (this.store.cards.some((card) => card.present && card.def.id === cardId)) return;
    const spots = [[0.5, 0.5], [0.34, 0.4], [0.66, 0.4], [0.4, 0.66], [0.64, 0.64], [0.5, 0.3]];
    const [x, y] = spots[this.placed++ % spots.length];
    this.store.addSim(cardId, x, y);
  }

  /** Match the map to the play area's proportions and outline. */
  setShape(shape: WorldShape): void {
    this.aspect = shape.aspect;
    this.table.style.aspectRatio = String(shape.aspect);
    const points = shape.outline.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).join(' ');
    this.border.innerHTML = `<polygon points="${points}" vector-effect="non-scaling-stroke"/>`;
  }

  /** Table position under the pointer: on the map, or on the 3D world. */
  private locate(e: PointerEvent): Point | null {
    const rect = this.table.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x >= -0.04 && x <= 1.04 && y >= -0.06 && y <= 1.06) {
      return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    }
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (under === this.canvas) return this.pickWorld(e.clientX, e.clientY);
    return null;
  }

  private move(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const at = this.locate(e);
    if (at) {
      if (!drag.key) drag.key = this.store.addSim(drag.cardId, at.x, at.y);
      else this.store.moveSim(drag.key, at.x, at.y);
    }
    if (drag.ghost) {
      drag.ghost.style.left = `${e.clientX}px`;
      drag.ghost.style.top = `${e.clientY}px`;
      drag.ghost.style.opacity = at ? '0.35' : '1';
    }
  }

  private drop(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    drag.ghost?.remove();
    // Let go outside the table: the card is taken away.
    if (drag.key && !this.locate(e)) this.store.removeSim(drag.key);
  }

  setCandidates(candidates: Candidate[]): void {
    while (this.maybes.length > candidates.length) this.maybes.pop()!.remove();
    while (this.maybes.length < candidates.length) {
      const el = document.createElement('div');
      el.className = 'maybe';
      el.textContent = '?';
      this.table.appendChild(el);
      this.maybes.push(el);
    }
    candidates.forEach((c, i) => {
      this.maybes[i].style.left = `${c.x * 100}%`;
      this.maybes[i].style.top = `${c.y * 100}%`;
      this.maybes[i].title = c.text ? `Reading: ${c.text}` : 'Reading…';
    });
  }

  /** Call every frame. */
  update(): void {
    // The panel is put away most of the time (Tab brings it out): nothing to keep up to date
    // then. The first frame after it is shown puts every chip where it should be.
    if (this.root.hidden) return;
    const modifiersByTarget = modifierTargets(this.store.cards);
    const targetByModifier = new Map<LiveCard, LiveCard>();
    for (const [target, modifiers] of modifiersByTarget) {
      for (const modifier of modifiers) targetByModifier.set(modifier, target);
    }
    const seen = new Set<string>();
    for (const card of this.store.cards) {
      seen.add(card.key);
      const modifiers = modifiersByTarget.get(card) ?? [];
      let chip = this.chips.get(card.key);
      if (!chip) {
        chip = document.createElement('div');
        chip.textContent = card.def.icon;
        if (card.def.id === 'wind') {
          const arrow = document.createElement('span');
          arrow.className = 'wind-arrow';
          arrow.textContent = '➤';
          chip.appendChild(arrow);
        }
        chip.style.setProperty('--c', card.def.color);
        const key = card.key;
        chip.addEventListener('pointerdown', (e) => {
          const live = this.store.cards.find((c) => c.key === key || c.key.startsWith(key));
          if (!live || live.source !== 'sim') return;
          e.preventDefault();
          this.drag = { cardId: live.def.id, key: live.key, ghost: null };
        });
        chip.addEventListener('dblclick', () => this.store.removeSim(card.key));
        this.table.appendChild(chip);
        this.chips.set(card.key, chip);
      }
      const sim = card.source === 'sim';
      const modifierTarget = targetByModifier.get(card);
      chip.className = `chip ${sim ? 'sim' : 'camera'}${card.visible ? '' : ' held'}${card.def.modifier ? ' modifier-source' : ''}${modifiers.length ? ' modified' : ''}`;
      if (modifierTarget) {
        chip.title = `${card.def.word} → ${modifierTarget.def.word}: expands its local effect radius`;
      } else if (modifiers.length) {
        chip.title = `${card.def.word} + ${modifiers.map((modifier) => modifier.def.word).join('+')}: local effect radius ×${radiusMultiplier(modifiers).toFixed(2)}`;
      } else if (card.def.modifier) {
        chip.title = `${card.def.word}: place near a card, within ${Math.round(card.def.modifier.maxDistance * 100)}% of the table width`;
      } else {
        chip.title = sim ? `${card.def.word} (simulated): drag to move, drag off to remove` : `${card.def.word} (seen by the camera)`;
      }
      if (card.def.id === 'wind') {
        const compass = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
        const direction = compass[Math.round(((card.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI / 4)) % compass.length];
        chip.title = `${card.def.word}: blowing ${direction}`;
        chip.style.setProperty('--wind-angle', `${card.angle}rad`);
      }
      let badge = chip.querySelector('.modifier-badge');
      if (modifiers.length) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'modifier-badge';
          chip.appendChild(badge);
        }
        badge.textContent = `+${modifiers.map((modifier) => modifier.def.word).join('+')}`;
      } else {
        badge?.remove();
      }
      // Simulated chips sit exactly under the mouse; camera chips show the smoothed position.
      chip.style.left = `${(sim ? card.tx : card.x) * 100}%`;
      chip.style.top = `${(sim ? card.ty : card.y) * 100}%`;
      chip.style.opacity = String(Math.max(0.15, card.strength));
    }
    for (const [key, chip] of this.chips) {
      if (!seen.has(key)) {
        chip.remove();
        this.chips.delete(key);
      }
    }
  }
}
