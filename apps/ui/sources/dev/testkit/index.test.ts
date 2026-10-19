import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('UI testkit barrel', () => {
    it('loads hook and transcript native boundaries without the full Protocol, UI Settings or plugin catalogs', async () => {
        const { renderHook } = await import('./index');
        const hook = await renderHook(() => 'ready');
        expect(hook.getCurrent()).toBe('ready');
        await hook.unmount();
        // Native mock factories resolve this specialized harness before storage
        // setup. Its import must not eagerly enter Settings/native setup again.
        await import('./harness/chatListHarness');
        // This is Vitest 3.2's loaded-module boundary, also used by the canonical
        // transport-order guard. It observes evaluation, not source spelling.
        const cache = (globalThis as {
            __vitest_worker__?: { moduleCache?: ReadonlyMap<string, { exports?: unknown }> };
        }).__vitest_worker__?.moduleCache;
        expect(cache).toBeDefined();
        const loaded = [...cache!].filter(([id, entry]) => !id.startsWith('mock:') && entry.exports)
            .map(([id]) => id.replaceAll('\\', '/'));
        expect(loaded.filter(id => id.endsWith('/packages/protocol/src/index.ts')
            || id.endsWith('/sync/domains/settings/settings.ts')
            || id.endsWith('/agents/registry/registryCore.ts')
            || id.endsWith('/voice/registry/generatedBundledVoiceEntries.ts'))).toEqual([]);
    });

    it('does not re-export the plugin surface fixture that loads the text module', async () => {
        const barrelSource = await readFile(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

        expect(barrelSource).not.toContain("./fixtures/pluginSurfaceContextFixture");
    });

    it('does not re-export the agent catalog fixture that loads the sync runtime', async () => {
        // `fixtures/agentCatalogFixtures` reaches
        // `@/sync/runtime/orchestration/connectionManager` through
        // `agentCatalogProjection` -> `registryUiBehavior` ->
        // `agentUiBehaviorProjection` -> `activeServerAccountScope`. Re-exported
        // here it bound the real transports and froze the applied active Home on
        // the first import of any barrel consumer, so unrelated Teams, ops and
        // Home Administration suites rendered against the real network. It was
        // the sole barrel edge to that graph; consumers import it by its own path.
        const barrelSource = await readFile(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

        expect(barrelSource).not.toContain("./fixtures/agentCatalogFixtures");
    });

    it('loads shared text and material readers without the aggregate store hooks or command runtime', async () => {
        await import('@/components/ui/text/Text');
        await import('@/components/ui/glass/useGlassMaterialSettings');
        await import('@/components/ui/lists/SegmentedChoiceItem');
        await import('@/components/ui/layout/PageHeader');
        const cache = (globalThis as {
            __vitest_worker__?: { moduleCache?: ReadonlyMap<string, { exports?: unknown }> };
        }).__vitest_worker__?.moduleCache;
        expect(cache).toBeDefined();
        const loaded = [...cache!].filter(([id, entry]) => !id.startsWith('mock:') && entry.exports)
            .map(([id]) => id.replaceAll('\\', '/'));
        expect(loaded.filter(id => id.endsWith('/sync/store/hooks.ts')
            || id.endsWith('/sync/store/settingsWriters.ts')
            || id.endsWith('/sync/syncEngine.ts'))).toEqual([]);
    });
});
