import { describe, expect, it, vi } from 'vitest';

import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { applySessionRuntimeControls } from './sessionRuntimeControls';

describe('applySessionRuntimeControls', () => {
  it('installs the Team Run opener and removes it when its Session runtime retires', async () => {
    const target: Partial<SessionRuntimeControls> = {};
    const refusal = Object.assign(new Error('provider_binding_changed'), { code: 'provider_binding_changed' });
    applySessionRuntimeControls(target, { prepareRunTeamCredentialProviderBinding: async () => { throw refusal; } });
    expect(target.prepareRunTeamCredentialProviderBinding).toBeTypeOf('function');
    await expect(target.prepareRunTeamCredentialProviderBinding!({
      runId: 'child', agentId: 'codex', resourceId: 'resource', modelId: 'model',
    })).rejects.toBe(refusal);
    applySessionRuntimeControls(target, null);
    expect(target.prepareRunTeamCredentialProviderBinding).toBeUndefined();
  });
  it('retains applied child selection through control installation and withdraws it on retirement', async () => {
    const target: Partial<SessionRuntimeControls> = {};
    const applied = { status: 'applied' as const,
      backendTarget: { kind: 'backend' as const, backendId: 'acme/parent' },
      modelId: 'parent-applied-model', connectedServices: null };
    applySessionRuntimeControls(target, { readAppliedChildSelection: async () => applied });
    expect(await target.readAppliedChildSelection?.()).toEqual(applied);
    applySessionRuntimeControls(target, null);
    expect(target.readAppliedChildSelection).toBeUndefined();
  });
  it('copies and clears generic connected-service auth controls', () => {
    const target: Partial<SessionRuntimeControls> = {
      applyConnectedServiceAuthGeneration: vi.fn(),
      readConnectedServiceRuntimeIdentity: vi.fn(),
      consumeUsageLimitResetCredit: vi.fn(),
    };
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({ ok: true }));
    const readConnectedServiceRuntimeIdentity = vi.fn(async () => ({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
      },
    }));
    const consumeUsageLimitResetCredit = vi.fn(async () => ({ ok: true, status: 'ready' }));

    applySessionRuntimeControls(target, {
      applyConnectedServiceAuthGeneration,
      readConnectedServiceRuntimeIdentity,
      consumeUsageLimitResetCredit,
    });

    expect(target.applyConnectedServiceAuthGeneration).toBe(applyConnectedServiceAuthGeneration);
    expect(target.readConnectedServiceRuntimeIdentity).toBe(readConnectedServiceRuntimeIdentity);
    expect(target.consumeUsageLimitResetCredit).toBe(consumeUsageLimitResetCredit);

    applySessionRuntimeControls(target, null);

    expect(target.applyConnectedServiceAuthGeneration).toBeUndefined();
    expect(target.readConnectedServiceRuntimeIdentity).toBeUndefined();
    expect(target.consumeUsageLimitResetCredit).toBeUndefined();
  });

  it('copies and clears terminal composer runtime controls', () => {
    const target: Partial<SessionRuntimeControls> = {
      clearTerminalComposer: vi.fn(),
    } as any;
    const clearTerminalComposer = vi.fn(async () => ({ ok: true, status: 'cleared' }));

    applySessionRuntimeControls(target, {
      clearTerminalComposer,
    } as any);

    expect((target as any).clearTerminalComposer).toBe(clearTerminalComposer);

    applySessionRuntimeControls(target, null);

    expect((target as any).clearTerminalComposer).toBeUndefined();
  });
});
