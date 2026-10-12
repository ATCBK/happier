import http from 'node:http';
import net from 'node:net';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';

function usage() {
  return [
    '[ui-gateway] usage:',
    '  node scripts/ui_gateway.mjs --port=<port> --backend-url=<url> --minio-port=<port> --bucket=<name>',
    '',
    'Reverse-proxy gateway. Configure UI serving on the backend with HAPPIER_SERVER_UI_DIR and HAPPIER_SERVER_UI_PREFIX.',
    '',
    'Always proxies:',
    '- UI, API, health and metrics requests to backend-url, preserving paths and headers',
    '- /v1/updates websocket upgrades to backend-url (socket.io)',
    '- /files/* to local Minio (http://127.0.0.1:<minio-port>/<bucket>/...)',
  ].join('\n');
}

function normalizePublicPath(path) {
  const p = String(path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = p.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Invalid path');
  }
  if (p.includes(':') || p.startsWith('/')) {
    throw new Error('Invalid path');
  }
  return parts.join('/');
}

function proxyHttp({ target, req, res, rewritePath = (p) => p }) {
  const url = new URL(target);
  const method = req.method || 'GET';
  const headers = { ...req.headers };
  // Let Node compute correct host
  delete headers.host;

  const upstream = http.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method,
      path: rewritePath(req.url || '/'),
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad gateway');
  });
  req.pipe(upstream);
}

function proxyUpgrade({ target, req, socket, head }) {
  const url = new URL(target);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

  const upstream = net.connect(port, url.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { ok: true }, text: usage() });
    return;
  }

  const portRaw = (kv.get('--port') ?? '').trim();
  const backendUrl = (kv.get('--backend-url') ?? '').trim();
  const minioPortRaw = (kv.get('--minio-port') ?? '').trim();
  const bucket = (kv.get('--bucket') ?? '').trim();

  const port = portRaw ? Number(portRaw) : NaN;
  const minioPort = minioPortRaw ? Number(minioPortRaw) : NaN;

  if (!backendUrl || !bucket || !Number.isFinite(port) || port <= 0 || !Number.isFinite(minioPort) || minioPort <= 0) {
    throw new Error(usage());
  }

  const server = http.createServer((req, res) => {
    try {
      const url = req.url || '/';

      // Public files proxy (Minio path-style)
      if (url.startsWith('/files/')) {
        proxyHttp({
          target: `http://127.0.0.1:${minioPort}`,
          req,
          res,
          rewritePath: (p) => {
            const raw = p.replace(/^\/files\/?/, '');
            const safe = normalizePublicPath(raw);
            return `/${encodeURIComponent(bucket)}/${safe}`;
          },
        });
        return;
      }

      // The backend's enableServeUi owns mounts, SPA readiness, sidecars and UI headers.
      proxyHttp({ target: backendUrl, req, res });
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = req.url || '';
      // socket.io upgrades for realtime updates
      if (url.startsWith('/v1/updates')) {
        proxyUpgrade({ target: backendUrl, req, socket, head });
        return;
      }
      socket.destroy();
    } catch {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  });

  await new Promise((resolvePromise) => server.listen({ port, host: '0.0.0.0' }, resolvePromise));
  // eslint-disable-next-line no-console
  console.log(`[ui-gateway] ready on http://127.0.0.1:${port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
