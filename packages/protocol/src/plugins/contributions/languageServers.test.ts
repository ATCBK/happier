import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from './v2.js';
import { ingestPluginManifestV2 } from '../manifest/ingest.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2, derivePluginContributionRegistrationRights } from './catalog.js';

const server = {
  id: 'example', title: 'Example language', languageIds: { example: 'example-lsp', examplex: 'example-react' },
  executable: { kind: 'systemTool', id: 'example-server' }, args: ['--stdio'],
  filePatterns: ['*.example'], rootMarkers: ['example.config'],
  initializationOptions: { indexing: false }, settings: { example: { checks: true } },
};

function manifest(executableId: string) {
  return { schemaVersion: 2, id: 'com.acme.language', version: '1.0.0', displayName: 'Example language',
    runtime: { apiVersion: 1 }, contributes: {
      languageServers: [{ ...server, executable: { kind: 'systemTool', id: executableId } }],
      systemTools: [{ id: 'example-server', title: 'Example server', executableNames: ['example-server'] }],
    } };
}

describe('declared language servers', () => {
  it('retains generic static language-server declarations without requiring plugin activation', () => {
    const parsed = PluginContributesV2Schema.safeParse({ languageServers: [server] });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({ languageServers: [server] });
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => entry.manifestKey === 'languageServers');
    expect(family).toMatchObject({ activationDemand: 'none', projectionFamily: 'languageServers',
      consumer: 'language-server-host', platforms: ['cli', 'desktop'], allowedRuntimeRegistration: null });
    expect(derivePluginContributionRegistrationRights({ languageServers: [server] })).toEqual([]);
  });

  it('keeps executable and routing envelopes closed while preserving opaque server configuration', () => {
    expect(PluginContributesV2Schema.safeParse({ languageServers: [{ ...server, rootMarkers: undefined }] }).success).toBe(true);
    for (const invalid of [
      { ...server, command: 'example-server' }, { ...server, projectLocalExecutable: './node_modules/bin/server' },
      { ...server, preferredPath: '/usr/bin/server' }, { ...server, timeouts: { initializeMs: 1 } },
      { ...server, executable: { kind: 'systemTool', id: 'example-server', path: '/tmp/server' } },
      { ...server, executable: { kind: 'packaged-runtime-binary', directorySegments: ['tools'], executableBaseName: 'server' } },
      { ...server, languageIds: ['example'] }, { ...server, languageIds: { example: 1 } },
    ]) expect(PluginContributesV2Schema.safeParse({ languageServers: [invalid] }).success).toBe(false);
  });

  it('uses the existing executable reference authority and refuses dangling dependencies', () => {
    expect(ingestPluginManifestV2(manifest('example-server'))).toMatchObject({ ok: true });
    expect(ingestPluginManifestV2(manifest('missing'))).toMatchObject({ ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'plugin_manifest_dangling_reference' })]) });
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => entry.manifestKey === 'languageServers');
    expect(family?.extractReferences(server)).toEqual([
      { targetFamily: 'systemTools', reference: 'example-server', path: ['executable', 'id'] },
    ]);
    expect(family?.extractReferences({ ...server, executable: { kind: 'managedDependency', id: 'managed-server' } })).toEqual([
      { targetFamily: 'managedDependencies', reference: 'managed-server', path: ['executable', 'id'] },
    ]);
  });
});
