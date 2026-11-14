// Deck of Worlds: cards in, world out.
//   cards (camera + simulated)  ->  CardStore (smoothing)  ->  WorldSim (rules)  ->  WorldRenderer (picture)
import { CardStore } from './cards/store';
import { Link, type Snapshot } from './net/link';
import { WorldRenderer } from './render/scene';
import { WorldSim } from './sim/world';
import { CardCheck, Guide } from './ui/overlays';
import { TablePanel } from './ui/table';

const canvas = document.getElementById('world') as HTMLCanvasElement;
const store = new CardStore();
const sim = new WorldSim();
const view = new WorldRenderer(canvas);
const table = new TablePanel(document.getElementById('table-panel')!, store, canvas, (x, y) => view.pickTable(x, y));
const link = new Link();

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

function cameraLost(): void {
  if (!cameraLive) return;
  cameraLive = false;
  const adopted = store.adoptTracked();
  table.setCandidates([]);
  toast(adopted ? 'Camera lost. The cards stay put: drag them with the mouse.' : 'Camera lost. Simulated cards still work.', 6);
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
    store.setTracked(snapshot.cards);
    table.setCandidates(snapshot.candidates);
    if (snapshot.playArea.found) setStatus('live', `Camera · play area found · ${snapshot.cards.length} cards`);
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

// --- keys -------------------------------------------------------------------------

const guide = new Guide();
const cardCheck = new CardCheck(() => lastSnapshot);
const qualities = [1, 1.5, 2];
let quality = 1;
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
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
    case 'o':
      view.sway = !view.sway;
      break;
    case 'q':
      quality = (quality + 1) % qualities.length;
      view.setQuality(qualities[quality]);
      toast(`Quality ${qualities[quality]}× · ${view.gpuName}`);
      break;
    case 'x':
      store.clearSim();
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

// --- main loop ----------------------------------------------------------------------

let last = performance.now();
function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  store.update(dt);
  const frame = sim.step(store.cards, store.moving, dt);
  table.update();
  view.render(frame, store.cards, dt);
  requestAnimationFrame(tick);
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
Object.assign(window, { deck: { store, sim, view, link, shot } });
