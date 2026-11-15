// Hand of God: cards in, world out.
//   cards (camera + simulated)  ->  CardStore (smoothing)  ->  WorldSim (rules)  ->  WorldRenderer (picture)
import { onCardsChanged } from './cards/defs';
import { SeenWords } from './cards/seen';
import { CardStore } from './cards/store';
import { loadStoredCards } from './cards/words';
import { CAMERA_WORDS, WORD_CARDS } from './flags';
import { parseCode, tidyCode, type Layout } from './harness/codes';
import { Link, type Snapshot } from './net/link';
import { bindCameraInput, MOVE_KEYS, moveWithKeys } from './render/camera';
import { Ambience } from './audio/ambience';
import { audio } from './audio/engine';
import { VillageLife } from './audio/life';
import { world } from './render/common';
import { WorldRenderer } from './render/scene';
import { RECTANGLE_ONLY, SHAPE_PRESETS, WorldSim, shapesDiffer, usableShape, type WorldShape } from './sim/world';
import { Combinations } from './ui/combos';
import { CardCheck, Guide } from './ui/overlays';
import { TablePanel } from './ui/table';

const canvas = document.getElementById('world') as HTMLCanvasElement;
const store = new CardStore();
let sim = new WorldSim();
const view = new WorldRenderer(canvas, document.getElementById('labels')!);
const table = new TablePanel(document.getElementById('table-panel')!, store, canvas, (x, y) => view.pickTable(x, y));
const link = new Link();
const tablePanel = document.getElementById('table-panel') as HTMLElement;
// The hint at the bottom left says Tab opens the card panel; clicking it does the same.
document.getElementById('tab-hint')!.addEventListener('click', () => (tablePanel.hidden = false));

// --- play-area shape ----------------------------------------------------------------

let shape: WorldShape = sim.shape;
let pendingShape: WorldShape | null = null;
let lastRebuild = -Infinity;
const REBUILD_EVERY_MS = 1500;

/** Ask for the world to take a new shape. Applied in the main loop, at most every 1.5 s. */
function wantShape(next: WorldShape): void {
  if (!usableShape(next)) return; // keep the shape we have
  if (shapesDiffer(next, pendingShape ?? shape)) pendingShape = next;
  else if (pendingShape && !shapesDiffer(next, shape)) pendingShape = null;
}

function applyShape(now: number): void {
  if (!pendingShape || now - lastRebuild < REBUILD_EVERY_MS) return;
  shape = pendingShape;
  pendingShape = null;
  lastRebuild = now;
  sim = new WorldSim(shape);
  view.setShape(shape);
  table.setShape(shape);
}

// --- status, toast, connect panel -------------------------------------------------

const statusButton = document.getElementById('status')!;
const statusText = document.getElementById('status-text')!;
const toastEl = document.getElementById('toast')!;
const connectPanel = document.getElementById('connect') as HTMLElement;
const connectBody = document.getElementById('connect-body')!;
let toastTimer = 0;
let cameraLive = false;
let lastSnapshot: Snapshot | null = null;

function toast(message: string, seconds = 4): void {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), seconds * 1000);
}

function setStatus(kind: 'live' | 'warn' | 'off', text: string): void {
  statusButton.className = kind === 'off' ? '' : kind;
  statusText.textContent = text;
}

function renderConnect(): void {
  const urls = lastSnapshot?.phoneUrls ?? [];
  if (!link.up) {
    connectBody.innerHTML = '<p>The tracking server is not running. Start it with <code>uv run deck</code>. Simulated cards work without it.</p>';
    return;
  }
  if (!urls.length) {
    connectBody.innerHTML = '<p>No network found. Turn on the phone’s hotspot and join it from this laptop.</p>';
    return;
  }
  connectBody.innerHTML =
    urls.map((url, i) => `<img src="/api/qr.svg?i=${i}&t=${Date.now()}" alt="QR code for the phone camera page"><code>${url}</code>`).join('') +
    '<ol><li>Laptop joins the phone’s hotspot.</li><li>Scan with the phone’s camera.</li><li>Accept the certificate warning, then Start camera.</li></ol>';
}

statusButton.addEventListener('click', () => {
  connectPanel.hidden = !connectPanel.hidden;
  if (!connectPanel.hidden) renderConnect();
});
document.getElementById('connect-close')!.addEventListener('click', () => (connectPanel.hidden = true));

// --- camera link ------------------------------------------------------------------

// A handwritten word that is no built-in card: the model makes a card for it (cards/seen.ts).
const seenWords = new SeenWords();
seenWords.enabled = CAMERA_WORDS;
seenWords.onReading = (word) => toast(`${word} is a new word: reading it…`, 12);
seenWords.onMade = (word, { def, source, why }) =>
  toast(
    source === 'near' ? `Read ${word} as ${def.word}, a guess (${why}).`
    : source === 'fallback' ? `${word}: a guess from its sound, because ${why}.`
    : `${def.icon} ${def.word}. ${def.reading ?? ''}`,
    8,
  );

function cameraLost(): void {
  if (!cameraLive) return;
  cameraLive = false;
  const adopted = store.adoptTracked();
  table.setCandidates([]);
  // The card tray is normally hidden; bring it out so the demo can carry on by mouse.
  tablePanel.hidden = false;
  toast(adopted ? 'Camera lost. The cards stay put: drag them with the mouse.' : 'Camera lost. Drag cards from the tray.', 6);
}

link.onSnapshot = (snapshot) => {
  const urlsChanged = (lastSnapshot?.phoneUrls ?? []).join() !== snapshot.phoneUrls.join();
  lastSnapshot = snapshot;
  if (snapshot.camera.connected) {
    if (!cameraLive) {
      cameraLive = true;
      store.releaseAdopted();
      connectPanel.hidden = true;
      toast('Phone camera connected');
    }
    // Keep the last shape when the border is hidden or the camera drops.
    if (snapshot.playArea.shape) wantShape(snapshot.playArea.shape);
    const { cards, reading } = seenWords.apply(snapshot.cards);
    store.setTracked(cards);
    // A word whose card is still being made shows as "?" on the table map, like one still being read.
    table.setCandidates([...snapshot.candidates, ...reading.map((t) => ({ id: t.id, x: t.x, y: t.y, text: t.word ?? '', confidence: 1 }))]);
    if (snapshot.playArea.found) setStatus('live', `Camera · play area found · ${cards.length} cards`);
    else if (snapshot.playArea.locked) setStatus('warn', 'Camera · border hidden, holding position');
    else setStatus('warn', 'Camera · looking for the black border');
  } else {
    cameraLost();
    setStatus('off', 'Simulated cards · click to connect phone');
  }
  if (!connectPanel.hidden && urlsChanged) renderConnect();
};
link.onDown = () => {
  cameraLost();
  setStatus('off', 'Simulated cards');
};
link.connect();
setStatus('off', 'Simulated cards');

// --- the camera: drag, scroll and pinch (see render/camera.ts) -----------------------

// After the table panel, so a press that picks up a card is seen as taken.
bindCameraInput(canvas, view, () => table.dragging);
const viewReset = document.getElementById('view-reset') as HTMLElement;
viewReset.addEventListener('click', () => view.rig.reset());
let cameraHintShown = false;

// The red Reset button: after a warning, clear the simulated cards and start the world from empty.
const resetConfirm = document.getElementById('reset-confirm') as HTMLDialogElement;
document.getElementById('world-reset')!.addEventListener('click', () => {
  resetConfirm.returnValue = 'cancel';
  resetConfirm.showModal();
});
resetConfirm.addEventListener('close', () => {
  if (resetConfirm.returnValue !== 'reset') return;
  store.setSim([]);
  sim = new WorldSim(shape);
  view.rig.reset();
  toast('World reset');
});

// W A S D walk the view while held (Shift to go faster). Held keys are tracked here and applied every frame.
const moveKeys = new Set<string>();
let moveFast = false;
const isMoveKey = (key: string) => (MOVE_KEYS as readonly string[]).includes(key);
window.addEventListener('keyup', (e) => {
  moveKeys.delete(e.key.toLowerCase());
  moveFast = e.shiftKey;
});
// A key let go while the window is elsewhere is never reported: do not keep walking.
window.addEventListener('blur', () => moveKeys.clear());

// --- cards by code, with no waiting -------------------------------------------------
//   ?cards=rain*3+forest@0.8,0.6   start with these cards, already settled
//   ?instant                      no fading or easing at all (also the I key)
//   ?still=6                      freeze the picture at this moment (seconds)
// The same from the console: deck.set('forest+rain+sun')

const params = new URLSearchParams(location.search);
store.instant = params.has('instant');
const still = params.has('still') ? Number(params.get('still')) || 6 : null;
if (still !== null) view.sway = false;

/** Replace the simulated cards with a combination code and jump to the settled world. */
function setCards(code: string, layout: Layout = 'cluster'): string {
  store.setSim(parseCode(code, layout));
  sim.settleNow(store.cards);
  return tidyCode(code);
}
// Asking for either is developing: bring out the card tray (normally behind Tab).
if (params.has('cards') || params.has('instant')) tablePanel.hidden = false;
// Cards made from typed words: kept in this browser and on the server. Loaded before the
// address is read, so ?cards= can name them too.
const stored = WORD_CARDS ? loadStoredCards().catch(() => 0) : Promise.resolve(0);
onCardsChanged(() => store.refreshDefs());
if (params.has('cards')) {
  void stored.then(() => {
    try {
      setCards(params.get('cards')!, params.get('layout') === 'spread' ? 'spread' : 'cluster');
    } catch (error) {
      toast(`Cards in the address: ${(error as Error).message}`, 8);
    }
  });
}

// --- every combination, side by side (the button, V, or ?combos in the address) -----

const combos = new Combinations([document.getElementById('ui')!, canvas], (code, layout) => {
  setCards(code, layout);
  tablePanel.hidden = false; // you asked to see it live: have the cards to hand
});
document.getElementById('combos-open')!.addEventListener('click', () => combos.open());
if (params.has('combos')) combos.open();

// --- keys -------------------------------------------------------------------------

const guide = new Guide();
const cardCheck = new CardCheck(() => lastSnapshot);
const qualities = [1, 1.5, 2];
let quality = 1;
window.addEventListener('keydown', (e) => {
  moveFast = e.shiftKey;
  // ⌘, Ctrl and Alt belong to the browser. (A Mac also never reports a key let go while ⌘ is down.)
  if (e.ctrlKey || e.metaKey || e.altKey || combos.isOpen || resetConfirm.open) return void moveKeys.clear();
  if (isMoveKey(e.key.toLowerCase())) return void moveKeys.add(e.key.toLowerCase());
  if (e.key === 'Tab') {
    // Developer option: the table map and the tray of simulated cards.
    e.preventDefault();
    tablePanel.hidden = !tablePanel.hidden;
    return;
  }
  switch (e.key.toLowerCase()) {
    case 'f':
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
      break;
    case 'p':
      statusButton.click();
      break;
    case 'r':
      link.send('flip');
      toast('Table rotated 180°');
      break;
    case 'l':
      link.send('relock');
      toast('Looking for the border again');
      break;
    case 'b':
      view.showBeacons = !view.showBeacons;
      break;
    case 'h':
      document.body.classList.toggle('bare');
      break;
    case 'm':
      audio.start();
      toast(audio.toggleMute() ? 'Sound off' : 'Sound on');
      break;
    case 'o':
      view.sway = !view.sway;
      break;
    case 'q':
      quality = (quality + 1) % qualities.length;
      view.setQuality(qualities[quality]);
      toast(`Quality ${qualities[quality]}× · ${view.gpuName}`);
      break;
    case 't': {
      // The table's shape (was S, which now walks the view).
      if (RECTANGLE_ONLY) {
        toast('Play area is locked to a rectangle');
        break;
      }
      if (cameraLive) {
        toast('The camera sets the shape: draw a different border');
        break;
      }
      const names = Object.keys(SHAPE_PRESETS) as (keyof typeof SHAPE_PRESETS)[];
      const current = names.findIndex((name) => !shapesDiffer(SHAPE_PRESETS[name], pendingShape ?? shape));
      const name = names[(current + 1) % names.length];
      wantShape(SHAPE_PRESETS[name]);
      lastRebuild = -Infinity;
      toast(`Play area: ${name}`);
      break;
    }
    case 'x':
      store.clearSim();
      break;
    case 'arrowleft':
    case 'arrowright':
      e.preventDefault();
      view.rig.orbit(e.key === 'ArrowLeft' ? 60 : -60, 0);
      break;
    case 'arrowup':
    case 'arrowdown':
      e.preventDefault();
      view.rig.orbit(0, e.key === 'ArrowUp' ? 45 : -45);
      break;
    case '+':
    case '=':
      view.rig.zoomBy(1.25);
      break;
    case '-':
    case '_':
      view.rig.zoomBy(0.8);
      break;
    case '0':
      view.rig.reset();
      break;
    case 'v':
      combos.open();
      break;
    case 'i':
      store.instant = !store.instant;
      toast(store.instant ? 'Instant: no fading, the world jumps to its final state' : 'Animated');
      break;
    case 'g':
      cardCheck.hide();
      guide.toggle();
      break;
    case 'c':
      guide.hide();
      cardCheck.toggle();
      break;
    case 'escape':
      guide.hide();
      cardCheck.hide();
      connectPanel.hidden = true;
      break;
  }
});

// --- sound ------------------------------------------------------------------------
// Browsers only allow sound after a click or key press, so it starts on the first one.
const ambience = new Ambience(audio);
const village = new VillageLife(audio);
const startSound = () => audio.start();
window.addEventListener('pointerdown', startSound);
window.addEventListener('keydown', startSound);

// --- main loop ----------------------------------------------------------------------

let last = performance.now();
let frameErrors = 0;
function tick(now: number): void {
  // Ask for the next frame first: whatever goes wrong below, the picture keeps moving.
  // (An error that escaped here used to end the loop for good: a frozen world until reload.)
  requestAnimationFrame(tick);
  try {
    drawFrame(now);
  } catch (error) {
    // Say so once, then now and again: an error on every frame must not bury the console.
    if (frameErrors++ % 600 === 0) console.error('Hand of God: a frame failed', error);
  }
}

function drawFrame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  applyShape(now);
  store.update(dt);
  const frame = store.instant && store.moving ? sim.settleNow(store.cards) : sim.step(store.cards, store.moving, dt);
  table.update();
  moveWithKeys(view.rig, moveKeys, moveFast, dt);
  if (view.rig.moved && viewReset.hidden && !cameraHintShown) {
    // The first time someone takes the camera, say what else it does (once: after that it is noise).
    cameraHintShown = true;
    toast('Drag to turn · scroll or pinch to zoom · W A S D to move · double-click to reset', 7);
  }
  viewReset.hidden = !view.rig.moved;
  const pose = view.rig.target;
  ambience.update(frame, { x: pose.panX / world.w + 0.5, y: pose.panZ / world.d + 0.5, zoom: pose.zoom }, dt);
  village.update(ambience.soundscape, pose.zoom, dt);
  // Behind the Combinations view nothing can be seen: do not spend the GPU drawing it.
  if (combos.isOpen) view.advance(dt);
  else if (still !== null) view.renderAt(frame, store.cards, still);
  else view.render(frame, store.cards, dt);
}
requestAnimationFrame(tick);

/** Development aid: save a picture of the world to the server (.deck/shot.jpg). */
async function shot(): Promise<string> {
  view.render(sim.step(store.cards, store.moving, 0), store.cards, 0);
  const blob = await (await fetch(canvas.toDataURL('image/jpeg', 0.88))).blob();
  await fetch('/api/shot', { method: 'POST', body: blob });
  return `${canvas.width}x${canvas.height}`;
}

// Handy when poking around in the browser console.
Object.assign(window, {
  deck: {
    store, view, link, shot, set: setCards,
    get sim() { return sim; },
    get shape() { return shape; },
  },
});
