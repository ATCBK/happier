import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key });
});

const { buildFilePageCrumbs } = await import('./FilePageBreadcrumb');
const { resolveFilePageAttributionText } = await import('./FilePageAttributionFact');

describe('File page facts', () => {
    it('keeps the first and last two folders and folds the middle into one crumb that opens nothing', () => {
        const crumbs = buildFilePageCrumbs('apps/ui/sources/components/settings/modal/SettingsModal.tsx');
        expect(crumbs.map((crumb) => crumb.label)).toEqual(['apps', 'ui', '…', 'settings', 'modal']);
        expect(crumbs.map((crumb) => crumb.path)).toEqual(['apps', 'apps/ui', null, 'apps/ui/sources/components/settings', 'apps/ui/sources/components/settings/modal']);
        expect(buildFilePageCrumbs('apps/ui/sources/a/b/file.ts').map((crumb) => crumb.label)).toEqual(['apps', 'ui', 'sources', 'a', 'b']);
        expect(buildFilePageCrumbs('README.md')).toEqual([]);
    });

    it('leads with the repository root when the host names it, and the root opens the root listing', () => {
        expect(buildFilePageCrumbs('README.md', 'happier')).toEqual([{ key: '/', label: 'happier', path: '' }]);
        expect(buildFilePageCrumbs('src/settings/SettingsModal.tsx', 'happier').map((crumb) => crumb.label))
            .toEqual(['happier', 'src', 'settings']);
    });

    it('says "Updated by {agent} just now" for a minute, then the agent and the age', () => {
        const at = 1_000_000;
        const base = { agentName: 'Claude', requesterName: null, updatedAt: at };
        expect(resolveFilePageAttributionText({ ...base, nowMs: at + 59_000 })).toEqual({ key: 'justNow',
            text: 'files.pane.page.updatedByJustNow:{"agent":"Claude"}' });
        expect(resolveFilePageAttributionText({ ...base, nowMs: at + 120_000 })?.key).toBe('age');
        expect(resolveFilePageAttributionText({ ...base, nowMs: at + 120_000 })?.text).toContain('files.pane.page.byAgentAge');
        // In a team session the person whose message started the turn is named too (O-P3-1).
        expect(resolveFilePageAttributionText({ ...base, requesterName: 'Alice', nowMs: at })?.text)
            .toBe('files.pane.page.updatedByForJustNow:{"agent":"Claude","person":"Alice"}');
        // Unattributed: only a fresh write is worth saying, and never "by" nobody.
        expect(resolveFilePageAttributionText({ ...base, agentName: null, nowMs: at })?.text).toBe('files.pane.page.updatedJustNow');
        expect(resolveFilePageAttributionText({ ...base, agentName: null, nowMs: at + 120_000 })).toBeNull();
        expect(resolveFilePageAttributionText({ ...base, updatedAt: null, nowMs: at })).toBeNull();
    });
});
