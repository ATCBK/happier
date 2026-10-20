import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { PluginContributesV2Schema } from '@happier-dev/protocol';
import { buildWorkBoardItemKeyV1, createWorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPluginUiClientExecutableRegistrationIndex } from '@/components/plugins/reactNative/clientExecutableContributions';
import { readBoardTaskItems } from './boardTaskItems';
import { projectBoardMembership, type BoardMembershipSources } from './boardMembership';
import { buildBoardCards } from './boardCards';

describe('Board public work-item reader', () => {
    it('discovers linked tasks and resolves explicit items through an external plugin, retaining unavailable picks', async () => {
        const pluginId = 'com.acme.tasks';
        const client = { artifactId: 'tasks', exportName: 'activate' };
        const target = { ...client, platform: 'web' as const };
        const plugin = definePlugin({ id: pluginId, version: '1.0.0', workItems: { 'work-items': { client, platforms: ['web'] } } });
        const contributes = PluginContributesV2Schema.parse(plugin.manifest.contributes);
        const executionOrigin = { serverIdentityId: 'srv_server1', materializationRef: { pluginId, machineId: 'machine', materializationId: 'materialization' } };
        const controller = new AbortController();
        const index = createPluginUiClientExecutableRegistrationIndex();
        const scope = index.createScope({ pluginId, contributes, target, executionOrigin, occurrenceId: 'current', pluginVersion: '1.0.0',
            authority: { serverId: 'home', machineId: 'machine' },
            lifecycle: { signal: controller.signal, isCurrent: () => !controller.signal.aborted } });
        const item = { title: 'Fix payments', category: 'started' as const, linkedSessions: [{ serverId: 'home', sessionId: 'worker' }] };
        scope.api.workItems.register('work-items', {
            findLinked: async () => ['known', 'outside'],
            resolve: async ({ itemIds }) => Object.fromEntries(itemIds.map(id => [id, id === 'known' || id === 'picked'
                ? item : id === 'outside' ? { ...item, linkedSessions: [] } : null])),
        });
        scope.commit();
        const source = { id: `${pluginId}/work-items`, pluginId, pluginVersion: '1.0.0', occurrenceId: 'current',
            definition: contributes.workItems[0]!, executionOrigin };
        const missing = { kind: 'task', qualifiedId: { serverId: 'home', id: 'missing' }, pluginId } as const;
        const foreign = { ...missing, pluginId: 'com.missing.plugin' };
        const picked = { ...missing, qualifiedId: { serverId: 'home', id: 'picked' } };
        const input = { serverId: 'home', refs: [missing, foreign, picked], sessions: [{ serverId: 'home', sessionId: 'worker' }],
            sources: [source], platform: 'web' as const, reader: index, signal: controller.signal };
        const result = await readBoardTaskItems(input);
        const known = { kind: 'task', qualifiedId: { serverId: 'home', id: 'known' }, pluginId } as const;
        expect(result.refs).toContainEqual(known);
        expect(result.linkedRefs).toEqual([known]);
        expect(result.refs).not.toContainEqual({ ...known, qualifiedId: { serverId: 'home', id: 'outside' } });
        expect(result.items.get(buildWorkBoardItemKeyV1(known))).toEqual(item);
        expect(result.items.get(buildWorkBoardItemKeyV1(missing))).toBeNull();
        expect(result.items.get(buildWorkBoardItemKeyV1(foreign))).toBeNull();
        const session = { kind: 'session', qualifiedId: { serverId: 'home', id: 'worker' } } as const;
        const board = { ...createWorkBoardV1({ id: 'external-board', name: 'External work' }), source: {
            picked: input.refs, filter: normalizeSessionListFilterV1({ scope: 'all_accessible', show: 'both',
                homeServerIds: ['home'], underSessionId: 'coordinator' }),
        } };
        const sources: BoardMembershipSources = { isHomeMounted: () => true, sections: {}, filtered: [session, ...result.linkedRefs],
            linkedSessionsForTask: ref => result.items.get(buildWorkBoardItemKeyV1(ref))?.linkedSessions.map(link =>
                ({ kind: 'session' as const, qualifiedId: { serverId: link.serverId, id: link.sessionId } })) ?? null };
        const membership = projectBoardMembership(board, sources);
        expect(membership.members.some(member => member.ref.kind === 'session')).toBe(false);
        const now = Date.now();
        const row = createSessionListRenderableSessionFixture({ id: 'worker', active: true, activeAt: now,
            hasPendingPermissionRequests: true, pendingRequestObservedAt: now });
        const cards = buildBoardCards(membership.members, { nowMs: now, session: () => row,
            task: ref => result.items.get(buildWorkBoardItemKeyV1(ref)) ?? null,
            workflowRun: () => null, workflow: () => null, machine: () => null, machineSessionCounts: new Map(),
            accountScopedHome: () => true, missingEntityReason: () => 'unavailable' });
        expect(cards.find(card => card.key === buildWorkBoardItemKeyV1(known)))
            .toMatchObject({ availability: 'ready', title: item.title, status: { bucket: 'needs_you' } });
        expect(cards.find(card => card.key === buildWorkBoardItemKeyV1(missing)))
            .toMatchObject({ availability: 'content_unavailable' });
        expect(cards.find(card => card.key === buildWorkBoardItemKeyV1(foreign)))
            .toMatchObject({ availability: 'content_unavailable' });
        expect(projectBoardMembership({ ...board, source: { ...board.source, picked: [...board.source.picked, session] } }, sources)
            .members.find(member => member.ref.kind === 'session')?.picked).toBe(true);
        await scope.unwind();
        const retired = await readBoardTaskItems({ ...input, refs: [known], sessions: [] });
        expect(retired.refs).toContainEqual(known);
        expect(retired.items.get(buildWorkBoardItemKeyV1(known))).toBeNull();
    });
});
