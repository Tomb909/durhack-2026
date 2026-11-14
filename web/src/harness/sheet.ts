// The harness page: many worlds on one sheet, at once.
//
// Each world is settled straight to its final state (no fading, no easing) and
// drawn at one fixed moment, so the same address always gives the same sheet.
// Address options are listed in the README ("Harness").
import { GH, GW, WorldSim } from '../sim/world';
import { WorldRenderer } from '../render/scene';
import { LAYOUTS, resolveScenarios, type Layout, type Scenario } from './codes';
import { drawCardMarks, drawMap, MAP_LEGEND } from './map';
import { formatTable, liveCards, measure, type Row } from './metrics';

const params = new URLSearchParams(location.search);
const number = (name: string, fallback: number, min: number, max: number) => {
  const v = Number(params.get(name));
  return params.has(name) && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};
const flag = (name: string, fallback: boolean) => (params.has(name) ? !['0', 'false', 'no', 'off'].includes(params.get(name)!) : fallback);

const sheet = document.getElementById('sheet') as HTMLCanvasElement;
const report = document.getElementById('report')!;
const LABEL = 22;

type View = '3d' | 'map' | 'both';

interface Result {
  done: boolean;
  ok: boolean;
  error?: string;
  count: number;
  /** Milliseconds: everything, the rules alone, the drawing alone, and one-off setup (shader compile). */
  ms: { total: number; sim: number; draw: number; setup: number };
  rows: Row[];
  saved: string[];
  gpu: string;
}

async function save(name: string, body: Blob | string): Promise<string | null> {
  try {
    const response = await fetch(`/__harness/save?name=${encodeURIComponent(name)}`, { method: 'POST', body });
    return response.ok ? ((await response.json()) as { path: string }).path : null;
  } catch {
    return null; // not running under the dev server: nothing to save to
  }
}

const toBlob = (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the picture'))), type, 0.9));

async function run(): Promise<Result> {
  const started = performance.now();
  const view = (['3d', 'map', 'both'].includes(params.get('view') ?? '') ? params.get('view') : '3d') as View;
  const layout = (LAYOUTS.includes(params.get('layout') as Layout) ? params.get('layout') : 'cluster') as Layout;
  const scenarios: Scenario[] = resolveScenarios({ set: params.get('set'), codes: params.get('c'), layout });
  const count = scenarios.length;

  const tileW = Math.round(number('tile', 400, 80, 1920));
  const tileH = view === 'map' ? Math.round((tileW * GH) / GW) : Math.round(tileW * 0.625);
  const cell = tileH + LABEL;
  // Roughly square sheet unless told otherwise.
  const cols = Math.round(number('cols', Math.max(1, Math.min(count, Math.ceil(Math.sqrt((count * cell) / tileW)))), 1, 40));
  const rowsCount = Math.ceil(count / cols);
  const time = number('t', 6, 0, 1e6);
  const png = params.get('fmt') === 'png';
  const type = png ? 'image/png' : 'image/jpeg';
  const ext = png ? 'png' : 'jpg';

  sheet.width = cols * tileW;
  sheet.height = rowsCount * cell;
  const g = sheet.getContext('2d')!;
  g.fillStyle = '#000000';
  g.fillRect(0, 0, sheet.width, sheet.height);

  // One renderer for every tile: the shaders compile once.
  let renderer: WorldRenderer | null = null;
  let glCanvas: HTMLCanvasElement | null = null;
  let setup = 0;
  if (view !== 'map') {
    const t0 = performance.now();
    glCanvas = document.createElement('canvas');
    glCanvas.style.cssText = `position:absolute;left:-10000px;top:0;width:${tileW}px;height:${tileH}px`;
    document.body.appendChild(glCanvas);
    // The app's card labels are page elements, not part of the picture, so they cannot be copied
    // onto the sheet: give them a layer that is never shown. Each tile's title names its cards instead.
    renderer = new WorldRenderer(glCanvas, document.createElement('div'));
    renderer.setFixedSize(tileW, tileH);
    renderer.sway = false;
    renderer.showBeacons = flag('beacons', true);
    renderer.zoom = number('zoom', 1.3, 0.5, 4); // closer than the app: small tiles should be mostly world
    setup = performance.now() - t0;
  }
  const mapCanvas = document.createElement('canvas');

  const sim = new WorldSim();
  const rows: Row[] = [];
  let simMs = 0;
  let drawMs = 0;
  scenarios.forEach((s, i) => {
    const x = (i % cols) * tileW;
    const y = Math.floor(i / cols) * cell;
    const cards = liveCards(s.cards, `h${i}`);

    let t0 = performance.now();
    const frame = sim.settleNow(cards);
    rows.push({ name: s.name, code: s.code, metrics: measure(frame) });
    simMs += performance.now() - t0;

    t0 = performance.now();
    if (renderer && glCanvas) {
      renderer.renderAt(frame, cards, time);
      g.drawImage(glCanvas, x, y + LABEL, tileW, tileH);
    }
    if (view !== '3d') {
      drawMap(frame, mapCanvas);
      // Alone: the whole tile. With 3D: a small inset in the corner.
      const w = view === 'map' ? tileW : Math.round(tileW * 0.3);
      const h = Math.round((w * GH) / GW);
      const mx = view === 'map' ? x : x + 4;
      const my = view === 'map' ? y + LABEL : y + cell - h - 4;
      g.imageSmoothingEnabled = w < GW;
      g.drawImage(mapCanvas, mx, my, w, h);
      g.imageSmoothingEnabled = true;
      if (view === 'both') {
        g.strokeStyle = 'rgba(255,255,255,0.7)';
        g.lineWidth = 1;
        g.strokeRect(mx - 0.5, my - 0.5, w + 1, h + 1);
      }
      drawCardMarks(g, s.cards, mx, my, w, h);
    }
    g.fillStyle = '#000000';
    g.fillRect(x, y, tileW, LABEL);
    g.fillStyle = '#ffffff';
    g.font = '700 14px ui-monospace, Menlo, Consolas, monospace';
    g.textBaseline = 'middle';
    g.fillText(`${String(i + 1).padStart(2, '0')}-${s.name}`, x + 6, y + LABEL / 2 + 1, tileW - 12);
    if (i === 0 && renderer) {
      // The first draw compiles the shaders. Count that as setup, not drawing.
      setup += performance.now() - t0;
    } else drawMs += performance.now() - t0;
  });

  const ms = {
    total: Math.round(performance.now() - started),
    sim: Math.round(simMs),
    draw: Math.round(drawMs),
    setup: Math.round(setup),
  };

  const saved: string[] = [];
  if (flag('save', false)) {
    const keep = async (name: string, body: Blob | string) => {
      const path = await save(name, body);
      if (path) saved.push(path);
    };
    await keep(`sheet.${ext}`, await toBlob(sheet, type));
    await keep('metrics.json', JSON.stringify({ address: location.search, layout, view, ms, rows }, null, 2));
    if (flag('tiles', false)) {
      const tile = document.createElement('canvas');
      tile.width = tileW;
      tile.height = tileH;
      const tg = tile.getContext('2d')!;
      for (let i = 0; i < count; i++) {
        tg.drawImage(sheet, (i % cols) * tileW, Math.floor(i / cols) * cell + LABEL, tileW, tileH, 0, 0, tileW, tileH);
        await keep(`${String(i + 1).padStart(2, '0')}-${scenarios[i].name}.${ext}`, await toBlob(tile, type));
      }
    }
  }

  const legend = view === '3d' ? '' : `\nmap: ${MAP_LEGEND.map(([label]) => label).join(' · ')} · card positions are the coloured circles\n`;
  report.textContent =
    `${count} worlds · ${ms.total} ms total (rules ${ms.sim} ms, drawing ${ms.draw} ms, one-off setup ${ms.setup} ms)` +
    ` · tile ${tileW}×${tileH} · layout ${layout} · view ${view} · t=${time}\n${renderer ? `GPU: ${renderer.gpuName}\n` : ''}${legend}\n${formatTable(rows)}\n` +
    (saved.length ? `\nsaved:\n${saved.join('\n')}\n` : '');
  return { done: true, ok: true, count, ms, rows, saved, gpu: renderer?.gpuName ?? 'none (map only)' };
}

declare global {
  interface Window {
    harness?: Result;
  }
}

run()
  .catch((error: unknown): Result => {
    const message = error instanceof Error ? error.message : String(error);
    report.textContent = `Harness failed: ${message}`;
    return { done: true, ok: false, error: message, count: 0, ms: { total: 0, sim: 0, draw: 0, setup: 0 }, rows: [], saved: [], gpu: '' };
  })
  .then((result) => {
    window.harness = result;
    document.title = result.ok ? `Harness ✓ ${result.count} worlds in ${result.ms.total} ms` : 'Harness ✗ failed';
    // Tell the command-line runner (if there is one) that the sheet is finished.
    void fetch('/__harness/done', { method: 'POST', body: JSON.stringify({ ok: result.ok, error: result.error, count: result.count, ms: result.ms, saved: result.saved, gpu: result.gpu }) }).catch(() => {});
  });
