#!/usr/bin/env node
// Command-line harness: every card combination, settled at once.
//
//   npm --prefix web run harness                          numbers for the showcase set
//   npm --prefix web run harness -- --set subsets         every combination of cards
//   npm --prefix web run harness -- "rain*3" "forest+sun"  your own combination codes
//   npm --prefix web run harness -- --shots               also a picture sheet (headless Chrome)
//   npm --prefix web run harness -- --baseline            remember these numbers
//   npm --prefix web run harness -- --diff                what changed since the baseline
//
// Numbers need no browser and no graphics: they come straight from the world
// rules. Everything is written to .deck/harness/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { HARNESS_OUT, harnessPlugin } from './harness-plugin.mjs';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `Deck of Worlds harness

  npm --prefix web run harness -- [codes...] [options]

  codes              combination codes, one world each: rain  "rain*3"  "forest+rain+sun"  "rain*3+forest@0.8,0.6"
  --set NAMES        ready-made sets, comma separated: showcase (default), singles, pairs, subsets, copies, all
  --layout NAME      where unplaced cards go: cluster (default, together) or spread (each kind apart)
  --json             print JSON instead of a table
  --baseline         save these numbers as the baseline
  --diff             show what differs from the baseline

  --shots            also draw the sheet in headless Chrome and save it
  --view NAME        3d (default), map (flat, top-down), both (3D with a map inset)
  --tile N           tile width in pixels (default 400)
  --cols N           tiles per row (default: a roughly square sheet)
  --time N           the moment drawn, in seconds (default 6)
  --zoom N           how close the camera is (default 1.3; 1 = as in the app)
  --az N, --el N     look from N degrees round the world, and N degrees above the table (default 0 and 37)
  --no-beacons       hide the card markers
  --png              save PNG instead of JPEG
  --tiles            also save each tile as its own file
  --serve            keep the page open for a browser instead of running Chrome (prints the address)
`;

function parseArgs(argv) {
  const options = { codes: [], set: null, layout: 'cluster', view: '3d' };
  const valued = new Set(['set', 'layout', 'view', 'tile', 'cols', 'time', 'zoom', 'az', 'el']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) options.codes.push(arg);
    else if (arg === '--help') options.help = true;
    else if (valued.has(arg.slice(2))) options[arg.slice(2)] = argv[++i];
    else options[arg.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true;
  }
  return options;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

function showDiff(rows, baseline) {
  const before = new Map(baseline.rows.map((r) => [r.code, r]));
  let changed = 0;
  for (const row of rows) {
    const old = before.get(row.code);
    if (!old) {
      console.log(`+ ${row.name}  (new)`);
      changed++;
      continue;
    }
    if (old.metrics.hash === row.metrics.hash) continue;
    changed++;
    const parts = Object.keys(row.metrics)
      .filter((k) => k !== 'hash' && old.metrics[k] !== row.metrics[k])
      .map((k) => `${k} ${old.metrics[k]} → ${row.metrics[k]}`);
    console.log(`~ ${row.name}  ${parts.join(', ') || '(same summary numbers, different detail)'}`);
  }
  console.log(changed ? `\n${changed} of ${rows.length} worlds differ from the baseline.` : `All ${rows.length} worlds match the baseline.`);
}

async function shots(options, codes) {
  let finished;
  const done = new Promise((resolveDone) => (finished = resolveDone));
  const server = await createServer({
    root: WEB, configFile: false, logLevel: 'error',
    plugins: [harnessPlugin({ onDone: finished })],
    server: { port: 5199, host: '127.0.0.1' },
  });
  await server.listen();
  const port = server.httpServer.address().port;
  const query = new URLSearchParams({ save: '1', layout: options.layout, view: options.view });
  if (options.set) query.set('set', options.set);
  if (codes) query.set('c', codes);
  for (const key of ['tile', 'cols', 'zoom', 'az', 'el']) if (options[key]) query.set(key, options[key]);
  if (options.time) query.set('t', options.time);
  if (options.noBeacons) query.set('beacons', '0');
  if (options.png) query.set('fmt', 'png');
  if (options.tiles) query.set('tiles', '1');
  const address = `http://127.0.0.1:${port}/harness.html?${query}`;

  const chrome = options.serve ? null : findChrome();
  let child = null;
  let profile = null;
  if (chrome) {
    profile = mkdtempSync(join(tmpdir(), 'deck-harness-'));
    child = spawn(chrome, [
      '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--mute-audio', '--hide-scrollbars', '--window-size=1280,900', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', address,
    ], { stdio: 'ignore' });
  } else {
    console.log(options.serve ? 'Open this in a browser:' : 'No Chrome found (set CHROME_PATH). Open this in any browser:');
    console.log(`  ${address}`);
  }
  const timeout = chrome ? 90_000 : 600_000;
  const summary = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), timeout))]);
  child?.kill();
  await server.close();
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  if (!summary) throw new Error('The page never finished. Is WebGL available in this browser?');
  if (!summary.ok) throw new Error(`The page failed: ${summary.error}`);
  console.log(`\nSheet: ${summary.count} worlds in ${summary.ms.total} ms (rules ${summary.ms.sim}, drawing ${summary.ms.draw}, setup ${summary.ms.setup})`);
  if (summary.gpu) console.log(`GPU: ${summary.gpu}`);
  for (const path of summary.saved) console.log(`  ${path}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return void console.log(HELP);
  const codes = options.codes.join(';') || null;

  // The rules are plain TypeScript with no graphics, so they run here directly.
  const loader = await createServer({ root: WEB, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, ws: false, hmr: false } });
  let rows, ms;
  try {
    const { resolveScenarios } = await loader.ssrLoadModule('/src/harness/codes.ts');
    const { measureAll, formatTable } = await loader.ssrLoadModule('/src/harness/metrics.ts');
    const scenarios = resolveScenarios({ set: options.set, codes, layout: options.layout });
    ({ rows, ms } = measureAll(scenarios));
    if (options.json) console.log(JSON.stringify({ ms, rows }, null, 2));
    else console.log(`${formatTable(rows)}\n\n${rows.length} worlds settled in ${ms.toFixed(0)} ms (${(ms / rows.length).toFixed(1)} ms each).`);
  } finally {
    await loader.close();
  }

  mkdirSync(HARNESS_OUT, { recursive: true });
  const baselinePath = join(HARNESS_OUT, 'baseline.json');
  if (options.diff) {
    if (!existsSync(baselinePath)) console.log('\nNo baseline yet. Run with --baseline first.');
    else {
      console.log('');
      showDiff(rows, JSON.parse(readFileSync(baselinePath, 'utf8')));
    }
  }
  if (options.baseline) {
    writeFileSync(baselinePath, JSON.stringify({ rows }, null, 2));
    console.log(`\nBaseline saved: ${baselinePath}`);
  }
  if (options.shots || options.serve) await shots(options, codes);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`harness: ${error.message}`);
    process.exit(1);
  },
);
