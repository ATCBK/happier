import { describe, expect, it } from 'vitest';

import {
  sealSavedSecretResourceStoredContentV1,
  type SavedSecretCatalogResourceV1,
} from '@happier-dev/protocol';

import {
  createSavedSecretMaterializerV1,
  type SavedSecretCatalogResourceInputV1,
} from '@/settings/secrets/savedSecretCatalog';

import { resolveValueRefPlaintext } from './resolveValueRefPlaintext';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';

const sharedRef = 'happier:shared-secret:v1:resource_1';

function resource(
  materialStatus: SavedSecretCatalogResourceV1['materialStatus'],
): SavedSecretCatalogResourceInputV1 {
  return {
    resourceId: 'resource_1',
    ownerAccountId: 'owner',
    displayName: 'shared',
    kind: 'token',
    encryptionMode: 'plain',
    revision: 1,
    materialStatus,
    storedContent: materialStatus === 'ready' ? null : sealSavedSecretResourceStoredContentV1({
      resourceId: 'resource_1',
      mode: 'plain',
      content: { v: 1, name: 'shared', kind: 'token', value: 'unused' },
    }),
  };
}

describe('resolveValueRefPlaintext', () => {
  it('resolves templates through Saved Secrets and machine literals without expanding secret text', () => {
    const diagnosticRedaction = createProviderRedactionLease({ values: [] });
    const savedSecretMaterializer = createSavedSecretMaterializerV1({
      accountSettings: {}, settingsSecretsReadKeys: [], resourceCatalogState: 'ready',
      resources: [{ ...resource('ready'), displayName: 'key', storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId: 'resource_1', mode: 'plain', content: { v: 1, name: 'key', kind: 'token', value: 'secret-{region}-${REGION}' },
      }) }],
    });
    expect(resolveValueRefPlaintext({
      valueRef: { t: 'template', template: '{region}: Bearer {api_key}', vars: {
        region: { t: 'literal', v: '${REGION}' }, api_key: { t: 'savedSecret', secretId: sharedRef },
        unused: { t: 'literal', v: '${MISSING}' },
        unusedSecret: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:missing-unused' },
      } }, savedSecretMaterializer, processEnv: { REGION: 'eu' },
      onResolvedValue: value => { if (value) diagnosticRedaction.add([value]); },
    })).toEqual({ status: 'ready', value: 'eu: Bearer secret-{region}-${REGION}' });
    expect(diagnosticRedaction.redact('echoed secret-{region}-${REGION}')).toBe('echoed [REDACTED]');
    expect(diagnosticRedaction.redact('eu: Bearer secret-{region}-${REGION}')).toBe('[REDACTED]');
    diagnosticRedaction.close();
  });

  it('preserves the failing Saved Secret reference inside a template and refuses missing placeholders', () => {
    const savedSecretMaterializer = createSavedSecretMaterializerV1({
      accountSettings: {}, settingsSecretsReadKeys: [], resources: [resource('deleted')], resourceCatalogState: 'ready',
    });
    expect(resolveValueRefPlaintext({
      valueRef: { t: 'template', template: 'Bearer {api_key}', vars: { api_key: { t: 'savedSecret', secretId: sharedRef } } },
      savedSecretMaterializer, processEnv: {},
    })).toEqual({ status: 'deleted', reference: sharedRef });
    expect(resolveValueRefPlaintext({
      valueRef: { t: 'template', template: 'Bearer {absent}', vars: {} }, processEnv: {},
    })).toEqual({ status: 'literal_unavailable' });
  });
  it('refuses a SavedSecret reference without the admitted catalog materializer', () => {
    expect(resolveValueRefPlaintext({
      valueRef: { t: 'savedSecret', secretId: sharedRef },
      processEnv: {},
    })).toEqual({ status: 'temporarily_unavailable', reference: sharedRef });
  });

  it('keeps literal expansion behavior unchanged', () => {
    const diagnosticRedaction = createProviderRedactionLease({ values: [] });
    expect(resolveValueRefPlaintext({
      valueRef: { t: 'literal', v: 'Bearer ${TOKEN}' },
      processEnv: { TOKEN: 'literal-value' },
      onResolvedValue: value => diagnosticRedaction.add([value]),
    })).toEqual({ status: 'ready', value: 'Bearer literal-value' });
    expect(diagnosticRedaction.redact('child echoed literal-value')).toBe('child echoed [REDACTED]');
    expect(diagnosticRedaction.redact('Bearer literal-value')).toBe('[REDACTED]');
    diagnosticRedaction.close();

    expect(resolveValueRefPlaintext({
      valueRef: { t: 'literal', v: '${MISSING}' },
      processEnv: {},
    })).toEqual({ status: 'literal_unavailable' });
  });

  it.each([
    ['missing', 'personal_missing', []],
    ['temporarily_unavailable', sharedRef, [resource('temporarily_unavailable')]],
    ['forbidden', sharedRef, [resource('access_removed')]],
    ['repair_required', sharedRef, [resource('update_required')]],
    ['deleted', sharedRef, [resource('deleted')]],
    ['mode_incompatible', sharedRef, [resource('recipient_mode_unsupported')]],
    ['corrupt', sharedRef, [resource('ready')]],
  ] as const)('preserves Saved Secret status %s', (expectedStatus, secretId, resources) => {
    const savedSecretMaterializer = createSavedSecretMaterializerV1({
      accountSettings: {},
      settingsSecretsReadKeys: [],
      resources,
      resourceCatalogState: 'ready',
    });

    expect(resolveValueRefPlaintext({
      valueRef: { t: 'savedSecret', secretId },
      savedSecretMaterializer,
      processEnv: {},
    })).toEqual({ status: expectedStatus, reference: secretId });
  });
});
