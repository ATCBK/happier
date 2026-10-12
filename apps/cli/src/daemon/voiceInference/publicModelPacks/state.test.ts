import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveVoiceModelPackDirectoryKeyV1,
  type InstalledVoiceModelPackMetadataV1,
} from '@happier-dev/voice-modelpacks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDaemonPublicVoiceModelPackStateStore } from './state';

let root: string;
let stateFilePath: string;

const metadata: InstalledVoiceModelPackMetadataV1 = {
  schemaVersion: 1,
  identity: { pluginId: 'acme.speech', packId: 'english' },
  directoryKey: deriveVoiceModelPackDirectoryKeyV1({ pluginId: 'acme.speech', packId: 'english' }),
  pluginVersion: '2.0.0',
  artifactBinding: { kind: 'sourceIntegrity', integrity: `sha256:${'b'.repeat(64)}` },
  packVersion: '1.0.0',
  manifestDigest: 'c'.repeat(64),
  verifiedAtMs: 100,
};
const licenseBinding = {
  licenseSourceUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
  licenseTextDigest: `sha256:${'c'.repeat(64)}`,
  artifactBinding: metadata.artifactBinding,
} as const;

const legacyDigestBoundMetadata = (() => {
  const { artifactBinding: _artifactBinding, ...withoutBinding } = metadata;
  return {
    ...withoutBinding,
    pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
  };
})();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-state-'));
  stateFilePath = join(root, 'voiceInference', 'public-model-packs.v1.json');
  await mkdir(join(root, 'voiceInference'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('daemon public voice model-pack durable state', () => {
  it('drops retired stored fields recursively while keeping write admission strict', async () => {
    const owner = createDaemonPublicVoiceModelPackStateStore({ stateFilePath, accountId: 'account-a', machineId: 'machine-a' });
    const localMetadata: InstalledVoiceModelPackMetadataV1 = { ...metadata, artifactBinding: {
      kind: 'materialization', sourceCustody: { kind: 'development', registeredRootId: 'root-a' },
    } };
    await owner.recordInstalled(localMetadata);
    await owner.acceptLicense({ identity: metadata.identity, packVersion: metadata.packVersion,
      licenseId: 'Apache-2.0', ...licenseBinding, artifactBinding: localMetadata.artifactBinding, acceptedAtMs: 200 });
    const canonical = JSON.parse(await readFile(stateFilePath, 'utf8'));
    const stored = structuredClone(canonical);
    stored.retired = true;
    stored.installed[0].retired = true;
    stored.installed[0].identity.retired = true;
    stored.installed[0].artifactBinding.retired = true;
    stored.installed[0].artifactBinding.sourceCustody.retired = true;
    stored.licenseAcceptances[0].retired = true;
    stored.licenseAcceptances[0].artifactBinding.retired = true;
    stored.licenseAcceptances[0].artifactBinding.sourceCustody.retired = true;
    const cleanupIdentity = { pluginId: 'acme.speech', packId: 'obsolete' };
    const cleanup = { identity: cleanupIdentity, directoryKey: deriveVoiceModelPackDirectoryKeyV1(cleanupIdentity) };
    stored.unboundInstalled = [{ ...cleanup, retired: true, identity: { ...cleanupIdentity, retired: true } }];
    await writeFile(stateFilePath, JSON.stringify(stored));
    const restarted = createDaemonPublicVoiceModelPackStateStore({ stateFilePath, accountId: 'account-a', machineId: 'machine-a' });
    expect(await restarted.read()).toEqual({ ...canonical, unboundInstalled: [cleanup] });
    const extraMetadata = { ...localMetadata, retired: true };
    const extraIdentity = { ...localMetadata, identity: { ...metadata.identity, retired: true } };
    await expect(restarted.recordInstalled(extraMetadata)).rejects.toThrow();
    await expect(restarted.recordInstalled(extraIdentity)).rejects.toThrow();
    const inheritedMetadata: InstalledVoiceModelPackMetadataV1 = Object.create(localMetadata);
    await expect(restarted.recordInstalled(inheritedMetadata)).rejects.toThrow('voice_model_pack_state_invalid');
    const nonEnumerableUsage = Object.defineProperty({ ...localMetadata }, 'lastUsedAt', { value: 300 });
    await expect(restarted.recordInstalled(nonEnumerableUsage)).rejects.toThrow('voice_model_pack_state_invalid');
    await restarted.recordLoaded(metadata.identity, 300);
    expect(JSON.parse(await readFile(stateFilePath, 'utf8'))).toEqual({ ...canonical,
      installed: [{ ...localMetadata, lastUsedAt: 300 }], unboundInstalled: [cleanup] });
  });

  it('rechecks effect authority inside queued install and removal commits without changing durable state on refusal', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({ stateFilePath, accountId: 'account-a', machineId: 'machine-a' });
    await store.recordInstalled(metadata);
    const denied = Object.assign(new Error('authority changed'), { code: 'unauthorized' });
    const usage = store.recordLoaded(metadata.identity, 200);
    const removal = store.removeInstalled(metadata.identity, { beforeEffect: async () => {
      expect(JSON.parse(await readFile(stateFilePath, 'utf8')).installed[0].lastUsedAt).toBe(200);
      throw denied;
    } });
    await usage;
    await expect(removal).rejects.toBe(denied);
    await expect(store.recordInstalled({ ...metadata, lastUsedAt: 300 }, { beforeEffect: async () => { throw denied; } })).rejects.toBe(denied);
    const restarted = createDaemonPublicVoiceModelPackStateStore({ stateFilePath, accountId: 'account-a', machineId: 'machine-a' });
    expect((await restarted.read()).installed).toEqual([{ ...metadata, lastUsedAt: 200 }]);
  });
  it('reads older metadata without usage and cannot resurrect a removed install with a late load', async () => {
    await writeFile(stateFilePath, JSON.stringify({
      schemaVersion: 1,
      accountId: 'account-a',
      machineId: 'machine-a',
      installed: [metadata],
      licenseAcceptances: [],
    }), 'utf8');
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    expect((await store.read()).installed).toEqual([metadata]);
    await expect(store.recordInstalled({ ...metadata, lastUsedAt: -1 })).rejects.toThrow('voice_model_pack_state_invalid');
    await expect(store.recordLoaded(metadata.identity, 200)).resolves.toBe(true);
    expect((await store.read()).installed).toEqual([{ ...metadata, lastUsedAt: 200 }]);
    const removed = store.removeInstalled(metadata.identity);
    const lateLoad = store.recordLoaded(metadata.identity, 300);
    await expect(removed).resolves.toBe(true);
    await expect(lateLoad).resolves.toBe(false);
    const restarted = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    expect((await restarted.read()).installed).toEqual([]);
  });

  it('persists structured installed identity and exact account/machine-bound license acceptance', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await store.recordInstalled(metadata);
    await store.acceptLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Apache-2.0',
      ...licenseBinding,
      acceptedAtMs: 200,
    });

    const restarted = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await expect(restarted.read()).resolves.toMatchObject({
      schemaVersion: 1,
      accountId: 'account-a',
      machineId: 'machine-a',
      installed: [{ identity: metadata.identity, directoryKey: metadata.directoryKey }],
      licenseAcceptances: [{
        accountId: 'account-a',
        executionHost: 'daemon',
        hostId: 'machine-a',
        pluginId: 'acme.speech',
        packId: 'english',
        packVersion: '1.0.0',
        licenseId: 'Apache-2.0',
        ...licenseBinding,
        acceptedAtMs: 200,
      }],
    });
  });

  it('round-trips local materialization custody without aliasing it to an external source-integrity value', async () => {
    const localMetadata: InstalledVoiceModelPackMetadataV1 = {
      ...metadata,
      artifactBinding: {
        kind: 'materialization',
        sourceCustody: { kind: 'development', registeredRootId: 'generation-local-1' },
      },
    };
    const localArtifactBinding = localMetadata.artifactBinding;
    if (localArtifactBinding.kind !== 'materialization') {
      throw new Error('local fixture must use materialization custody');
    }
    const localLicenseBinding = {
      ...licenseBinding,
      artifactBinding: localArtifactBinding,
    } as const;
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await store.recordInstalled(localMetadata);
    await store.acceptLicense({
      identity: localMetadata.identity,
      packVersion: localMetadata.packVersion,
      licenseId: 'Apache-2.0',
      ...localLicenseBinding,
      acceptedAtMs: 200,
    });

    const restarted = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await expect(restarted.read()).resolves.toMatchObject({
      installed: [expect.objectContaining({ artifactBinding: localMetadata.artifactBinding })],
      licenseAcceptances: [expect.objectContaining({ artifactBinding: localMetadata.artifactBinding })],
    });
    await expect(restarted.findAcceptedLicense({
      identity: localMetadata.identity,
      packVersion: localMetadata.packVersion,
      licenseId: 'Apache-2.0',
      licenseSourceUrl: localLicenseBinding.licenseSourceUrl,
      licenseTextDigest: localLicenseBinding.licenseTextDigest,
      artifactBinding: {
        kind: 'sourceIntegrity',
        integrity: localArtifactBinding.sourceCustody.registeredRootId,
      },
    })).resolves.toBeUndefined();
  });

  it('preserves the exact validated license URL used by the contribution binding', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    const exactLicenseUrl = 'https://licenses.example.test';

    await store.acceptLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Example-1.0',
      licenseSourceUrl: exactLicenseUrl,
      licenseTextDigest: licenseBinding.licenseTextDigest,
      artifactBinding: licenseBinding.artifactBinding,
      acceptedAtMs: 200,
    });

    await expect(store.read()).resolves.toMatchObject({
      licenseAcceptances: [{ licenseSourceUrl: exactLicenseUrl }],
    });
  });

  it('fails closed across account or machine scope without deleting the durable file', async () => {
    const owner = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await owner.recordInstalled(metadata);
    const before = await readFile(stateFilePath, 'utf8');

    const wrongAccount = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-b',
      machineId: 'machine-a',
    });
    await expect(wrongAccount.read()).rejects.toThrow('voice_model_pack_state_scope_mismatch');
    expect(await readFile(stateFilePath, 'utf8')).toBe(before);
  });

  it('retains legacy unbound license records but never returns them as accepted', async () => {
    await writeFile(stateFilePath, JSON.stringify({
      schemaVersion: 1,
      accountId: 'account-a',
      machineId: 'machine-a',
      installed: [],
      licenseAcceptances: [{
        pluginId: 'acme.speech',
        packId: 'english',
        packVersion: '1.0.0',
        licenseId: 'Apache-2.0',
        pluginSourceDigest: legacyDigestBoundMetadata.pluginSourceDigest,
      }],
    }), 'utf8');
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });

    const state = await store.read();
    expect(state.licenseAcceptances).toEqual([]);
    expect(state.unboundLicenseAcceptances).toHaveLength(1);
    await store.recordInstalled(metadata);
    const durable = JSON.parse(await readFile(stateFilePath, 'utf8')) as {
      unboundLicenseAcceptances?: unknown[];
    };
    expect(durable.unboundLicenseAcceptances).toHaveLength(1);
  });

  it('quarantines a syntactically bound acceptance whose account or host disagrees with the state envelope', async () => {
    await writeFile(stateFilePath, JSON.stringify({
      schemaVersion: 1,
      accountId: 'account-a',
      machineId: 'machine-a',
      installed: [],
      licenseAcceptances: [{
        accountId: 'account-b',
        executionHost: 'daemon',
        hostId: 'machine-a',
        pluginId: 'acme.speech',
        packId: 'english',
        packVersion: '1.0.0',
        licenseId: 'Apache-2.0',
        licenseSourceUrl: licenseBinding.licenseSourceUrl,
        licenseTextDigest: licenseBinding.licenseTextDigest,
        artifactBinding: licenseBinding.artifactBinding,
        acceptedAtMs: 200,
      }],
    }), 'utf8');
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });

    const state = await store.read();
    expect(state.licenseAcceptances).toEqual([]);
    expect(state.unboundLicenseAcceptances).toHaveLength(1);
  });

  it('rejects installed metadata whose directory key does not match its structured identity', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await expect(store.recordInstalled({ ...metadata, directoryKey: 'vp-wrong' }))
      .rejects.toThrow('voice_model_pack_directory_key_mismatch');
  });

  it('rejects duplicate durable installed identities instead of choosing one record by order', async () => {
    await writeFile(stateFilePath, JSON.stringify({
      schemaVersion: 1,
      accountId: 'account-a',
      machineId: 'machine-a',
      installed: [metadata, { ...metadata, packVersion: '2.0.0' }],
      licenseAcceptances: [],
    }), 'utf8');
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await expect(store.read()).rejects.toThrow('voice_model_pack_state_duplicate_identity');
  });

  it('invalidates acceptance by exact source, version, or license without removing its record', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await store.acceptLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Apache-2.0',
      ...licenseBinding,
      acceptedAtMs: 200,
    });
    await expect(store.findAcceptedLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Apache-2.0',
      ...licenseBinding,
    })).resolves.toMatchObject({ acceptedAtMs: 200 });
    await expect(store.findAcceptedLicense({
      identity: metadata.identity,
      packVersion: '2.0.0',
      licenseId: 'Apache-2.0',
      ...licenseBinding,
    })).resolves.toBeUndefined();
    await expect(store.findAcceptedLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Commercial-1',
      ...licenseBinding,
    })).resolves.toBeUndefined();
    await expect(store.findAcceptedLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Apache-2.0',
      ...licenseBinding,
      artifactBinding: { kind: 'sourceIntegrity', integrity: `sha256:${'d'.repeat(64)}` },
    })).resolves.toBeUndefined();
    expect((await store.read()).licenseAcceptances).toHaveLength(1);
  });

  it('removes installed metadata by structured identity and keeps that removal after restart', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await store.recordInstalled(metadata);

    await expect(store.removeInstalled(metadata.identity)).resolves.toBe(true);
    await expect(store.removeInstalled(metadata.identity)).resolves.toBe(false);

    const restarted = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await expect(restarted.read()).resolves.toMatchObject({ installed: [] });
  });

  it('quarantines old digest-bound metadata as cleanup-only and removes it without loading it', async () => {
    await writeFile(stateFilePath, JSON.stringify({
      schemaVersion: 1,
      accountId: 'account-a',
      machineId: 'machine-a',
      installed: [legacyDigestBoundMetadata],
      licenseAcceptances: [],
    }), 'utf8');
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });

    const state = await store.read();
    expect(state.installed).toEqual([]);
    expect((state as typeof state & {
      unboundInstalled?: readonly Readonly<{ identity: typeof metadata.identity; directoryKey: string }> [];
    }).unboundInstalled).toEqual([{
      identity: metadata.identity,
      directoryKey: metadata.directoryKey,
    }]);
    await expect(store.removeInstalled(metadata.identity)).resolves.toBe(true);
    await expect(store.read()).resolves.toMatchObject({ installed: [], unboundInstalled: [] });
  });

  it('forward-reads obsolete generation-bound development metadata as cleanup-only after restart', async () => {
    const obsoleteGenerationBoundMetadata = {
      ...metadata,
      artifactBinding: {
        kind: 'materialization',
        immutableGenerationId: 'generation-local-1',
      },
    };
    await writeFile(stateFilePath, JSON.stringify({
      schemaVersion: 1,
      accountId: 'account-a',
      machineId: 'machine-a',
      installed: [obsoleteGenerationBoundMetadata],
      licenseAcceptances: [],
    }), 'utf8');
    const restarted = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });

    await expect(restarted.read()).resolves.toMatchObject({
      installed: [],
      unboundInstalled: [{ identity: metadata.identity, directoryKey: metadata.directoryKey }],
    });
  });

  it('rejects a persisted binding shape with an obsolete digest alias instead of silently accepting it', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await expect(store.recordInstalled({
      ...metadata,
      pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
    } as unknown as InstalledVoiceModelPackMetadataV1)).rejects.toThrow('voice_model_pack_state_invalid');
  });
});
