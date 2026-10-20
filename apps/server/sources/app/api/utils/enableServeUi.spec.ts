import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get, type IncomingHttpHeaders } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { applyEnvValues, restoreEnv, snapshotEnv } from "../testkit/env";
import { createDbTransactionMock } from '../testkit/dbMocks';
import { enableServeUi } from './enableServeUi';

vi.mock('@/storage/prisma', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/prisma')>();
  const tables = {
    homeSettings: { findUnique: async () => null },
    homeGovernancePolicy: { findUnique: async () => null },
  };
  const database = createDbTransactionMock(() => tables);
  // Substitute the database boundary for both primary and SQLite snapshot reads;
  // the Home overlay, transaction selection and serving decisions remain real.
  return { ...actual, db: database.wrapDb(tables), withSqliteReadSnapshot: database.readSnapshot };
});

async function withTempDir(prefix: string, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withApp(run: (app: FastifyInstance) => Promise<void>) {
  const app = Fastify();
  try {
    await run(app);
  } finally {
    await app.close().catch(() => {});
  }
}

function requestBytes(origin: string, path: string, acceptEncoding: string) {
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
    get(new URL(path, origin), { headers: { 'accept-encoding': acceptEncoding } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

async function withUiGateway(backend: string, run: (origin: string) => Promise<void>) {
  const { spawnTestProcess }: {
    spawnTestProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
  } = await import(new URL('../../../../../stack/scripts/testkit/core/spawn_test_process.mjs', import.meta.url).href);
  // The executable requires a nonzero port; reserve an OS-selected test port.
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test port');

  await withApp(async (files) => {
    // Minio is an external HTTP boundary. Preserve its actual path-style contract.
    files.get('/test-bucket/*', async (request, reply) => {
      reply.header('cache-control', 'public, max-age=60');
      return { path: request.url };
    });
    const filesOrigin = await files.listen({ host: '127.0.0.1', port: 0 });
    const child = spawnTestProcess(process.execPath, [
      fileURLToPath(new URL('../../../../../stack/scripts/ui_gateway.mjs', import.meta.url)),
      `--port=${address.port}`, `--backend-url=${backend}`,
      `--minio-port=${new URL(filesOrigin).port}`, '--bucket=test-bucket',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => reject(new Error(`Gateway exited (${code ?? signal}): ${output}`)));
        child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('[ui-gateway] ready')) resolve();
        });
      });
      const origin = `http://127.0.0.1:${address.port}`;
      const file = await requestBytes(origin, '/files/folder/result.json?download=1', '');
      expect(file.status).toBe(200);
      expect(file.headers['cache-control']).toBe('public, max-age=60');
      expect(JSON.parse(file.bytes.toString())).toEqual({ path: '/test-bucket/folder/result.json?download=1' });
      await run(origin);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  });
}

describe('enableServeUi (mountRoot)', () => {
  it.each([true, false])('serves PDF support assets as bytes with mountRoot=%s', async mountRoot => {
    await withTempDir('happier-ui-pdf-assets-', async dir => {
      await writeFile(join(dir, 'index.html'), '<html>app</html>');
      const assets = [
        ['map.bcmap', 'application/octet-stream'],
        ['font.pfb', 'application/x-font-type1'],
        ['profile.icc', 'application/vnd.iccprofile'],
        ['worker.js', 'text/javascript; charset=utf-8'],
      ] as const;
      const bytes = Buffer.from([0x00, 0xff, 0x41, 0x80]);
      for (const [name] of assets) await writeFile(join(dir, name), bytes);
      await withApp(async app => {
        enableServeUi(app, { dir, prefix: '/ui', mountRoot, required: false });
        await app.ready();
        for (const [name, mime] of assets) {
          const response = await app.inject({ method: 'GET', url: `${mountRoot ? '' : '/ui'}/${name}` });
          expect(response.statusCode).toBe(200);
          expect(response.headers['content-type']).toBe(mime);
          expect(response.rawPayload).toEqual(bytes);
          expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
        }
      });
    });
  });

  it.each([true, false])('serves exported web manifests as JSON with mountRoot=%s', async (mountRoot) => {
    await withTempDir('happier-ui-manifest-', async (dir) => {
      const manifest = { name: 'Happier', start_url: '/', display: 'standalone' };
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ui</body></html>\n', 'utf-8');
      await writeFile(join(dir, 'manifest.webmanifest'), JSON.stringify(manifest), 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: mountRoot ? '/' : '/ui', mountRoot, required: false });
        await app.ready();

        // The exported HTML uses an origin-relative manifest even with /ui hosting.
        for (const url of mountRoot ? ['/manifest.webmanifest?version=1'] : ['/manifest.webmanifest', '/ui/manifest.webmanifest']) {
          const res = await app.inject({ method: 'GET', url });
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toMatch(/application\/manifest\+json/i);
          expect(res.headers['cache-control']).toBe('no-cache');
          expect(res.json()).toEqual(manifest);
        }
      });
    });
  });

  it('returns 404 for a missing web manifest rather than the SPA document', async () => {
    await withTempDir('happier-ui-manifest-missing-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ui</body></html>\n', 'utf-8');
      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();
        const res = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'Not found' });
      });
    });
  });

  it('permits framing only for the exact embed route prefix, including preview', async () => {
    await withTempDir('happier-ui-framing-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        for (const url of ['/', '/session/x', '/index.html', '/embed', '/embedder/session/x', '/%65mbed/session/x']) {
          const res = await app.inject({ method: 'GET', url });
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-security-policy'], url).toBe("frame-ancestors 'none'");
        }
        for (const url of ['/embed/session/x', '/embed/new', '/embed/preview?i=preview']) {
          const res = await app.inject({ method: 'GET', url });
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-security-policy'], url).toBeUndefined();
          expect(res.headers['x-frame-options'], url).toBeUndefined();
        }
      });
    });
  });

  it('blocks framing of prefixed and missing-bundle UI responses', async () => {
    await withTempDir('happier-ui-framing-fallback-', async (dir) => {
      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/ui', mountRoot: false, required: false });
        await app.ready();
        for (const url of ['/ui/', '/ui/session/x', '/ui/embed/session/x']) {
          const res = await app.inject({ method: 'GET', url });
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-security-policy'], url).toBe("frame-ancestors 'none'");
        }
      });
    });
  });

  it('serves an opaque no-store deployment identity and stays silent when it is absent', async () => {
    await withTempDir('happier-ui-deployment-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, {
          dir,
          prefix: '/',
          mountRoot: true,
          required: false,
          deploymentId: 'j6mhK5tE-2mV_8YwQ9fZaA',
        });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/.well-known/happier-ui-deployment' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.json()).toEqual({ deploymentId: 'j6mhK5tE-2mV_8YwQ9fZaA' });
      });

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();
        const res = await app.inject({ method: 'GET', url: '/.well-known/happier-ui-deployment' });
        expect(res.statusCode).toBe(204);
        expect(res.body).toBe('');
      });
    });
  });

  it('serves index.html for SPA routes when mounted at root', async () => {
    await withTempDir('happier-ui-root-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/terminal/connect' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/i);
        expect(res.body).toContain('ok');
        expect(res.body).toContain('Welcome to Happier Server!');
      });
    });
  });

  it('prevents capability-bearing public entry URLs from becoming referrers', async () => {
    await withTempDir('happier-ui-sensitive-entry-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        for (const url of [
          '/join/invitation-bearer',
          '/auth/email/verify/verification-bearer',
          '/auth/password/reset/reset-bearer',
        ]) {
          const res = await app.inject({ method: 'GET', url });
          expect(res.statusCode).toBe(200);
          expect(res.headers['referrer-policy']).toBe('no-referrer');
        }

        for (const url of ['/', '/teams/team-1/sign-in', '/auth/password/reset']) {
          const res = await app.inject({ method: 'GET', url });
          expect(res.statusCode).toBe(200);
          expect(res.headers['referrer-policy']).toBeUndefined();
        }
      });
    });
  });

  it('serves index.html for SPA routes that contain dots in the path', async () => {
    await withTempDir('happier-ui-root-dots-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/user.profile' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/i);
        expect(res.body).toContain('ok');
        expect(res.body).toContain('Welcome to Happier Server!');
      });
    });
  });

  it('shows helpful HTML when index.html is missing', async () => {
    await withTempDir('happier-ui-missing-', async (dir) => {
      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/i);
        expect(res.body).toContain('hstack build');
        expect(res.body).toContain('Welcome to Happier Server!');
      });
    });
  });

  it.each([
    { provider: 'sqlite', mountRoot: true, gateway: false }, { provider: 'sqlite', mountRoot: false, gateway: false },
    { provider: 'sqlite', mountRoot: true, gateway: true }, { provider: 'sqlite', mountRoot: false, gateway: true },
    { provider: 'postgres', mountRoot: true, gateway: false },
  ])('does not leak absolute index.html path in production $provider fallback with $mountRoot mountRoot, gateway=$gateway', async ({ provider, mountRoot, gateway }) => {
    const envSnapshot = snapshotEnv();
    await withTempDir('happier-ui-missing-prod-', async (dir) => {
      try {
        applyEnvValues({
          NODE_ENV: 'production',
          HAPPIER_DB_PROVIDER: provider,
          HAPPIER_SERVER_UI_DEBUG_PATH: undefined,
        });
        await withApp(async (app) => {
          const prefix = mountRoot ? '' : '/ui';
          enableServeUi(app, { dir, prefix: prefix || '/', mountRoot, required: false });
          const backend = await app.listen({ host: '127.0.0.1', port: 0 });
          const check = async (origin: string) => {
            for (const path of [`${prefix}/`, `${prefix}/workflows/run-missing?view=active`, `${prefix}/join/bearer`]) {
              const res = await requestBytes(origin, path, 'br, gzip');
              const body = res.bytes.toString();
              expect(res.status, `${path}: ${body}`).toBe(200);
              expect(res.headers['content-type']).toMatch(/text\/html/i);
              expect(res.headers['cache-control']).toBe('no-cache');
              expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
              expect(res.headers['referrer-policy']).toBe(path.endsWith('/join/bearer') ? 'no-referrer' : undefined);
              expect(body).toContain('UI bundle is missing');
              expect(body).toContain('Welcome to Happier Server!');
              expect(body).not.toContain(join(dir, 'index.html'));
            }
          };
          if (gateway) await withUiGateway(backend, check);
          else await check(backend);
        });
      } finally {
        restoreEnv(envSnapshot);
      }
    });
  });

  it('serves .map files with application/json content-type', async () => {
    await withTempDir('happier-ui-root-map-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');
      await writeFile(join(dir, 'main.js.map'), JSON.stringify({ version: 3 }) + '\n', 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/main.js.map' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/json/i);
        expect(res.body).toContain('"version":3');
      });
    });
  });

  it.each([
    { mountRoot: true, gateway: false }, { mountRoot: false, gateway: false },
    { mountRoot: true, gateway: true }, { mountRoot: false, gateway: true },
  ])('serves real exported sidecars and identity over HTTP with $mountRoot mountRoot, gateway=$gateway', async ({ mountRoot, gateway }) => {
    // Expo is an external tool boundary; staging, precompression, publication,
    // routing and HTTP transport all use their real owners.
    const { exportWebPayloadToArtifactPayloadDir }: {
      exportWebPayloadToArtifactPayloadDir(options: {
        uiDir: string; payloadDir: string; env: NodeJS.ProcessEnv;
        expoExecImpl(options: { args: string[] }): Promise<void>;
      }): Promise<string>;
    } = await import(new URL('../../../../../stack/scripts/build/build_web_artifact.mjs', import.meta.url).href);
    await withTempDir('happier-ui-export-http-', async (root) => {
      const dir = join(root, 'payload');
      const html = '<!doctype html><html><script src="./assets/main.js"></script><body>' + 'exported UI '.repeat(200) + '</body></html>\n';
      const assets = [
        ['main.js', Buffer.from('console.log("exported UI");\n'.repeat(300)), 'text/javascript; charset=utf-8'],
        ['style.css', Buffer.from('.app { color: black; }\n'.repeat(300)), 'text/css; charset=utf-8'],
        ['data.json', Buffer.from(JSON.stringify({ values: Array(300).fill('exported UI') })), 'application/json; charset=utf-8'],
        ['icon.svg', Buffer.from('<svg><!--' + 'exported UI '.repeat(300) + '--></svg>'), 'image/svg+xml'],
        ['module.wasm', Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.alloc(2048)]), 'application/wasm'],
        ['main.js.map', Buffer.from(JSON.stringify({ version: 3, mappings: 'AAAA;'.repeat(300) })), 'application/json; charset=utf-8'],
        ['page.html', Buffer.from(html), 'text/html; charset=utf-8'],
      ] as const;
      const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      await exportWebPayloadToArtifactPayloadDir({
        uiDir: join(root, 'ui'), payloadDir: dir, env: {},
        expoExecImpl: async ({ args }) => {
          const output = args[args.indexOf('--output-dir') + 1];
          await mkdir(join(output, 'assets'));
          await writeFile(join(output, 'index.html'), html);
          for (const [name, bytes] of assets) await writeFile(join(output, 'assets', name), bytes);
          await writeFile(join(output, 'assets/image.png'), image);
        },
      });
      await withApp(async (app) => {
        const prefix = mountRoot ? '' : '/ui';
        for (const path of ['/v1/fixture', '/v2/fixture', '/v3/fixture', '/health', '/ready', '/metrics']) {
          app.get(path, async (request, reply) => {
            reply.header('cache-control', 'no-store');
            return { path: request.url };
          });
        }
        enableServeUi(app, { dir, prefix: prefix || '/', mountRoot, required: true, deploymentId: 'gateway-fixture-deployment' });
        const backend = await app.listen({ host: '127.0.0.1', port: 0 });
        const check = async (origin: string) => {
            const files = [
              ...assets.map(([name, bytes, mime]) => [`${prefix}/assets/${name}`, bytes, mime, mime.startsWith('text/html') ? 'no-cache' : 'public, max-age=31536000, immutable'] as const),
              ...(mountRoot ? [['/index.html', Buffer.from(html), 'text/html; charset=utf-8', 'no-cache'] as const] : []),
            ];
            for (const [path, original, mime, cache] of files) {
              for (const encoding of ['br', 'gzip', ''] as const) {
                const res = await requestBytes(origin, path, encoding);
                expect(res.status, path).toBe(200);
                expect(res.headers['content-encoding'], path).toBe(encoding || undefined);
                expect(res.headers.vary, path).toBe('Accept-Encoding');
                expect(res.headers['content-type'], path).toBe(mime);
                expect(res.headers['cache-control'], path).toBe(cache);
                expect(Number(res.headers['content-length']), path).toBe(res.bytes.length);
                // The serving owner has no ETag/Last-Modified validators today.
                expect(res.headers.etag, path).toBeUndefined();
                expect(res.headers['last-modified'], path).toBeUndefined();
                const decoded = encoding === 'br' ? brotliDecompressSync(res.bytes) : encoding === 'gzip' ? gunzipSync(res.bytes) : res.bytes;
                expect(decoded, path).toEqual(original);
                if (mime.startsWith('text/html')) {
                  expect(res.headers['content-security-policy'], path).toBe(mountRoot && path.startsWith('/embed/') ? undefined : "frame-ancestors 'none'");
                  expect(res.headers['referrer-policy'], path).toBe(path.endsWith('/join/bearer') ? 'no-referrer' : undefined);
                }
              }
            }
            // SPA responses append the server readiness marker consumed by Stack;
            // they are dynamic documents, distinct from exported HTML asset bytes.
            for (const path of [`${prefix}/`, `${prefix}/workflows?view=active`, `${prefix}/user.profile`, `${prefix}/embed/preview`, `${prefix}/join/bearer`]) {
              const res = await requestBytes(origin, path, 'br, gzip');
              expect(res.status, path).toBe(200);
              expect(res.headers['content-encoding'], path).toBeUndefined();
              expect(res.headers['cache-control'], path).toBe('no-cache');
              expect(res.bytes.toString(), path).toBe(html + '\n<!-- Welcome to Happier Server! -->\n');
              expect(res.headers['content-security-policy'], path).toBe(mountRoot && path.startsWith('/embed/') ? undefined : "frame-ancestors 'none'");
              expect(res.headers['referrer-policy'], path).toBe(path.endsWith('/join/bearer') ? 'no-referrer' : undefined);
            }
            for (const path of ['/v1/fixture?value=1', '/v2/fixture', '/v3/fixture', '/health', '/ready', '/metrics']) {
              const res = await requestBytes(origin, path, '');
              expect(res.status, path).toBe(200);
              expect(res.headers['cache-control'], path).toBe('no-store');
              expect(JSON.parse(res.bytes.toString()), path).toEqual({ path });
            }
            for (const path of ['/v1/unknown-route', '/v3/unknown-route', '/v4/unknown-route']) {
              const res = await requestBytes(origin, path, '');
              expect(res.status, path).toBe(404);
              expect(res.headers['content-type'], path).toMatch(/application\/json/i);
              expect(res.bytes.toString(), path).not.toContain(html);
            }
            const deployment = await requestBytes(origin, '/.well-known/happier-ui-deployment', '');
            expect(deployment.status).toBe(200);
            expect(deployment.headers['cache-control']).toBe('no-store');
            expect(JSON.parse(deployment.bytes.toString())).toEqual({ deploymentId: 'gateway-fixture-deployment' });
            for (const path of mountRoot ? ['/ui', '/ui/', '/ui/assets/main.js'] : ['/ui']) {
              const expected = await requestBytes(backend, path, '');
              const actual = await requestBytes(origin, path, '');
              expect(actual.status, path).toBe(expected.status);
              expect(actual.headers.location, path).toBe(expected.headers.location);
            }
            const mainPath = `${prefix}/assets/main.js`;
            for (const [accepted, selected] of [['br;q=0.5, gzip;q=0.9', 'gzip'], ['br, gzip', 'br'], ['br;q=0, gzip;q=0', undefined]] as const) {
              const res = await requestBytes(origin, mainPath, accepted);
              expect(res.headers['content-encoding']).toBe(selected);
              expect(selected === 'br' ? brotliDecompressSync(res.bytes) : selected === 'gzip' ? gunzipSync(res.bytes) : res.bytes).toEqual(assets[0][1]);
            }
            const plainImage = await requestBytes(origin, `${prefix}/assets/image.png`, 'br, gzip');
            expect(plainImage.status).toBe(200);
            expect(plainImage.headers['content-encoding']).toBeUndefined();
            expect(plainImage.headers['content-type']).toBe('image/png');
            expect(plainImage.bytes).toEqual(image);
            for (const suffix of ['.br', '.gz']) {
              await expect(readFile(join(dir, `assets/image.png${suffix}`))).rejects.toMatchObject({ code: 'ENOENT' });
            }
            await rm(join(dir, 'assets/main.js.br'));
            const gzipFallback = await requestBytes(origin, mainPath, 'br, gzip');
            expect(gzipFallback.headers['content-encoding']).toBe('gzip');
            expect(gunzipSync(gzipFallback.bytes)).toEqual(assets[0][1]);
            await rm(join(dir, 'assets/main.js.gz'));
            const fallback = await requestBytes(origin, mainPath, 'br, gzip');
            expect(fallback.status).toBe(200);
            expect(fallback.headers['content-encoding']).toBeUndefined();
            expect(fallback.headers.vary).toBe('Accept-Encoding');
            expect(fallback.bytes).toEqual(assets[0][1]);
        };
        if (gateway) await withUiGateway(backend, check);
        else await check(backend);
      });
    });
  });

  it('does not rewrite unknown API routes to index.html when mounted at root', async () => {
    await withTempDir('happier-ui-root-api-404-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        for (const url of [
          '/v1/unknown-route',
          '/v2/connect/openai-codex/profiles/work/refresh-lease',
          '/v4/connect/qualified/group',
        ]) {
          const res = await app.inject({ method: 'GET', url });
          expect(res.statusCode).toBe(404);
          expect(res.headers['content-type']).toMatch(/application\/json/i);
          expect(res.body).toContain('Not found');
        }
      });
    });
  });

  it('fails closed at startup when UI is required and index.html is missing', async () => {
    await withTempDir('happier-ui-missing-required-', async (dir) => {
      await withApp(async (app) => {
        expect(() => enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: true })).toThrow(/index\.html/i);
      });
    });
  });
});
