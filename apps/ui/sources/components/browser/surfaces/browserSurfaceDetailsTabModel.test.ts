import { describe, expect, it } from 'vitest';

import {
    BROWSER_VIEW_DETAILS_TAB_KIND,
    createBrowserLaunchpadDetailsTab,
    createBrowserViewDetailsTab,
    readBrowserViewDetailsResource,
    readBrowserViewLaunchpadResource,
    selectBrowserWorkspaceViewerTab,
} from './browserSurfaceDetailsTabModel';

describe('browser surface details tab model', () => {
    it('keeps a double-slash preview pathname relative to fresh access on restore', () => {
        const target = { kind: 'localServicePreview', targetId: 'preview', sessionId: 'session', machineId: 'machine' } as const;
        const tab = createBrowserViewDetailsTab({ target, currentUrl: 'https://old-preview.test//details?qa93=1#section' });
        const restored = readBrowserViewDetailsResource(JSON.parse(JSON.stringify(tab.resource)));
        expect(restored?.currentUrl).toBe('.//details?qa93=1#section');
        const destination = new URL(restored!.currentUrl!, 'https://fresh-preview.test/');
        expect(destination.origin).toBe('https://fresh-preview.test');
        expect(destination.pathname).toBe('//details');
    });

    it.each([
        { target: { kind: 'localServicePreview', targetId: 'preview', sessionId: 'session', machineId: 'machine' },
            expected: '/details?qa93=1#section' },
        { target: { kind: 'externalUrl', targetId: 'external', url: 'https://external.test/' },
            expected: 'https://preview.test/details?qa93=1&previewToken=one-use#section' },
    ] as const)('round trips the last location for $target.kind without storing preview admission', ({ target, expected }) => {
        const tab = createBrowserViewDetailsTab({ target,
            currentUrl: 'https://preview.test/details?qa93=1&previewToken=one-use#section' });
        const restored = readBrowserViewDetailsResource(JSON.parse(JSON.stringify(tab.resource)));
        expect(restored).toMatchObject({ target, currentUrl: expected });
        if (target.kind === 'localServicePreview') expect(JSON.stringify(tab)).not.toContain('one-use');
    });

    it('selects the current Browser workspace source and refuses an unrelated active Details tab', () => {
        const first = { ...createBrowserViewDetailsTab({ target: { kind: 'externalUrl', targetId: 'first', url: 'https://first.test/' } }),
            isPreview: false, isPinned: true };
        const selected = { ...createBrowserViewDetailsTab({ target: { kind: 'externalUrl', targetId: 'selected', url: 'https://selected.test/' } }),
            isPreview: false, isPinned: true };
        expect(selectBrowserWorkspaceViewerTab({ tabs: [first, selected], activeTabKey: selected.key })).toBe(selected);
        expect(selectBrowserWorkspaceViewerTab({ tabs: [first, selected], activeTabKey: 'file:readme' })).toBeNull();
        expect(selectBrowserWorkspaceViewerTab(null)).toBeNull();
    });
    it('builds the launchpad as a canonical browser-view tab carrying a launchpad resource', () => {
        const launchpad = createBrowserLaunchpadDetailsTab();

        expect(launchpad.kind).toBe(BROWSER_VIEW_DETAILS_TAB_KIND);
        expect(launchpad.resource).toMatchObject({
            kind: 'browser-view',
            mode: 'launchpad',
            browserSessionId: 'browser_surface:details:browser_launchpad',
        });
        // The launchpad is recognized by the launchpad reader but NOT the single-view reader.
        expect(readBrowserViewLaunchpadResource(launchpad.resource)).not.toBeNull();
        expect(readBrowserViewDetailsResource(launchpad.resource)).toBeNull();
    });

    it('builds a browser-view tab carrying the workspace seam resource (browserSessionId, viewId, target)', () => {
        const target = {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: { title: 'Preview' },
        } as const;
        const tab = createBrowserViewDetailsTab({ target });

        expect(tab.kind).toBe(BROWSER_VIEW_DETAILS_TAB_KIND);
        expect(tab.title).toBe('Preview');
        expect(tab.resource).toEqual({
            kind: 'browser-view',
            browserSessionId: 'browser_surface:details:localServicePreview:session_1:preview_1',
            viewId: 'browser_view:preview_1',
            target,
        });
    });

    it('derives a stable key per target+session so reopening focuses the existing workspace tab', () => {
        const target = {
            kind: 'externalUrl',
            targetId: 'docs',
            url: 'https://docs.test/',
        } as const;
        const first = createBrowserViewDetailsTab({ target });
        const second = createBrowserViewDetailsTab({ target });
        expect(first.key).toBe(second.key);
    });

    it('honors an explicit browserSessionId / viewId override (scoped mounts)', () => {
        const target = {
            kind: 'externalUrl',
            targetId: 'docs',
            url: 'https://docs.test/',
        } as const;
        const tab = createBrowserViewDetailsTab({
            target,
            browserSessionId: 'scoped:session',
            viewId: 'scoped:view',
            scope: 'mobile',
        });
        expect(tab.resource).toMatchObject({
            kind: 'browser-view',
            browserSessionId: 'scoped:session',
            viewId: 'scoped:view',
        });
    });

    it('reads a single-view browser-view resource and rejects the launchpad resource', () => {
        const target = {
            kind: 'externalUrl',
            targetId: 'docs',
            url: 'https://docs.test/',
        } as const;
        const tab = createBrowserViewDetailsTab({ target });
        expect(readBrowserViewDetailsResource(tab.resource)).not.toBeNull();
        expect(readBrowserViewDetailsResource(createBrowserLaunchpadDetailsTab().resource)).toBeNull();
        expect(readBrowserViewDetailsResource({ kind: 'browser-view' })).toBeNull();
    });
});
