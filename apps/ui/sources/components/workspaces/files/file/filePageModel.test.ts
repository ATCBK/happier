import { describe, expect, it, vi } from 'vitest';
import { resolveFilePageAttribution, resolveFilePageHeaderModel } from './filePageModel';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const text = { kind: 'code', hasRenderableDiff: true, hasText: true, writeSupported: true };

describe('File page header behaviour model', () => {
    it('names the prompting person only in a collaborative session, through transcript byline naming', () => {
        const actor = { v: 1 as const, serverId: 'home', accountId: 'alice',
            profile: { name: 'Alice Chen', firstName: 'Alice', lastName: 'Chen', username: 'alice', avatarUrl: null } };
        const input = { agentName: 'Agent', requesterActor: actor, viewerScope: { serverId: 'home', accountId: 'bob' }, hasOtherNamedCollaborator: true };
        expect(resolveFilePageAttribution(input)).toEqual({ agentName: 'Agent', requesterName: 'Alice Chen' });
        expect(resolveFilePageAttribution({ ...input, hasOtherNamedCollaborator: false }).requesterName).toBeNull();
        expect(resolveFilePageAttribution({ ...input, viewerScope: actor }).requesterName).toBe('message.accountActorYou');
        expect(resolveFilePageAttribution({ ...input, agentName: null }).requesterName).toBeNull();
    });
    it('projects preview/source for Markdown and SVG, and deletion only as Changes', () => {
        for (const kind of ['markdown', 'svg']) {
            expect(resolveFilePageHeaderModel({ ...text, kind }).modes.map(mode => mode.id)).toEqual(['preview', 'source', 'changes']);
        }
        expect(resolveFilePageHeaderModel({ ...text, deleted: true }).modes).toEqual([{ id: 'changes', displayMode: 'diff' }]);
        expect(resolveFilePageHeaderModel({ ...text, hasRenderableDiff: false }).modes).toEqual([{ id: 'view', displayMode: 'file' }]);
    });

    it('lets a plugin own mode/find while text can still enter the built-in editor', () => {
        const plugin = resolveFilePageHeaderModel({ ...text, pluginViewerSelected: true });
        expect(plugin.modes).toEqual([]);
        expect(plugin.findAvailable).toBe(false);
        expect(plugin.editUnavailableReason).toBe(null);
    });

    it('does not offer an editor for a partial buffer, even when writes are supported', () => {
        expect(resolveFilePageHeaderModel({ ...text, partial: true }).editUnavailableReason).toBe('partial');
        expect(resolveFilePageHeaderModel({ ...text, hasText: false }).editUnavailableReason).toBe('binary');
    });
});
