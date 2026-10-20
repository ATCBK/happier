import { beforeEach, describe, expect, it, vi } from 'vitest';

const listSessionMarkersMock = vi.fn();

vi.mock('@/daemon/sessionRegistry', () => ({
  listSessionMarkers: (...args: unknown[]) => listSessionMarkersMock(...args),
}));

import { resolveConnectedServiceRuntimeSnapshotForExternalSession } from './externalSessionRuntimeSnapshotRecovery';

describe('resolveConnectedServiceRuntimeSnapshotForExternalSession', () => {
  beforeEach(() => {
    listSessionMarkersMock.mockReset();
  });

  it('matches A13-retained directSessionV1 markers through the canonical link reader', async () => {
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'work',
        },
      },
    };
    listSessionMarkersMock.mockResolvedValueOnce([{
      pid: 123,
      happySessionId: 'session_1',
      happyHomeDir: '/tmp/happier',
      createdAt: 1,
      updatedAt: 2,
      flavor: 'codex',
      metadata: {
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine_1',
          remoteSessionId: 'thread_1',
          source: { kind: 'codexHome', home: 'user' },
        },
        connectedServices,
        connectedServicesUpdatedAt: 10,
      },
    }]);

    await expect(resolveConnectedServiceRuntimeSnapshotForExternalSession({
      agentId: 'codex',
      remoteSessionId: 'thread_1',
    })).resolves.toEqual({
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': connectedServices.bindingsByServiceId['openai-codex'],
        },
      },
      connectedServicesUpdatedAt: 10,
    });
  });

  it('matches provider-owned remote session ids by exact bytes across every marker identity source', async () => {
    const paddedRemoteSessionId = ' thread/padded+1=\n';
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'work',
        },
      },
    };
    const markers = [
      {
        pid: 1,
        happySessionId: 'session_respawn_resume',
        happyHomeDir: '/tmp/happier',
        createdAt: 1,
        updatedAt: 2,
        flavor: 'codex',
        metadata: { flavor: 'codex', connectedServices, connectedServicesUpdatedAt: 10 },
        respawn: { resume: paddedRemoteSessionId, directory: '/repo' },
      },
      {
        pid: 2,
        happySessionId: 'session_linked_external',
        happyHomeDir: '/tmp/happier',
        createdAt: 1,
        updatedAt: 2,
        flavor: 'codex',
        metadata: {
          directSessionV1: {
            v: 1,
            providerId: 'codex',
            machineId: 'machine_1',
            remoteSessionId: paddedRemoteSessionId,
            source: { kind: 'codexHome', home: 'user' },
          },
          connectedServices,
          connectedServicesUpdatedAt: 10,
        },
      },
      {
        pid: 3,
        happySessionId: 'session_provider_metadata',
        happyHomeDir: '/tmp/happier',
        createdAt: 1,
        updatedAt: 2,
        flavor: 'codex',
        metadata: {
          flavor: 'codex',
          codexSessionId: paddedRemoteSessionId,
          connectedServices,
          connectedServicesUpdatedAt: 10,
        },
      },
    ];

    for (const marker of markers) {
      listSessionMarkersMock.mockResolvedValueOnce([marker]);
      // The binding-key projection is owned elsewhere; ownership matching is what this asserts.
      await expect(resolveConnectedServiceRuntimeSnapshotForExternalSession({
        agentId: 'codex',
        remoteSessionId: paddedRemoteSessionId,
      }), marker.happySessionId).resolves.toEqual(expect.objectContaining({
        connectedServicesUpdatedAt: 10,
      }));
    }
  });

  it('never lends credentials to the stripped sibling of a padded remote session id', async () => {
    listSessionMarkersMock.mockResolvedValue([{
      pid: 458,
      happySessionId: 'session_padded_owner',
      happyHomeDir: '/tmp/happier',
      createdAt: 1,
      updatedAt: 5,
      flavor: 'codex',
      metadata: {
        flavor: 'codex',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected' as const,
              selection: 'profile' as const,
              profileId: 'padded-owner',
            },
          },
        },
        connectedServicesUpdatedAt: 20,
      },
      respawn: { resume: 'thread_1 ', directory: '/repo' },
    }]);

    await expect(resolveConnectedServiceRuntimeSnapshotForExternalSession({
      agentId: 'codex',
      remoteSessionId: 'thread_1',
    })).resolves.toEqual({});
    await expect(resolveConnectedServiceRuntimeSnapshotForExternalSession({
      agentId: 'codex',
      remoteSessionId: 'thread_1\n',
    })).resolves.toEqual({});
  });

  it('never borrows a same-directory marker that carries no native-session identity', async () => {
    listSessionMarkersMock.mockResolvedValueOnce([{
      pid: 456,
      happySessionId: 'session_neighbour',
      happyHomeDir: '/tmp/happier',
      createdAt: 1,
      updatedAt: 5,
      flavor: 'codex',
      cwd: '/repo',
      metadata: {
        flavor: 'codex',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected' as const,
              selection: 'profile' as const,
              profileId: 'neighbour',
            },
          },
        },
        connectedServicesUpdatedAt: 20,
      },
    }]);

    await expect(resolveConnectedServiceRuntimeSnapshotForExternalSession({
      agentId: 'codex',
      remoteSessionId: 'thread_mine',
    })).resolves.toEqual({});
  });

  it('never borrows a same-directory marker whose native session is a different remote session', async () => {
    listSessionMarkersMock.mockResolvedValueOnce([{
      pid: 457,
      happySessionId: 'session_neighbour_identified',
      happyHomeDir: '/tmp/happier',
      createdAt: 1,
      updatedAt: 5,
      flavor: 'codex',
      cwd: '/repo',
      metadata: {
        flavor: 'codex',
        codexSessionId: 'thread_neighbour',
        connectedServices: {
          v: 1 as const,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected' as const,
              selection: 'profile' as const,
              profileId: 'neighbour',
            },
          },
        },
        connectedServicesUpdatedAt: 20,
      },
      respawn: {
        resume: 'thread_neighbour',
        directory: '/repo',
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          serviceId: 'openai-codex',
          profileId: 'neighbour',
        },
      },
    }]);

    await expect(resolveConnectedServiceRuntimeSnapshotForExternalSession({
      agentId: 'codex',
      remoteSessionId: 'thread_mine',
    })).resolves.toEqual({});
  });
});
