import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machine npm registry profile ops', () => {
    beforeEach(() => machineRpcWithServerScopeMock.mockReset());

    it('gets a strict secret-free snapshot through server-scoped machine RPC', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            status: 'success', snapshot: { protocolVersion: 1, revision: 0, profiles: [], pausedSources: [] },
        });
        const { machineNpmRegistryProfilesGet } = await import('./machineNpmRegistryProfiles');
        await expect(machineNpmRegistryProfilesGet('machine-a', { serverId: 'server-a' }))
            .resolves.toMatchObject({ status: 'success', snapshot: { revision: 0 } });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET,
            payload: { machineId: 'machine-a' },
        }));
    });

    it('validates and forwards mutations without retaining credentials', async () => {
        machineRpcWithServerScopeMock.mockImplementationOnce(async (input) => {
            input.onIssued?.();
            return {
                status: 'success', snapshot: { protocolVersion: 1, revision: 1, profiles: [], pausedSources: [] },
            };
        });
        const { machineNpmRegistryProfilesMutate } = await import('./machineNpmRegistryProfiles');
        const request = {
            action: 'login' as const, machineId: 'machine-a', profileId: 'registry_acme', expectedRevision: 0,
            mutationId: 'mutation-login-acme', credential: { kind: 'bearer_token' as const, secret: 'boundary-secret' },
        };
        const result = await machineNpmRegistryProfilesMutate('machine-a', request, { serverId: 'server-a' });
        expect(result.status).toBe('success');
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE,
            payload: request,
            onIssued: expect.any(Function),
        }));
        expect(JSON.stringify(result)).not.toContain('boundary-secret');
    });

    it('does not invite a credential replay when the response is lost after issue', async () => {
        machineRpcWithServerScopeMock.mockImplementationOnce(async (input) => {
            input.onIssued?.();
            throw new Error('response lost');
        });
        const { machineNpmRegistryProfilesMutate } = await import('./machineNpmRegistryProfiles');
        const request = {
            action: 'login' as const, machineId: 'machine-a', profileId: 'registry_acme', expectedRevision: 0,
            mutationId: 'mutation-login-once', credential: { kind: 'bearer_token' as const, secret: 'one-shot-secret' },
        };

        const result = await machineNpmRegistryProfilesMutate('machine-a', request, { serverId: 'server-a' });

        expect(result).toEqual({ status: 'outcomeUnknown' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).not.toContain('one-shot-secret');

        machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('not issued'));
        await expect(machineNpmRegistryProfilesMutate('machine-a', {
            ...request,
            mutationId: 'mutation-login-not-issued',
        }, { serverId: 'server-a' })).rejects.toThrow('not issued');
    });

    it('fences the exact admitted target again at transport issue without reporting an unknown effect', async () => {
        let current = true;
        let emitted = false;
        machineRpcWithServerScopeMock.mockImplementationOnce(async (input) => {
            current = false;
            input.onIssued?.();
            emitted = true;
            return { status: 'success', snapshot: { protocolVersion: 1, revision: 1, profiles: [], pausedSources: [] } };
        });
        const { machineNpmRegistryProfilesMutate } = await import('./machineNpmRegistryProfiles');
        const options = { serverId: 'server-a', assertCurrent: () => {
            if (!current) throw new Error('npm_registry_target_not_current');
        } };
        await expect(machineNpmRegistryProfilesMutate('machine-a', {
            action: 'remove', machineId: 'machine-a', profileId: 'registry_acme', expectedRevision: 0, mutationId: 'remove-current',
        }, options)).rejects.toThrow('npm_registry_target_not_current');
        expect(emitted).toBe(false);
    });
});
