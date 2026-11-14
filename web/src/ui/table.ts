// The small table map in the corner. It shows where every card is (real cards
// seen by the camera and simulated ones), and it is also where simulated cards
// are made: drag one from the tray onto the map or straight onto the world.
import { CARD_DEFS } from '../cards/defs';
import type { CardStore, LiveCard } from '../cards/store';
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
    root: HTMLElement,
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
    const tray = root.querySelector('#tray') as HTMLElement;
    for (const def of CARD_DEFS) {
      const el = document.createElement('div');
      el.className = 'tray-card';
      el.title = `Drag ${def.word} onto the table`;
      el.innerHTML = `<span class="icon">${def.icon}</span>${def.word}`;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const ghost = document.createElement('div');
        ghost.className = 'ghost';
        ghost.textContent = def.icon;
        document.body.appendChild(ghost);
        this.drag = { cardId: def.id, key: null, ghost };
        this.move(e);
      });
      tray.appendChild(el);
    }
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
    const seen = new Set<string>();
    for (const card of this.store.cards) {
      seen.add(card.key);
      let chip = this.chips.get(card.key);
      if (!chip) {
        chip = document.createElement('div');
        chip.textContent = card.def.icon;
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
      chip.className = `chip ${sim ? 'sim' : 'camera'}${card.visible ? '' : ' held'}`;
      chip.title = sim ? `${card.def.word} (simulated): drag to move, drag off to remove` : `${card.def.word} (seen by the camera)`;
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
