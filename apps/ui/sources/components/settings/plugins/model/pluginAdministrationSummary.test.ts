import { describe, expect, it } from 'vitest';

import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { createInstalledPluginCapabilityFixture } from '@/dev/testkit/fixtures/pluginCapabilityFixtures';
import type { MachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';

import { summarizePluginAdministration } from './pluginAdministrationSummary';

function loaded(data: Record<string, unknown>): MachineCapabilitiesCacheState {
    return {
        status: 'loaded' as const,
        snapshot: {
            response: {
                protocolVersion: 1 as const,
                results: { 'tool.plugins': { ok: true as const, checkedAt: 1, data } },
            },
        },
    };
}

const bundled = createInstalledPluginCapabilityFixture({ pluginId: 'happier.triage', source: { kind: 'bundled', locator: 'happier.triage' } });
const userInstalled = createInstalledPluginCapabilityFixture({ pluginId: 'acme.linear' });
const applying = { kind: 'applying', pendingChangeId: 'p-1' };
const awaiting = {
    kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null,
    authorityExpansion: [], pendingChangeId: 'p-2', review: createPluginInstallationReviewFixture(),
};

describe('summarizePluginAdministration', () => {
    it('counts user-installed plugins without treating retired daemon reviews as Inbox decisions', () => {
        expect(summarizePluginAdministration(loaded({
            installedPlugins: [bundled, userInstalled],
            pendingChanges: [applying, awaiting],
        }))).toEqual({ known: true, awaitingDecision: 0, userInstalled: 1 });
    });

    it('says nothing is known without a daemon answer, rather than "none"', () => {
        expect(summarizePluginAdministration(null)).toEqual({ known: false, awaitingDecision: 0, userInstalled: 0 });
        expect(summarizePluginAdministration({ status: 'idle' })).toEqual({ known: false, awaitingDecision: 0, userInstalled: 0 });
    });

    it('treats a machine with only bundled plugins as having none installed', () => {
        expect(summarizePluginAdministration(loaded({ installedPlugins: [bundled], pendingChanges: [] })))
            .toEqual({ known: true, awaitingDecision: 0, userInstalled: 0 });
    });
});
