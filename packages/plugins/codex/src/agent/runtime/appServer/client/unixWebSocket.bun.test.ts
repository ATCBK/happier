import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

const run = promisify(execFile);
const bunAvailable = await run('bun', ['--version']).then(() => true, () => false);

async function probeBundledConnection(socketPath: string): Promise<unknown> {
  const source = fileURLToPath(new URL('./unixWebSocket.ts', import.meta.url));
  // Published plugins bundle npm ws for a Node-compatible target, then run
  // on Bun. Exercise that runtime boundary without building a CLI payload.
  const script = `
    const { createRequire } = require('node:module');
    const [source, socketPath] = process.argv.slice(1);
    const build = await Bun.build({ entrypoints: [source], target: 'node', format: 'cjs' });
    if (!build.success) throw new AggregateError(build.logs, 'Transport test bundle failed');
    const module = { exports: {} };
    new Function('module', 'exports', 'require', await build.outputs[0].text())(
      module, module.exports, createRequire(source));
    try {
      const connection = await module.exports.connectCodexUnixWebSocketJsonRpc({
        socketPath, maxFrameBytes: 4096, requestTimeoutMs: 2000,
      });
      try { console.log(JSON.stringify(await connection.client.request('test/ping'))); }
      finally { await connection.dispose(); }
    } catch (error) {
      console.log(JSON.stringify({ error: { code: error.code, syscall: error.syscall,
        transport: error.transport, socketPathLengthClass: error.socketPathLengthClass } }));
    }
  `;
  const result = await run('bun', ['--eval', script, source, socketPath], { timeout: 10_000 });
  return JSON.parse(result.stdout);
}

describe.skipIf(!bunAvailable || process.platform === 'win32')('Codex Unix WebSocket on Bun', () => {
  it('retains closed endpoint facts when the runtime does not supply a native syscall', async () => {
    const directory = await mkdtemp('/tmp/happier-codex-bun-');
    try {
      expect(await probeBundledConnection(join(directory, 'missing.sock'))).toEqual({ error: {
        code: expect.stringMatching(/^(ENOENT|ECONNREFUSED)$/),
        syscall: expect.stringMatching(/^(connect|unavailable)$/),
        transport: 'unixWebSocket', socketPathLengthClass: 'within_limit',
      } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('connects the bundled transport to its Unix endpoint and exchanges JSON-RPC', async () => {
    const directory = await mkdtemp('/tmp/happier-codex-bun-');
    const socketPath = join(directory, 'private', 'app-server.sock');
    await mkdir(join(directory, 'private'), { mode: 0o700 });
    const http = createServer();
    const sockets = new WebSocketServer({ server: http });
    sockets.on('connection', socket => socket.on('message', bytes => {
      const request = JSON.parse(String(bytes)) as { id: number };
      socket.send(JSON.stringify({ id: request.id, result: { pong: true } }));
    }));
    try {
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(socketPath, resolve);
      });
      expect(await probeBundledConnection(socketPath)).toEqual({ pong: true });
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
