import { describe, expect, it } from 'vitest';

import { formatSharedSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import { prepareAcpCatalogTransferV2, readAcpCatalogTransferSourceV2, type AcpCatalogTransferAgentDeclarationV2 } from './transferAcpCatalogV2.js';

function transportDeclarations(acpStderrRules: AcpCatalogTransferAgentDeclarationV2['acpStderrRules']): readonly AcpCatalogTransferAgentDeclarationV2[] {
  return [{ identity: { pluginId: 'happier.agent.kiro', localId: 'kiro' }, acpStderrRules }];
}

// Observed 0.2 schema/producer basis: 37a6541578749067b49d4579be8c752c9591b8c8,
// packages/protocol/src/acpCatalog/settingsV1.ts:37–80.
function predecessorSource() {
  return {
    unrelatedPreference: 'retain',
    acpCatalogSettingsV1: {
      v: 2,
      backends: [{
        id: 'configured-kiro', name: 'configured-kiro', title: 'Configured Kiro', description: 'Custom launch',
        command: 'custom-kiro-cli', args: ['acp'],
        env: { REGION: { t: 'literal', v: 'eu' }, TOKEN: { t: 'savedSecret', secretId: 'old-token' } },
        auth: { support: 'login_terminal', machineLoginKey: 'my-login', docsUrl: 'https://example.test/auth',
          loginCommand: { command: 'custom-kiro-cli', args: ['login'] }, envVars: ['TOKEN'],
          statusCommand: ['whoami', '--format', 'json'], parser: 'kiroWhoamiJson' },
        transportProfile: 'kiro', defaultMode: 'default', defaultModel: 'model-pro',
        capabilities: { supportsLoadSession: true, supportsModes: 'yes', supportsModels: 'yes', supportsConfigOptions: 'no', promptImageSupport: 'yes' },
        createdAt: 1, updatedAt: 2,
      }, {
        id: 'generic', name: 'generic', title: 'Generic', command: 'generic-cli', transportProfile: 'generic', createdAt: 3, updatedAt: 4,
      }],
    },
  };
}

describe('prepareAcpCatalogTransferV2', () => {
  it('preserves symbolic Session references without treating them as saved secrets', () => {
    const source = predecessorSource();
    const rawSettings = { ...source, acpCatalogSettingsV1: { ...source.acpCatalogSettingsV1,
      backends: [{ ...source.acpCatalogSettingsV1.backends[1], env: {
        SESSION: { t: 'sessionAttested', field: 'sessionId' },
      } }],
    } };
    expect(readAcpCatalogTransferSourceV2({ rawSettings, sourceSettingsVersion: 17 }))
      .toMatchObject({ status: 'ready', references: [] });
    expect(prepareAcpCatalogTransferV2({ rawSettings, sourceSettingsVersion: 17 }))
      .toMatchObject({ status: 'ready', record: { definitions: [{ env: {
        SESSION: { t: 'sessionAttested', field: 'sessionId' },
      } }] } });
  });

  it('retains the complete ordered definition and remaps only proven secret references', () => {
    const rawSettings = predecessorSource();
    const before = structuredClone(rawSettings);
    const rules = { suppress: [{ includes: ['optional vendor notice'] }] };
    const prepared = prepareAcpCatalogTransferV2({ rawSettings, sourceSettingsVersion: 17,
      savedSecretRefs: new Map([['old-token', formatSharedSavedSecretRefV1('resource-token')]]), agentDeclarations: transportDeclarations(rules) });

    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') return;
    expect(prepared.sourceSettingsVersion).toBe(17);
    expect(prepared.record.definitions.map(definition => definition.id)).toEqual(['configured-kiro', 'generic']);
    expect(prepared.record.definitions[0]).toMatchObject({
      name: 'configured-kiro', title: 'Configured Kiro', description: 'Custom launch',
      launch: { kind: 'command', command: 'custom-kiro-cli', args: ['acp'] },
      env: { REGION: { t: 'literal', v: 'eu' }, TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('resource-token') } },
      auth: { support: 'login_terminal', machineLoginKey: 'my-login', docsUrl: 'https://example.test/auth',
        loginCommand: { command: 'custom-kiro-cli', args: ['login'] }, envVars: ['TOKEN'] },
      runtime: { stderrRules: rules }, compatibility: { source: 'acp-catalog-v2', authStatus: {
        statusCommand: ['whoami', '--format', 'json'], parser: 'kiroWhoamiJson',
      } }, defaultMode: 'default', defaultModel: 'model-pro', createdAt: 1, updatedAt: 2,
      capabilities: { supportsLoadSession: true, supportsModes: 'yes', supportsModels: 'yes', supportsConfigOptions: 'no', promptImageSupport: 'yes' },
    });
    expect(prepared.record.definitions[0]?.auth).not.toHaveProperty('parser');
    expect(prepared.record.definitions[1]).not.toHaveProperty('runtime');
    expect(rawSettings).toEqual(before);
  });

  it('retains authored native permission mappings when materializing contributed transport rules', () => {
    const source = predecessorSource();
    const permissionModeMapping = { 'read-only': 'ask', plan: 'plan' };
    const rawSettings = { ...source, acpCatalogSettingsV1: { ...source.acpCatalogSettingsV1,
      backends: [{ ...source.acpCatalogSettingsV1.backends[0], runtime: { permissionModeMapping } }],
    } };
    const rules = { suppress: [{ includes: ['optional vendor notice'] }] };
    expect(prepareAcpCatalogTransferV2({ rawSettings, sourceSettingsVersion: 17,
      savedSecretRefs: new Map([['old-token', formatSharedSavedSecretRefV1('resource-token')]]),
      agentDeclarations: transportDeclarations(rules),
    })).toMatchObject({ status: 'ready', record: { definitions: [{ runtime: { stderrRules: rules, permissionModeMapping } }] } });
  });

  it('refuses an incomplete secret inventory or unavailable transport contribution', () => {
    expect(prepareAcpCatalogTransferV2({ rawSettings: predecessorSource(), sourceSettingsVersion: 17 }))
      .toMatchObject({ status: 'unavailable', reason: 'saved-secret-unavailable' });
    expect(prepareAcpCatalogTransferV2({ rawSettings: predecessorSource(), sourceSettingsVersion: 17,
      savedSecretRefs: new Map([['old-token', formatSharedSavedSecretRefV1('resource-token')]]) }))
      .toMatchObject({ status: 'unavailable', reason: 'transport-contribution-unavailable' });
    expect(prepareAcpCatalogTransferV2({ rawSettings: predecessorSource(), sourceSettingsVersion: 17,
      savedSecretRefs: new Map([['old-token', formatSharedSavedSecretRefV1('resource-token')]]),
      agentDeclarations: [{ identity: { pluginId: 'external.agent', localId: 'kiro' },
        acpStderrRules: { suppress: [{ includes: ['optional vendor notice'] }] } }] }))
      .toMatchObject({ status: 'unavailable', reason: 'transport-contribution-unavailable' });
    const sharedSource = predecessorSource();
    sharedSource.acpCatalogSettingsV1.backends[0]!.env!.TOKEN!.secretId = formatSharedSavedSecretRefV1('resource-token');
    expect(prepareAcpCatalogTransferV2({ rawSettings: sharedSource, sourceSettingsVersion: 17,
      agentDeclarations: transportDeclarations({ suppress: [{ includes: ['optional vendor notice'] }] }) }))
      .toMatchObject({ status: 'ready', record: { definitions: [expect.objectContaining({ env: {
        REGION: { t: 'literal', v: 'eu' }, TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('resource-token') },
      } }), expect.objectContaining({ id: 'generic' })] } });
  });

  it('preserves unsupported sources and projects only safe independent definitions from incomplete inventory', () => {
    const valid = predecessorSource();
    const options = { sourceSettingsVersion: 17, savedSecretRefs: new Map([['old-token', formatSharedSavedSecretRefV1('resource-token')]]),
      agentDeclarations: transportDeclarations({ suppress: [{ includes: ['optional vendor notice'] }] }) };
    for (const v of [1, 3]) {
      expect(prepareAcpCatalogTransferV2({ ...options, rawSettings: { acpCatalogSettingsV1: { ...valid.acpCatalogSettingsV1, v } } }))
        .toMatchObject({ status: 'unavailable', reason: 'unsupported-source-version' });
    }
    expect(prepareAcpCatalogTransferV2({ ...options, rawSettings: { acpCatalogSettingsV1: {
      ...valid.acpCatalogSettingsV1, backends: [...valid.acpCatalogSettingsV1.backends, { id: 'broken' }],
    } } })).toMatchObject({ status: 'partial', reason: 'incomplete-inventory', record: {
      definitions: [expect.objectContaining({ id: 'configured-kiro' }), expect.objectContaining({ id: 'generic' })],
    }, diagnostics: [{ path: 'backends[2]', reason: 'invalid_definition' }] });
    expect(prepareAcpCatalogTransferV2({ ...options, rawSettings: { acpCatalogSettingsV1: {
      ...valid.acpCatalogSettingsV1, extension: { secretRef: 'unclassified-secret' },
    } } })).toMatchObject({ status: 'partial', reason: 'incomplete-inventory', record: {
      definitions: [expect.objectContaining({ id: 'configured-kiro' }), expect.objectContaining({ id: 'generic' })],
    }, diagnostics: [{ path: 'extension.secretRef', reason: 'unclassified_reference' }] });
    expect(prepareAcpCatalogTransferV2({ ...options, rawSettings: { acpCatalogSettingsV1: {
      ...valid.acpCatalogSettingsV1, backends: [{ ...valid.acpCatalogSettingsV1.backends[0], env: {
        TOKEN: { t: 'savedSecret', secretId: 'old-token', savedSecretId: 'hidden-second-reference' },
      } }, valid.acpCatalogSettingsV1.backends[1]],
    } } })).toMatchObject({ status: 'partial', reason: 'incomplete-inventory', record: {
      definitions: [expect.objectContaining({ id: 'generic' })],
    }, diagnostics: [{ path: 'backends[0].env.TOKEN.savedSecretId', reason: 'unclassified_reference' }] });
    expect(prepareAcpCatalogTransferV2({ ...options, rawSettings: { acpCatalogSettingsV1: {
      ...valid.acpCatalogSettingsV1, backends: [valid.acpCatalogSettingsV1.backends[0], valid.acpCatalogSettingsV1.backends[0], valid.acpCatalogSettingsV1.backends[1]],
    } } })).toMatchObject({ status: 'partial', reason: 'incomplete-inventory', record: {
      definitions: [expect.objectContaining({ id: 'generic' })],
    }, diagnostics: [{ path: 'backends[0]', reason: 'invalid_definition' }, { path: 'backends[1]', reason: 'invalid_definition' }] });
  });

  it('distinguishes absent source from an explicitly empty valid predecessor catalog', () => {
    expect(prepareAcpCatalogTransferV2({ rawSettings: {}, sourceSettingsVersion: 3 })).toEqual({ status: 'not-required' });
    expect(prepareAcpCatalogTransferV2({ rawSettings: { acpCatalogSettingsV1: { v: 2, backends: [] } }, sourceSettingsVersion: 3 }))
      .toEqual({ status: 'ready', sourceSettingsVersion: 3, record: { v: 1, definitions: [] } });
    // Predecessor writers emit both fields; read defaults cannot establish source authority.
    for (const source of [{}, { v: 2 }, { backends: [] }, { v: 2, backends: null }]) {
      expect(prepareAcpCatalogTransferV2({ rawSettings: { acpCatalogSettingsV1: source }, sourceSettingsVersion: 3 }))
        .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    }
  });
});

describe('readAcpCatalogTransferSourceV2', () => {
  it('opens complete original source and personal slots without mapping or runtime activation', () => {
    const rawSettings = predecessorSource();
    const sharedRef = formatSharedSavedSecretRefV1('already-shared');
    const source = { ...rawSettings, acpCatalogSettingsV1: { ...rawSettings.acpCatalogSettingsV1, backends: [
      ...rawSettings.acpCatalogSettingsV1.backends,
      { ...rawSettings.acpCatalogSettingsV1.backends[1], id: 'shared', name: 'shared', env: {
        TOKEN: { t: 'savedSecret', secretId: sharedRef },
      } },
    ] } };
    const before = structuredClone(source);
    const opened = readAcpCatalogTransferSourceV2({ rawSettings: source, sourceSettingsVersion: 17 });

    expect(opened).toMatchObject({ status: 'ready', sourceSettingsVersion: 17,
      references: [{ path: 'backends[0].env.TOKEN', secretId: 'old-token' }] });
    if (opened.status !== 'ready') return;
    expect(opened.definitions.map(definition => definition.id)).toEqual(['configured-kiro', 'generic', 'shared']);
    const { command, args, ...retainedFields } = rawSettings.acpCatalogSettingsV1.backends[0]!;
    expect(opened.definitions[0]).toMatchObject({ ...retainedFields,
      launch: { kind: 'command', command, args } });
    expect(opened.definitions[0]).not.toHaveProperty('runtime');
    expect(opened.definitions[0]).not.toHaveProperty('compatibility');
    expect(opened.definitions[2]?.env.TOKEN).toEqual({ t: 'savedSecret', secretId: sharedRef });
    expect(source).toEqual(before);
  });

  it('retains safe original siblings for repair but refuses incomplete or malformed source authority', () => {
    const valid = predecessorSource();
    const opened = readAcpCatalogTransferSourceV2({ sourceSettingsVersion: 17, rawSettings: { acpCatalogSettingsV1: {
      ...valid.acpCatalogSettingsV1, backends: [{ id: 'broken' }, ...valid.acpCatalogSettingsV1.backends],
      extension: { secretRef: 'hidden' },
    } } });
    expect(opened).toMatchObject({ status: 'partial', reason: 'incomplete-inventory', sourceSettingsVersion: 17,
      definitions: [expect.objectContaining({ id: 'configured-kiro', transportProfile: 'kiro' }), expect.objectContaining({ id: 'generic' })],
      references: [{ path: 'backends[1].env.TOKEN', secretId: 'old-token' }],
      diagnostics: [{ path: 'backends[0]', reason: 'invalid_definition' }, { path: 'extension.secretRef', reason: 'unclassified_reference' }],
    });
    const malformed = predecessorSource();
    malformed.acpCatalogSettingsV1.backends[0]!.env!.TOKEN!.secretId = 'happier:shared-secret:v1:';
    expect(readAcpCatalogTransferSourceV2({ rawSettings: malformed, sourceSettingsVersion: 17 }))
      .toEqual({ status: 'unavailable', reason: 'saved-secret-unavailable' });
    expect(readAcpCatalogTransferSourceV2({ rawSettings: {}, sourceSettingsVersion: 17 })).toEqual({ status: 'not-required' });
    expect(readAcpCatalogTransferSourceV2({ rawSettings: { acpCatalogSettingsV1: {} }, sourceSettingsVersion: 17 }))
      .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
  });
});
