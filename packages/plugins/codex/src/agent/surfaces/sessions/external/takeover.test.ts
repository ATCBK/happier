import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codexExternalSessionTakeoverContribution,
  resolveCodexExternalSessionTakeoverPlan,
} from './takeover.js';

// Codex mints these ids; taking over `  x  ` must not resume `x`.
const EXACT_PROVIDER_SESSION_ID = '  provider\nses/AB+cd==  ';

describe('Codex External Sessions takeover launch derivation', () => {
  it('carries host-selected shared SQLite affinity into the public takeover launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-takeover-affinity-'));
    try {
      const home = join(root, 'pool');
      const sqliteHome = join(root, 'native-state');
      await mkdir(home);
      await writeFile(join(home, '.happier-state-sharing.json'), JSON.stringify({
        v: 1, effectiveStateMode: 'shared', stateRootEnvironment: { CODEX_SQLITE_HOME: sqliteHome },
      }));
      const source = { kind: 'codexHome', home: 'connectedService', homePath: home,
        connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work' } as const;
      expect(await codexExternalSessionTakeoverContribution.resolveLaunch({
        source, remoteSessionId: 'native-thread', linkedDirectory: root, targetDirectory: root,
        linkData: { source, codexBackendMode: 'appServer' }, transcriptStorage: 'persisted',
        signal: new AbortController().signal, deadlineAtMs: Date.now() + 15_000,
        maxSerializedBytes: 262_144, linkedSessionId: 'happier-session',
      })).toMatchObject({ ok: true, value: { environmentVariables: { CODEX_HOME: home, CODEX_SQLITE_HOME: sqliteHome } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('carries the taken-over provider session id byte-exact and rejects blank', () => {
    const codexSource = {
      kind: 'codexHome',
      home: 'user',
      homePath: ' /srv/happier/codex-home ',
    } as const;
    const identity = (remoteSessionId: string) => ({
      remoteSessionId,
      source: codexSource,
      linkData: {
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/srv/happier/codex-home',
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: remoteSessionId,
            home: 'user',
            homePath: '/srv/happier/codex-home',
          },
        },
        codexBackendMode: 'appServer',
      },
      linkedDirectory: '/repo/project',
      transcriptStorage: 'persisted' as const,
    });

    const plan = resolveCodexExternalSessionTakeoverPlan(
      identity(EXACT_PROVIDER_SESSION_ID),
    );

    // Happier-owned home path stays trimmed; the provider id keeps its bytes.
    expect(plan).toMatchObject({
      runtimeDescriptorV1: {
        agent: {
          providerSessionId: EXACT_PROVIDER_SESSION_ID,
          homePath: '/srv/happier/codex-home',
        },
      },
      environmentVariables: { CODEX_HOME: '/srv/happier/codex-home' },
    });

    // A descriptor recorded against the trimmed id is a different session and
    // must not satisfy a takeover of the exact id.
    expect(resolveCodexExternalSessionTakeoverPlan({
      ...identity(EXACT_PROVIDER_SESSION_ID),
      linkData: identity(EXACT_PROVIDER_SESSION_ID.trim()).linkData,
    })).toBeNull();

    expect(resolveCodexExternalSessionTakeoverPlan(identity(' \n\t '))).toBeNull();
  });

  it('returns only the fresh Codex home, native backend mode, and launch descriptor', () => {
    const plan = resolveCodexExternalSessionTakeoverPlan({
      remoteSessionId: 'native-session-current',
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
        homePath: ' /srv/happier/codex-home ',
      },
      linkData: {
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-1',
          homePath: '/srv/happier/codex-home',
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'native-session-current',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'profile-1',
            homePath: '/srv/happier/codex-home',
          },
        },
        codexBackendMode: 'appServer',
      },
      linkedDirectory: ' /repo/project ',
      transcriptStorage: 'persisted',
    });

    expect(plan).toMatchObject({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'native-session-current',
          home: 'connectedService',
          homePath: '/srv/happier/codex-home',
        },
      },
      environmentVariables: {
        CODEX_HOME: '/srv/happier/codex-home',
      },
    });
    // The launch plan carries no cwd authority: the host enforces the request
    // targetDirectory as the spawned process cwd.
    expect(plan).not.toHaveProperty('directory');
    expect(plan).not.toHaveProperty('existingSessionId');
    expect(plan).not.toHaveProperty('resume');
    expect(plan).not.toHaveProperty('backendTarget');
    expect(plan).not.toHaveProperty('backendModeHint');
    expect(plan).not.toHaveProperty('transcriptStorage');
  });

  it('fails closed on an incomplete home, inconsistent fresh source, or unsupported mode', () => {
    expect(resolveCodexExternalSessionTakeoverPlan({
      remoteSessionId: 'native-session-current',
      source: { kind: 'codexHome', home: 'user' },
      linkData: {
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'appServer',
      },
      linkedDirectory: '/repo/project',
    })).toBeNull();

    expect(resolveCodexExternalSessionTakeoverPlan({
      remoteSessionId: 'native-session-current',
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/home/user/.codex-current',
      },
      linkData: {
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/home/user/.codex-stale',
        },
        codexBackendMode: 'appServer',
      },
      linkedDirectory: '/repo/project',
    })).toBeNull();

    expect(resolveCodexExternalSessionTakeoverPlan({
      remoteSessionId: 'native-session-current',
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/home/user/.codex-current',
      },
      linkData: {
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/home/user/.codex-current',
        },
        codexBackendMode: 'not-a-codex-mode',
      },
      linkedDirectory: '/repo/project',
    })).toBeNull();
  });

  it('exposes the exact one-callback contribution and maps only the bounded plan', async () => {
    await expect(Promise.resolve(
      codexExternalSessionTakeoverContribution.resolveLaunch({
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 15_000,
        maxSerializedBytes: 262_144,
        linkedSessionId: 'happier-session-1',
        remoteSessionId: 'native-session-current',
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/home/user/.codex',
        },
        linkData: {
          source: {
            kind: 'codexHome',
            home: 'user',
            homePath: '/home/user/.codex',
          },
          codexBackendMode: 'acp',
        },
        targetDirectory: '/local/selected/workspace',
        linkedDirectory: '/repo/project',
        transcriptStorage: 'persisted',
      }),
    )).resolves.toMatchObject({
      ok: true,
      value: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'acp',
          },
        },
        environmentVariables: {
          CODEX_HOME: '/home/user/.codex',
        },
        applyConnectedAccountDefaults: true,
      },
    });
    expect(Object.keys(codexExternalSessionTakeoverContribution)).toEqual([
      'resolveLaunch',
    ]);
  });

  it('distinguishes invalid fresh identity from an unavailable linked directory', async () => {
    const base = {
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 15_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'happier-session-1',
      remoteSessionId: 'native-session-current',
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/home/user/.codex-current',
      },
      targetDirectory: '/local/selected/workspace',
      transcriptStorage: 'persisted',
    } as const;

    await expect(Promise.resolve(
      codexExternalSessionTakeoverContribution.resolveLaunch({
        ...base,
        linkData: {
          source: {
            kind: 'codexHome',
            home: 'user',
            homePath: '/home/user/.codex-stale',
          },
          codexBackendMode: 'appServer',
        },
        linkedDirectory: '/repo/project',
      }),
    )).resolves.toEqual({ ok: false, code: 'source_invalid' });
    await expect(Promise.resolve(
      codexExternalSessionTakeoverContribution.resolveLaunch({
        ...base,
        linkData: {
          source: base.source,
          codexBackendMode: 'appServer',
        },
      }),
    )).resolves.toEqual({ ok: false, code: 'unavailable' });
  });

  it('adopts daemon-loaded sessions independently of transcript storage and keeps native auth', async () => {
    const base = {
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 15_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'happier-session-1',
      remoteSessionId: 'thread-381',
      source: { kind: 'codexHome', home: 'user', homePath: '/home/user/.codex' },
      linkData: {
        source: { kind: 'codexHome', home: 'user', homePath: '/home/user/.codex' },
        codexBackendMode: 'appServer',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'thread-381',
            appServerTransport: 'daemonProxy',
            home: 'user',
            homePath: '/home/user/.codex',
          },
        },
      },
      targetDirectory: '/repo/project',
      linkedDirectory: '/repo/project',
    } as const;

    await expect(Promise.resolve(
      codexExternalSessionTakeoverContribution.resolveLaunch({
        ...base,
        transcriptStorage: 'direct',
      }),
    )).resolves.toMatchObject({
      ok: true,
      value: { runtimeDescriptorV1: { agent: { appServerTransport: 'daemonProxy' } } },
    });
    await expect(Promise.resolve(
      codexExternalSessionTakeoverContribution.resolveLaunch({
        ...base,
        transcriptStorage: 'direct',
      }),
    )).resolves.not.toMatchObject({
      value: { applyConnectedAccountDefaults: true },
    });

    const persisted = await Promise.resolve(
      codexExternalSessionTakeoverContribution.resolveLaunch({
        ...base,
        transcriptStorage: 'persisted',
      }),
    );
    expect(persisted).toMatchObject({ ok: true });
    if (!persisted.ok) throw new Error('expected persisted takeover plan');
    expect(persisted.value.runtimeDescriptorV1?.agent)
      .toMatchObject({ appServerTransport: 'daemonProxy' });
    expect(persisted.value).not.toHaveProperty('applyConnectedAccountDefaults');

    await expect(Promise.resolve(
      codexExternalSessionTakeoverContribution.resolveLaunch({
        ...base,
        transcriptStorage: 'direct',
        linkData: {
          ...base.linkData,
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: {
              backendMode: 'appServer',
              providerSessionId: 'thread-381',
              home: 'user',
              homePath: '/home/user/.codex',
            },
          },
        },
      }),
    )).resolves.toEqual({ ok: false, code: 'unsupported' });
  });
});
