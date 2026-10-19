import { describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
installHomeGovernanceBoundaries(createHomeGovernanceHarness());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createActivePluginAccountPackageAssetsRemover } = await import('./removeActivePluginAccountPackageAssets');

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const target = { release: { pluginId: 'example.tasks', version: '2.0.0' } };

function response(release = target.release) {
    return new Response(JSON.stringify({
        removed: true,
        link: {
            release,
            artifactId: '00000000-0000-4000-8000-000000000001',
            descriptor: { archiveDigestSha256: `sha256:${'a'.repeat(64)}`, resources: [] },
        },
    }), { status: 200 });
}

describe('active Account package Asset removal', () => {
    it.each([false, true])('accepts only exact qualified release removal (different: %s)', async (different) => {
        const request = vi.fn(async () => response(different ? { ...target.release, version: '3.0.0' } : target.release));
        const accountLifetime: ActiveServerAccountScopeLifetime = {
            scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }),
        };
        const remover = createActivePluginAccountPackageAssetsRemover({
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
            captureRequestAuthority: async () => ({ request }),
        });
        await expect(remover.remove({ accountLifetime, target })).resolves.toEqual({ kind: different ? 'unavailable' : 'removed' });
        expect(request).toHaveBeenCalledWith('/v1/plugins/availability/package-assets/remove',
            expect.objectContaining({ method: 'POST', body: JSON.stringify(target) }));
    });

    it('aborts pending removal and rejects a late success after Account retirement', async () => {
        let current = true;
        let retire = () => {};
        let finish: (value: Response) => void = () => {};
        const observed: { signal: AbortSignal | null } = { signal: null };
        const request = vi.fn((_path: string, init?: RequestInit) => {
            observed.signal = init?.signal ?? null;
            return new Promise<Response>((resolve) => { finish = resolve; });
        });
        const release = vi.fn(async () => {});
        const accountLifetime: ActiveServerAccountScopeLifetime = {
            scope, isCurrent: () => current,
            onRetire: (listener) => { retire = listener; return { dispose: () => {} }; },
        };
        const remover = createActivePluginAccountPackageAssetsRemover({
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
            captureRequestAuthority: async () => ({ request, release }),
        });
        const pending = remover.remove({ accountLifetime, target });
        await vi.waitFor(() => expect(request).toHaveBeenCalled());
        current = false;
        retire();
        expect(observed.signal?.aborted).toBe(true);
        finish(response());
        await expect(pending).resolves.toEqual({ kind: 'unavailable' });
        expect(release).toHaveBeenCalledOnce();
    });
});
