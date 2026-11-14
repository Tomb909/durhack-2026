// Dev-server side of the harness: lets the harness page save its pictures and
// numbers to .deck/harness/ (ignored by git), and tells the command-line runner
// when a sheet is finished. Only active under `vite` (never in a build).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.deck', 'harness');

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
