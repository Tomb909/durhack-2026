// Dev-server side of the harness: lets the harness page save its pictures and
// numbers to .deck/harness/ (ignored by git), tells the command-line runner
// when a sheet is finished, and serves the cards made from typed words
// (.deck/words.json, read-only) so they can be drawn without the Python server.
// Only active under `vite` (never in a build).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.deck', 'harness');
/** Cards made from typed words, as the Python server stores them. */
// DECK_WORDS_FILE points the harness at another store (to draw cards without touching the real one).
export const WORDS_FILE = process.env.DECK_WORDS_FILE || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.deck', 'words.json');

/** The stored word cards as a list (empty if there are none or the file is spoiled). */
export function readWords() {
  try {
    if (!existsSync(WORDS_FILE)) return [];
    const data = JSON.parse(readFileSync(WORDS_FILE, 'utf8'));
    return Array.isArray(data?.cards) ? data.cards : [];
  } catch {
    return [];
  }
}

function body(request) {
  return new Promise((done, fail) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => done(Buffer.concat(chunks)));
    request.on('error', fail);
  });
}

/** @param {{ onDone?: (summary: unknown) => void }} [options] */
export function harnessPlugin(options = {}) {
  return {
    name: 'deck-harness',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__harness', async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const reply = (status, data) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(data));
        };
        if (request.method === 'GET' && url.pathname === '/words') return reply(200, { cards: readWords() });
        if (request.method !== 'POST') return reply(405, { error: 'POST only' });
        try {
          if (url.pathname === '/save') {
            // A plain file name only: nothing may be written outside the output folder.
            const name = url.searchParams.get('name') ?? '';
            if (!/^[\w][\w.-]{0,80}\.(jpg|png|json|txt)$/.test(name)) return reply(400, { error: 'bad name' });
            mkdirSync(HARNESS_OUT, { recursive: true });
            const path = join(HARNESS_OUT, name);
            writeFileSync(path, await body(request));
            return reply(200, { path });
          }
          if (url.pathname === '/done') {
            const summary = JSON.parse((await body(request)).toString('utf8') || '{}');
            options.onDone?.(summary);
            return reply(200, { ok: true });
          }
          return reply(404, { error: 'unknown' });
        } catch (error) {
          return reply(500, { error: String(error) });
        }
      });
    },
  };
}
