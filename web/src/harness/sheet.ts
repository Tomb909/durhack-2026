// The harness page: many worlds on one sheet, at once.
//
// Each world is settled straight to its final state (no fading, no easing) and
// drawn at one fixed moment, so the same address always gives the same sheet.
// Address options are listed in the README ("Harness").
import { LAYOUTS, resolveScenarios, type Layout, type Scenario } from './codes';
import { MAP_LEGEND } from './map';
import { formatTable, type Row } from './metrics';
import { tileHeight, TileRenderer, VIEWS, type View } from './tiles';

const params = new URLSearchParams(location.search);
const number = (name: string, fallback: number, min: number, max: number) => {
  const v = Number(params.get(name));
  return params.has(name) && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};
const flag = (name: string, fallback: boolean) => (params.has(name) ? !['0', 'false', 'no', 'off'].includes(params.get(name)!) : fallback);

const sheet = document.getElementById('sheet') as HTMLCanvasElement;
const report = document.getElementById('report')!;
const LABEL = 22;

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
  const view = (VIEWS.includes(params.get('view') as View) ? params.get('view') : '3d') as View;
  const layout = (LAYOUTS.includes(params.get('layout') as Layout) ? params.get('layout') : 'cluster') as Layout;
  const scenarios: Scenario[] = resolveScenarios({ set: params.get('set'), codes: params.get('c'), layout });
  const count = scenarios.length;

  const tileW = Math.round(number('tile', 400, 80, 1920));
  const tileH = tileHeight(tileW, view);
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

  const tiles = new TileRenderer();
  const options = { width: tileW, height: tileH, view, time, zoom: number('zoom', 1.3, 0.5, 4), beacons: flag('beacons', true) };
  const rows: Row[] = [];
  let simMs = 0;
  let drawMs = 0;
  let setup = 0;
  scenarios.forEach((s, i) => {
    const x = (i % cols) * tileW;
    const y = Math.floor(i / cols) * cell;
    const drawn = tiles.draw(g, x, y + LABEL, s.cards, options);
    rows.push({ name: s.name, code: s.code, metrics: drawn.metrics });
    simMs += drawn.simMs;
    // The first 3D draw compiles the shaders. Count that as setup, not drawing.
    if (i === 0 && view !== 'map') setup += drawn.drawMs;
    else drawMs += drawn.drawMs;

    g.fillStyle = '#000000';
    g.fillRect(x, y, tileW, LABEL);
    g.fillStyle = '#ffffff';
    g.font = '700 14px ui-monospace, Menlo, Consolas, monospace';
    g.textBaseline = 'middle';
    g.fillText(`${String(i + 1).padStart(2, '0')}-${s.name}`, x + 6, y + LABEL / 2 + 1, tileW - 12);
  });
  setup += tiles.setupMs;

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
    ` · tile ${tileW}×${tileH} · layout ${layout} · view ${view} · t=${time}\n${view !== 'map' ? `GPU: ${tiles.gpuName}\n` : ''}${legend}\n${formatTable(rows)}\n` +
    (saved.length ? `\nsaved:\n${saved.join('\n')}\n` : '');
  return { done: true, ok: true, count, ms, rows, saved, gpu: tiles.gpuName };
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
