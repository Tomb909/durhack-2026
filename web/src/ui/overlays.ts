// Two full-screen helpers: the setup guide (how to draw the sheet and write
// cards) and the card check (does the camera read this scrap, and as what?).
import { CARD_DEFS } from '../cards/defs';
import type { Snapshot } from '../net/link';

function overlay(id: string, title: string): { root: HTMLElement; body: HTMLElement } {
  const root = document.createElement('section');
  root.id = id;
  root.className = 'overlay';
  root.hidden = true;
  root.innerHTML = `<div class="sheet"><header><h2>${title}</h2><button type="button" class="close">Close (Esc)</button></header><div class="body"></div></div>`;
  root.addEventListener('click', (e) => {
    if (e.target === root || (e.target as HTMLElement).classList.contains('close')) root.hidden = true;
  });
  document.getElementById('ui')!.appendChild(root);
  return { root, body: root.querySelector('.body') as HTMLElement };
}

const SHEET_SVG = `<svg viewBox="0 0 210 150" role="img" aria-label="A sheet of paper with a thick rectangle drawn just inside its edge">
  <rect x="5" y="5" width="200" height="140" fill="#f4f1e8" rx="2"/>
  <rect x="16" y="16" width="178" height="118" fill="none" stroke="#111" stroke-width="4" stroke-linejoin="round"/>
  <text x="105" y="80" text-anchor="middle" font-size="11" fill="#555">play area</text></svg>`;

const CARD_SVG = `<svg viewBox="0 0 210 150" role="img" aria-label="A scrap of paper with the word WIND in thick capitals, an arrow underneath pointing right, and a blank margin around it">
  <path d="M30 42 l150 -6 l6 70 l-152 8 z" fill="#fbfaf5" stroke="#bbb"/>
  <text x="105" y="75" text-anchor="middle" font-size="34" font-family="Permanent Marker, Arial, sans-serif" fill="#111">WIND</text>
  <path d="M72 96 H138 M126 86 L138 96 L126 106" fill="none" stroke="#111" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="105" y="132" text-anchor="middle" font-size="10" fill="#a69e8c">blank margin all round</text></svg>`;

const SIDE_SVG = `<svg viewBox="0 0 210 150" role="img" aria-label="Two RAIN scraps side by side is right; one on top of the other is wrong">
  <rect x="8" y="40" width="58" height="26" fill="#fbfaf5" stroke="#bbb"/><text x="37" y="58" text-anchor="middle" font-size="11" font-family="Permanent Marker, Arial, sans-serif" fill="#111">RAIN</text>
  <rect x="8" y="74" width="58" height="26" fill="#fbfaf5" stroke="#bbb"/><text x="37" y="92" text-anchor="middle" font-size="11" font-family="Permanent Marker, Arial, sans-serif" fill="#111">RAIN</text>
  <path d="M29 117l6 6 11-13" fill="none" stroke="#86b56b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="132" y="50" width="58" height="26" fill="#fbfaf5" stroke="#bbb"/><text x="161" y="68" text-anchor="middle" font-size="11" font-family="Permanent Marker, Arial, sans-serif" fill="#111">RAIN</text>
  <rect x="140" y="60" width="58" height="26" fill="#fbfaf5" stroke="#bbb"/><text x="169" y="78" text-anchor="middle" font-size="11" font-family="Permanent Marker, Arial, sans-serif" fill="#111">RAIN</text>
  <path d="M158 110l14 14M172 110l-14 14" fill="none" stroke="#cc5138" stroke-width="3" stroke-linecap="round"/></svg>`;

const PHONE_SVG = `<svg viewBox="0 0 210 150" role="img" aria-label="A phone held 40 to 60 centimetres above the sheet, looking down">
  <rect x="78" y="10" width="54" height="16" rx="2" fill="#0d0c0a" stroke="#5c5548"/><circle cx="105" cy="26" r="3" fill="#efeadd"/>
  <path d="M105 28 L40 128 M105 28 L170 128" stroke="#a69e8c" stroke-dasharray="4 3" fill="none"/>
  <rect x="34" y="128" width="142" height="8" fill="#f4f1e8" stroke="#111"/>
  <text x="146" y="70" font-size="10" fill="#a69e8c">40–60 cm</text></svg>`;

export class Guide {
  private root: HTMLElement;
  constructor() {
    const { root, body } = overlay('guide', 'Setting up');
    this.root = root;
    const words = CARD_DEFS.map((d) => `<span class="word">${d.word}</span>`).join('');
    body.innerHTML = `
      <div class="steps">
        <figure>${SHEET_SVG}<figcaption><b>1. Mark the play area.</b> On a big light sheet (A3, or two A4s taped flat), draw one closed rectangle with a thick black marker, a finger-width in from the edge. Keep the inside clean.</figcaption></figure>
        <figure>${CARD_SVG}<figcaption><b>2. Write the cards.</b> One word per scrap of plain paper, in BLOCK CAPITALS with a thick black marker. Letters 1.5–2.5 cm tall, close together. Leave a blank margin all round. For WIND, draw a clear arrow underneath; the arrowhead points in the wind direction.</figcaption></figure>
        <figure>${SIDE_SVG}<figcaption><b>3. More scraps means more.</b> Make several of each word. Put copies side by side, never on top of each other: the camera cannot see a covered card.</figcaption></figure>
        <figure>${PHONE_SVG}<figcaption><b>4. Prop the phone above.</b> 40–60 cm up, the whole sheet in view with a little table showing on every side. Press <b>P</b> for the QR code, then tap Start camera.</figcaption></figure>
      </div>
      <p class="words"><span>The words:</span> ${words}</p>
      <p class="hint">Turning ordinary cards does nothing. WIND is directional: rotate its card to point the arrow where the wind should blow. WIND+FOREST+RAIN grows a downwind tree line; WIND+COLD makes a blizzard and blows snow off high ground. Check a new card with <b>C</b>. If left and right are swapped, press <b>R</b>.</p>`;
  }
  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }
  hide(): void {
    this.root.hidden = true;
  }
}

export class CardCheck {
  private root: HTMLElement;
  private body: HTMLElement;
  private timer = 0;
  private rows = new Map<number, HTMLTableRowElement>();
  constructor(private latest: () => Snapshot | null) {
    const { root, body } = overlay('check', 'Card check');
    this.root = root;
    this.body = body;
  }
  toggle(): void {
    this.root.hidden = !this.root.hidden;
    clearInterval(this.timer);
    if (!this.root.hidden) {
      this.render();
      this.timer = window.setInterval(() => (this.root.hidden ? clearInterval(this.timer) : this.render()), 600);
    }
  }
  hide(): void {
    this.root.hidden = true;
    clearInterval(this.timer);
  }
  private render(): void {
    const snapshot = this.latest();
    if (!snapshot || !snapshot.camera.connected) {
      this.body.innerHTML = '<p class="hint">The phone camera is not connected. Press <b>P</b> to connect it.</p>';
      return;
    }
    if (!snapshot.playArea.locked) {
      this.body.innerHTML = '<p class="hint">The camera has not found the play area yet. Make sure the whole border is in view.</p>';
      return;
    }
    // Build the table once, then keep one row per scrap and update it in place,
    // so nothing flickers between refreshes.
    let tbody = this.body.querySelector('tbody');
    if (!tbody) {
      this.rows.clear();
      this.body.innerHTML =
        '<p class="hint">Put a freshly written scrap inside the play area. If its word shows here within a second, it will work.</p>' +
        '<table><thead><tr><th>What the camera sees</th><th>Recognised as</th><th></th></tr></thead><tbody></tbody></table>' +
        '<p class="hint empty">No scraps in view.</p>';
      tbody = this.body.querySelector('tbody')!;
    }
    const entries = [
      ...snapshot.cards.map((c) => ({ id: c.id, cls: 'ok', label: (c.word ?? c.card).toUpperCase(), note: c.visible ? 'in view' : 'covered, held in place' })),
      ...snapshot.candidates.map((c) => ({ id: c.id, cls: 'no', label: 'Not a card yet', note: `read as “${c.text || '…'}”` })),
    ];
    const seen = new Set<number>();
    for (const entry of entries) {
      seen.add(entry.id);
      let row = this.rows.get(entry.id);
      if (!row) {
        row = document.createElement('tr');
        row.innerHTML = '<td><img alt=""></td><td></td><td></td>';
        tbody.appendChild(row);
        this.rows.set(entry.id, row);
      }
      void this.swap(row.querySelector('img')!, `/api/crop/${entry.id}.jpg`);
      const [, what, note] = Array.from(row.children) as HTMLElement[];
      if (what.textContent !== entry.label) what.textContent = entry.label;
      what.className = entry.cls;
      if (note.textContent !== entry.note) note.textContent = entry.note;
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.remove();
        this.rows.delete(id);
      }
    }
    (this.body.querySelector('.empty') as HTMLElement).hidden = entries.length > 0;
  }

  /** Load a fresh picture in the background; show it only once it is ready. */
  private async swap(img: HTMLImageElement, url: string): Promise<void> {
    if (img.dataset.busy) return;
    img.dataset.busy = '1';
    try {
      const response = await fetch(`${url}?t=${Date.now()}`);
      if (response.ok) {
        const old = img.src;
        img.src = URL.createObjectURL(await response.blob());
        if (old.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 1000);
      }
    } catch {
      /* keep the old picture */
    }
    delete img.dataset.busy;
  }
}
