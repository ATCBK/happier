import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { resolve } from 'node:path';
import * as tar from 'tar';
import { MarketplaceIndexEntryV1Schema, deriveMarketplaceNpmCompatibilityPlatformsV1 } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace/marketplaceSourceRegistryV1';

import { createEphemeralTlsServerFixture } from '../../../../tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

// Registry-only test tooling. The author package imports the public SDK only.
// Feed this server the archive produced by `happier plugins pack`, so discovery
// and installation consume the same generated manifest/discovery projection.
const archivePath = process.argv[2];
if (!archivePath) throw new Error('Usage: node registry.mjs <plugin.tgz> [port] [existing-tls-dir]');
const archive = await readFile(resolve(archivePath));
let packageJson;
await tar.t({ file: resolve(archivePath), onReadEntry(entry) {
  if (entry.path !== 'package/package.json') { entry.resume(); return; }
  const chunks = [];
  entry.on('data', chunk => chunks.push(chunk));
  entry.on('end', () => { packageJson = JSON.parse(Buffer.concat(chunks).toString('utf8')); });
} });
if (!packageJson?.happier?.marketplaceDiscovery) throw new Error('Packed marketplace discovery projection is required');
const discovery = packageJson.happier.marketplaceDiscovery;
const compatibility = packageJson.happier.compatibilityProjection;
const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
// An existing TLS directory keeps the CA a QA daemon already trusts across registry restarts.
const tlsDir = process.argv[4] ? resolve(process.argv[4]) : null;
const tls = tlsDir
  ? { caCertificatePath: `${tlsDir}/ca-certificate.pem`, leafCertificatePath: `${tlsDir}/server-certificate.pem`,
      privateKeyPath: `${tlsDir}/server-private-key.pem`, cleanup: async () => {} }
  : await createEphemeralTlsServerFixture();
let origin;
const server = createServer({ key: await readFile(tls.privateKeyPath), cert: await readFile(tls.leafCertificatePath) }, (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  const path = new URL(request.url ?? '/', origin).pathname;
  if (path === '/plugin.tgz') {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(archive);
    return;
  }
  let body;
  if (path === '/-/ping') {
    body = {};
  } else if (path === '/catalog.json') {
    body = {
      source: { id: deriveMarketplaceSourceId(`${origin}/catalog.json`), title: 'External capability fixture', kind: 'user', sourceUrl: `${origin}/catalog.json` },
      freshness: { state: 'fresh', fetchedAtMs: Date.now() },
      entries: [MarketplaceIndexEntryV1Schema.parse({
        pluginId: discovery.pluginId,
        publisher: { id: 'qa', displayName: 'QA fixture' },
        display: discovery.display,
        distribution: { kind: 'npm', registryOrigin: origin, packageName: packageJson.name, version: packageJson.version, integrity },
        manifestDigest: discovery.manifestDigest,
        compatibility: {
          ...compatibility.manifest.engines,
          platforms: deriveMarketplaceNpmCompatibilityPlatformsV1(compatibility),
        },
        summary: discovery.summary,
        review: { status: 'unreviewed', reviewedAt: null },
        categories: [], media: [], updatePolicy: 'allowed', links: {},
      })],
      diagnostics: [], picks: [],
    };
  } else if (decodeURIComponent(path) === `/${packageJson.name}`) {
    body = { name: packageJson.name, 'dist-tags': { latest: packageJson.version }, versions: {
      [packageJson.version]: { ...packageJson, dist: { tarball: `${origin}/plugin.tgz`, integrity } },
    } };
  } else {
    response.writeHead(404); response.end(); return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
});
await new Promise((ready, reject) => {
  server.once('error', reject);
  server.listen(Number(process.argv[3] ?? 0), '127.0.0.1', ready);
});
origin = `https://127.0.0.1:${server.address().port}`;
console.log(JSON.stringify({ origin, catalogUrl: `${origin}/catalog.json`, caCertificatePath: tls.caCertificatePath,
  leafCertificatePath: tls.leafCertificatePath, pluginId: discovery.pluginId, packageName: packageJson.name, version: packageJson.version }));
const stop = async () => {
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  await tls.cleanup();
};
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
