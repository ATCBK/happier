import { describe, expect, it } from 'vitest';
import { applyAcpBackendUpsertV1 } from './catalogMutationsV1.js';
import { AcpBackendDefinitionV1Schema } from './settingsV1.js';

const registryBackend = () => AcpBackendDefinitionV1Schema.parse({
  id: 'registry-agent', name: 'registry-agent', title: 'Registry Agent',
  launch: { kind: 'npm', package: '@example/acp-agent', version: '1.0.0', args: [] },
  origin: { kind: 'registry', provenance: { sourceId: 'builtin:acp-registry', format: 'acp-registry',
    sourceUrl: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json', itemId: 'registry-agent',
    ref: { kind: 'version', version: '1.0.0' }, importedAt: 1 } },
  createdAt: 1, updatedAt: 1,
});

describe('ACP registry admission at the canonical mutation owner', () => {
  it('refuses registry admission that would replace a different catalog identity', () => {
    const backend = registryBackend();
    const command = AcpBackendDefinitionV1Schema.parse({ ...backend, origin: undefined,
      launch: { kind: 'command', command: 'my-own-agent', args: [] },
      env: { PERSONAL_SETTING: { t: 'literal', v: 'keep-me' } },
    });
    const otherSource = AcpBackendDefinitionV1Schema.parse({ ...backend,
      origin: { ...backend.origin!, provenance: { ...backend.origin!.provenance, sourceId: 'registry:other-source' } },
    });
    for (const previous of [command, otherSource]) {
      const settings = { v: 2, backends: [previous] };
      expect(applyAcpBackendUpsertV1({ settings, backend, nowMs: 2, mode: 'registryInstall' }))
        .toMatchObject({ ok: false, code: 'acp_backend_id_conflict' });
      expect(settings.backends).toEqual([previous]);
    }
    const updated = applyAcpBackendUpsertV1({ settings: { v: 2, backends: [backend] },
      backend: { ...backend, launch: { ...backend.launch, version: '2.0.0' } }, nowMs: 2, mode: 'registryInstall' });
    expect(updated).toMatchObject({ ok: true, backend: { id: backend.id, launch: { version: '2.0.0' } } });
  });

  it('preserves admitted origin for env edits and refuses direct admission or executable changes', () => {
    const backend = registryBackend();
    const current = { v: 2, backends: [backend] };
    const env = { API_KEY: { t: 'literal' as const, v: 'my-value' } };
    const { origin: _readOnlyOrigin, ...ordinaryEdit } = backend;
    const edited = applyAcpBackendUpsertV1({ settings: current, backend: { ...ordinaryEdit, env }, nowMs: 2 });
    expect(edited).toMatchObject({ ok: true, backend: { env, origin: backend.origin } });
    const admission = applyAcpBackendUpsertV1({ settings: { v: 2, backends: [] }, backend, nowMs: 2 });
    expect(admission).toMatchObject({ ok: false, code: 'registry_change_requires_install' });
    const replacement = applyAcpBackendUpsertV1({ settings: current,
      backend: { ...backend, launch: { ...backend.launch, version: '2.0.0' } }, nowMs: 2 });
    expect(replacement).toMatchObject({ ok: false, code: 'registry_change_requires_install' });
    const removal = applyAcpBackendUpsertV1({ settings: current,
      backend: { ...backend, launch: { kind: 'command', command: 'unreviewed', args: [] }, origin: undefined }, nowMs: 2 });
    expect(removal).toMatchObject({ ok: false, code: 'registry_change_requires_install' });
    expect(current.backends[0]).toEqual(backend);
  });
});
