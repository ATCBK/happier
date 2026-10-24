import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sealQualifiedConnectedAccountContentEnvelope,
  type QualifiedConnectedAccountProfileV4,
  type ConnectedServiceCredentialHealthV1,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createAdmittedPluginRuntimeFixture, retireAdmittedPluginRuntimeRegistry } from '@/plugins/testkit/admittedRuntime';

import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';

const openAiService = Object.freeze({
  pluginId: 'happier.voice.openai',
  localId: 'openai',
});
const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
const now = 1_000_000;
const createdDirectories: string[] = [];
const createdRegistries: Array<Readonly<{
  dispose(): Promise<void>;
}>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(createdRegistries.splice(0).map(async (registry) => {
    await registry.dispose();
  }));
  await Promise.all(createdDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

async function createHarness(input: Readonly<{
  clock?: () => number;
  onCredentialRead?: () => void;
  profile?: () => Partial<Pick<QualifiedConnectedAccountProfileV4, 'kind' | 'expiresAt'>> & Readonly<{ credentialRevision?: string }>;
  noScheduledAccounts?: boolean;
  retireRegistry?: boolean;
  pluginEnabled?: boolean;
  credentialAvailable?: boolean;
  v4Support?: 'advertised' | 'absent' | 'indeterminate';
  omitQualifiedRuntime?: boolean;
  health?: ConnectedServiceCredentialHealthV1;
}>) {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-qualified-status-'));
  createdDirectories.push(happyHomeDir);
  const admitted = await createAdmittedPluginRuntimeFixture({
    happyHomeDir,
    runtimeOptions: {
      pluginIds: input.pluginEnabled === false ? [] : [openAiService.pluginId],
      ...(input.pluginEnabled === false ? { contributes: createResolvedContributionRegistry({}) } : {}),
    },
  });
  createdRegistries.push(admitted);
  const reloadController = admitted.controller;
  const credentials: Credentials = {
    token: 'happier-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(7),
    },
  };
  const credentialContent = sealQualifiedConnectedAccountContentEnvelope({
    kind: 'credential',
    accountMode: 'plain',
    payload: {
      v: 1,
      values: { token: 'sk-qualified-current' },
    },
    randomBytes: (length) => new Uint8Array(length),
  });
  const readQualifiedCredential = vi.fn(async () => {
    input.onCredentialRead?.();
    return input.credentialAvailable === false
      ? null
      : {
          ref: {
            service: openAiService,
            accountId: 'work',
          },
          authenticationModeId: 'api-key',
          revisionSemantics: 'revisioned' as const,
          credentialRevision,
          configurationRevision: null,
          content: credentialContent,
          metadata: { scopes: [], ...(input.health ? { health: input.health } : {}) },
        };
  });
  const establishedRuntimeOwner =
    createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController,
      credentials,
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      readCredential: readQualifiedCredential,
      readConfiguration: vi.fn(async () => null),
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          admit: vi.fn(async () => undefined),
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });
  const api = {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getConnectedServiceCredentialPlain: vi.fn(),
    getConnectedServiceCredentialSealed: vi.fn(async () => null),
    acquireConnectedServiceRefreshLease: vi.fn(),
  } as unknown as ApiClient;
  const mutateCredentialHealth = vi.fn(async (params: Readonly<{
    token: string;
    patch: unknown;
  }>) => {
    expect(params.token).toBe(credentials.token);
    return {
      success: true as const,
      credentialRevision,
      configurationRevision: null,
    };
  });
  const coordinator = new ConnectedServiceRefreshCoordinator({
    api,
    credentials,
    machineIdProvider: () => 'machine-1',
    activeServerDir: join(happyHomeDir, 'active'),
    baseDir: join(happyHomeDir, 'materialized'),
    refreshWindowMs: 60_000,
    refreshLeaseMs: 30_000,
    now: input.clock ?? (() => now),
    ...(input.omitQualifiedRuntime
      ? {}
      : {
          qualifiedConnectedAccountRuntime: {
            resolvePeerClass: () => (
                input.v4Support === 'absent'
                    ? 'revisioned_v2_v3'
                    : input.v4Support === 'indeterminate'
                        ? 'indeterminate'
                        : 'advertised_v4'
            ),
            establishedRuntimeOwner,
            mutateCredentialHealth,
            readCredential: readQualifiedCredential,
            listScheduledAccounts: async (): Promise<readonly QualifiedConnectedAccountProfileV4[]> => input.noScheduledAccounts ? [] : [{
              ref: { service: openAiService, accountId: 'work' },
              status: 'connected',
              authenticationModeId: 'api-key',
              revisionSemantics: 'revisioned',
              credentialRevision,
              configurationReady: false,
              configurationRevision: null,
              kind: 'token',
              expiresAt: null,
              displayName: 'work',
              scopes: [],
              ...input.profile?.(),
            }],
            acquireRefreshLease: vi.fn(async () => ({
              acquired: false,
              leaseUntil: 0,
              ownerId: 'unused',
              credentialRevision,
            })),
            mutateCredential: vi.fn(async () => ({
              success: true as const,
              credentialRevision,
              configurationRevision: null,
            })),
          },
        }),
  });

  if (input.retireRegistry) {
    await retireAdmittedPluginRuntimeRegistry({ controller: reloadController, registry: admitted.registry, happyHomeDir });
  }
  return {
    api,
    coordinator,
    mutateCredentialHealth,
    readQualifiedCredential,
  };
}

describe('ConnectedServiceRefreshCoordinator qualified status integration', () => {
  it.each([false, true])('records only payload-free health transition facts at the actual status write (timestamp-only=%s)', async timestampOnly => {
    const diagnostic = vi.spyOn(logger, 'debug');
    const harness = await createHarness(timestampOnly ? { health: {
      v: 1, status: 'connected', reconnectRequired: false, lastRefreshAttemptAt: 1,
      lastRefreshSuccessAt: 1, lastRuntimeAuthFailureAt: 1,
    } } : {});
    await harness.coordinator.tickOnce();
    expect(harness.mutateCredentialHealth).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls.filter(([event]) => event === '[ConnectedServiceRefreshCoordinator] credential health write'))
      .toEqual([['[ConnectedServiceRefreshCoordinator] credential health write', {
        path: 'status', serviceKind: 'openai', beforeStatus: timestampOnly ? 'connected' : null, afterStatus: 'connected',
        substantiveChanged: !timestampOnly,
      }]]);
  });
  it('parks healthy non-expiring credentials across unrelated wakes and rechecks a replaced revision', async () => {
    let clock = now;
    let revision = credentialRevision;
    const harness = await createHarness({ clock: () => clock,
      profile: () => ({ credentialRevision: revision }),
      // Advance the real clock boundary while the credential HTTP response is in flight.
      onCredentialRead: () => { clock = Math.max(clock, now + 40_000); } });
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    const reads = harness.readQualifiedCredential.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    for (let wake = 0; wake < 3; wake++) {
      harness.coordinator.registerSpawnTarget({ pid: 120 + wake, agentId: 'codex',
        materializationKey: `inventory-wake-${wake}`, connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} } });
      expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    }
    clock += 300_000;
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    expect(harness.readQualifiedCredential).toHaveBeenCalledTimes(reads);
    revision = 'csr_bcdefghijklmnopqrstuvw';
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    expect(harness.readQualifiedCredential.mock.calls.length).toBeGreaterThan(reads);
    expect(harness.mutateCredentialHealth).toHaveBeenCalledTimes(2);
  });

  it('schedules the real OAuth refresh window rather than a health polling interval', async () => {
    const empty = await createHarness({ noScheduledAccounts: true });
    expect(await empty.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    let clock = now;
    const harness = await createHarness({ clock: () => clock,
      profile: () => ({ kind: 'oauth', expiresAt: now + 360_000 }) });
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 300_000 });
    clock += 299_999;
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 1 });
    expect(harness.mutateCredentialHealth).toHaveBeenCalledOnce();
  });

  it('returns the existing credential-health recovery deadline when a null-expiry account is unavailable', async () => {
    const harness = await createHarness({ credentialAvailable: false });
    await expect(harness.coordinator.tickOnce()).rejects.toBeInstanceOf(AggregateError);
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 60_000 });
  });

  it('retains the existing recovery interval after a slow failed credential observation', async () => {
    let clock = now;
    const harness = await createHarness({ clock: () => clock, credentialAvailable: false,
      onCredentialRead: () => { clock = Math.max(clock, now + 90_000); } });
    await expect(harness.coordinator.tickOnce()).rejects.toBeInstanceOf(AggregateError);
    const reads = harness.readQualifiedCredential.mock.calls.length;
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 60_000 });
    expect(harness.readQualifiedCredential).toHaveBeenCalledTimes(reads);
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
  });
  it('rearms a replaced credential without inheriting the old revision recovery deadline', async () => {
    let revision = credentialRevision;
    const harness = await createHarness({ credentialAvailable: false,
      profile: () => ({ credentialRevision: revision }) });
    await expect(harness.coordinator.tickOnce()).rejects.toBeInstanceOf(AggregateError);
    const reads = harness.readQualifiedCredential.mock.calls.length;
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 60_000 });
    expect(harness.readQualifiedCredential).toHaveBeenCalledTimes(reads);
    revision = 'csr_bcdefghijklmnopqrstuvw';
    await expect(harness.coordinator.tickOnce()).rejects.toBeInstanceOf(AggregateError);
    expect(harness.readQualifiedCredential.mock.calls.length).toBeGreaterThan(reads);
  });
  it('runs a real current plugin status leaf from the existing scheduled trigger and settles exact-revision health', async () => {
    const harness = await createHarness({});
    harness.coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      materializationKey: 'session-1',
      // The Voice Account is scheduled from the Home's account listing, not
      // projected as a Codex native subscription binding.
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} },
    });

    await harness.coordinator.tickOnce();

    expect(harness.mutateCredentialHealth).toHaveBeenCalledOnce();
    expect(harness.mutateCredentialHealth).toHaveBeenCalledWith({
      token: 'happier-token',
      patch: {
        ref: {
          service: openAiService,
          accountId: 'work',
        },
        expectedCredentialRevision: credentialRevision,
        expectedConfigurationRevision: null,
        health: {
          v: 1,
          status: 'connected',
          reconnectRequired: false,
        },
      },
    });
    expect(harness.readQualifiedCredential).toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it('does not publish health or report a refreshed credential after the owning plugin registry is retired', async () => {
    const harness = await createHarness({ retireRegistry: true });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(harness.readQualifiedCredential).toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it('does not publish health when the exact qualified account snapshot is missing', async () => {
    const harness = await createHarness({ credentialAvailable: false });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(harness.readQualifiedCredential).toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it('keeps the account dormant and publishes no health when the owning plugin is disabled', async () => {
    const harness = await createHarness({ pluginEnabled: false });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(harness.readQualifiedCredential).toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it.each(['absent', 'indeterminate'] as const)('refuses refresh without credential or provider effects when V4 capability is %s', async (v4Support) => {
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);
    const harness = await createHarness({ v4Support });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).rejects.toMatchObject({ code: 'connected_account_capability_indeterminate' });

    expect(harness.readQualifiedCredential).not.toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(harness.api.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('uses the qualified HTTP reader when no runtime is injected and never reads the scalar route', async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);
    // HTTP is the Home boundary; default credential resolution and mode parsing stay real.
    const credentialRead = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/v4/connect/qualified/credential');
      expect(parsed.searchParams.has('ref')).toBe(true);
      return { status: 404, data: { error: 'not_found' } };
    });
    const harness = await createHarness({ omitQualifiedRuntime: true });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(harness.readQualifiedCredential).not.toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(credentialRead).toHaveBeenCalledOnce();
    expect(harness.api.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

});
