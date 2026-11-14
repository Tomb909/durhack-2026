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

const CARD_SVG = `<svg viewBox="0 0 210 150" role="img" aria-label="A scrap of paper with the word WATER in thick capitals and a blank margin around it">
  <path d="M30 42 l150 -6 l6 70 l-152 8 z" fill="#fbfaf5" stroke="#bbb"/>
  <text x="105" y="88" text-anchor="middle" font-size="34" font-weight="800" font-family="Arial, sans-serif" fill="#111">WATER</text>
  <path d="M30 124 h150" stroke="#2f6fed" stroke-width="1.5"/><text x="105" y="140" text-anchor="middle" font-size="10" fill="#2f6fed">blank margin all round</text></svg>`;

const SIDE_SVG = `<svg viewBox="0 0 210 150" role="img" aria-label="Two WATER scraps side by side is right; one on top of the other is wrong">
  <rect x="8" y="40" width="58" height="26" fill="#fbfaf5" stroke="#bbb"/><text x="37" y="58" text-anchor="middle" font-size="11" font-weight="800" fill="#111">WATER</text>
  <rect x="8" y="74" width="58" height="26" fill="#fbfaf5" stroke="#bbb"/><text x="37" y="92" text-anchor="middle" font-size="11" font-weight="800" fill="#111">WATER</text>
  <text x="37" y="124" text-anchor="middle" font-size="22" fill="#15803d">✓</text>
  <rect x="132" y="50" width="58" height="26" fill="#fbfaf5" stroke="#bbb"/><text x="161" y="68" text-anchor="middle" font-size="11" font-weight="800" fill="#111">WATER</text>
  <rect x="140" y="60" width="58" height="26" fill="#fbfaf5" stroke="#bbb"/><text x="169" y="78" text-anchor="middle" font-size="11" font-weight="800" fill="#111">WATER</text>
  <text x="165" y="124" text-anchor="middle" font-size="22" fill="#b91c1c">✗</text></svg>`;

const PHONE_SVG = `<svg viewBox="0 0 210 150" role="img" aria-label="A phone held 40 to 60 centimetres above the sheet, looking down">
  <rect x="78" y="10" width="54" height="16" rx="3" fill="#222"/><circle cx="105" cy="26" r="3" fill="#2f6fed"/>
  <path d="M105 28 L40 128 M105 28 L170 128" stroke="#2f6fed" stroke-dasharray="4 3" fill="none"/>
  <rect x="34" y="128" width="142" height="8" fill="#f4f1e8" stroke="#111"/>
  <text x="182" y="80" font-size="10" fill="#555">40–60 cm</text></svg>`;

export class Guide {
  private root: HTMLElement;
  constructor() {
    const { root, body } = overlay('guide', 'Setting up');
    this.root = root;
    const words = CARD_DEFS.map((d) => `<span class="word">${d.icon} ${d.word}</span>`).join('');
    body.innerHTML = `
      <div class="steps">
        <figure>${SHEET_SVG}<figcaption><b>1. Mark the play area.</b> On a big light sheet (A3, or two A4s taped flat), draw one closed rectangle with a thick black marker, a finger-width in from the edge. Keep the inside clean.</figcaption></figure>
        <figure>${CARD_SVG}<figcaption><b>2. Write the cards.</b> One word per scrap of plain paper, in BLOCK CAPITALS with a thick black marker. Letters 1.5–2.5 cm tall, close together. Leave a blank margin all round. Nothing else on the scrap.</figcaption></figure>
        <figure>${SIDE_SVG}<figcaption><b>3. More scraps means more.</b> Make several of each word. Put copies side by side, never on top of each other: the camera cannot see a covered card.</figcaption></figure>
        <figure>${PHONE_SVG}<figcaption><b>4. Prop the phone above.</b> 40–60 cm up, the whole sheet in view with a little table showing on every side. Press <b>P</b> for the QR code, then tap Start camera.</figcaption></figure>
      </div>
      <p class="words">The words: ${words}</p>
      <p class="hint">Any angle is fine, turning a card does nothing. Check a new card with <b>C</b>. If left and right are swapped, press <b>R</b>.</p>`;
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
    const stamp = Date.now();
    const known = snapshot.cards.map(
      (c) => `<tr><td><img src="/api/crop/${c.id}.jpg?t=${stamp}" alt=""></td><td class="ok">✓ ${c.card.toUpperCase()}</td><td>${c.visible ? 'in view' : 'covered, held in place'}</td></tr>`,
    );
    const unknown = snapshot.candidates.map(
      (c) => `<tr><td><img src="/api/crop/${c.id}.jpg?t=${stamp}" alt=""></td><td class="no">✗ not a card yet</td><td>read as “${c.text || '…'}”</td></tr>`,
    );
    const rows = [...known, ...unknown].join('');
    this.body.innerHTML =
      `<p class="hint">Put a freshly written scrap inside the play area. A tick within a second means it will work.</p>` +
      (rows
        ? `<table><thead><tr><th>What the camera sees</th><th>Recognised as</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="hint">No scraps in view.</p>');
  }
}
