import { SkillListItemV1Schema, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { createMachineFixture } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from './artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from './promptLibraryCatalogBoundary';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';

export function createSkillsSurfaceItem(skillId: string, overrides: Partial<SkillListItemV1> = {}): SkillListItemV1 {
    return SkillListItemV1Schema.parse({ skillId, name: skillId, description: `${skillId} instructions`, revision: '1:1',
        rules: [{ id: `${skillId}-on`, skillId, target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }],
        trust: 'text_only', cost: { descriptionTokens: 2, bodyTokens: 20 }, provenance: { kind: 'written' }, modified: false,
        updatePolicy: 'manual', createdAt: 1, migratedFromContext: false, userInvocable: true, folderId: null, ...overrides });
}

export function createSkillsSurfaceLibrary(items: readonly SkillListItemV1[], overrides: Partial<SkillsLibrary> = {}): SkillsLibrary {
    return { scope: null, status: 'ready', items, stale: false, errorCode: null, usageObservedSince: null, retry: () => {}, ...overrides };
}

/** HTTP/native boundaries are installed by the suite before importing the real surface graph. */
export async function createSkillsSurfaceHarness(origin: string, records: readonly PromptLibraryRecordV1[] = []) {
    const catalog = createPromptLibraryCatalogBoundary({ records });
    const home = await createPlainArtifactHomeFixture(origin, {
        serverFeatures: createRootLayoutFeaturesResponse(),
        handleRequest: async (path, init) => path === '/v2/account/settings/history'
            ? Response.json({ snapshots: [] }) : catalog.handle(path, init),
        handleExternalRequest: async () => Response.json({ version: 1, items: [] }),
    });
    const { storage } = await import('@/sync/domains/state/storage');
    const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
    const qualified = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: `srv_${new URL(origin).hostname.replaceAll('.', '_')}`, canonicalServerUrl: origin, revision: 1,
        endpoints: [{ kind: 'https', url: origin }] } });
    if (!qualified.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: qualified.serverIdentityId, accountId: 'artifact-account' };
    const machine = (id: string, offline: boolean) => createMachineFixture({ id, active: !offline, activeAt: offline ? 1 : Date.now(),
        metadata: { ...createMachineFixture().metadata!, displayName: id, host: id, platform: 'linux',
            agentInventory: { checkedAt: 2, installedAgentIds: ['codex'] } } });
    const machines = [machine('nl2', false), machine('away', true)];
    storage.setState({ settingsScope: scope, profileScope: scope, isDataReady: true, artifactsLoaded: true,
        machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [scope.serverId]: machines }, machineListStatusByServerId: { [scope.serverId]: 'idle' } });
    storage.getState().applyLocalSettings({ skillsFirstRunDecidedAt: null });
    return { ...home, scope, catalog, storage };
}
