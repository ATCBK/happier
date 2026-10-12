import { describe, expect, it, vi } from 'vitest';

import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { resolvePhoneWorkspaceTabHref } from '@/components/appShell/workspace/workspacePhoneProjection';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';

import { machinePageHref } from './machinePageHref';
import { machinePageTabRouteParams, type MachinePageTabParams } from './machinePageTabQuery';

installPanelCommonModuleMocks();
// Recipient-envelope HTTP/process APIs are outside this deterministic route harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in machine route test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});

/** The workspace router a machine page lives in: the real catalog, adapter and URL projection. */
function workspace(href: string) {
    let state = createWorkspaceState({ id: 'A', target: { kind: 'session', params: { id: 'A1', serverId: 'home-a' } }, pinned: false, preview: false });
    const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
    const commits: string[] = [];
    let id = 0;
    const adapter = createWorkspaceNavigationAdapter({
        getState: () => state, getCatalog: () => catalog,
        dispatch: (action) => { state = reduceWorkspaceState(state, action); },
        transport: { commit: (next) => { commits.push(next); } },
        createId: () => `generated:${++id}`, onChange: () => {},
    });
    adapter.initialize('/session/A1?serverId=home-a');
    adapter.openHref(href, { mode: 'newTab' });
    const active = () => state.tabs[state.groups[state.focusedGroupId].activeTabId];
    // What `MachinePageScreen` does on a tab press: the page's params are the destination's params.
    const selectTab = (next: MachinePageTabParams) => adapter.setParams(active().id, machinePageTabRouteParams(next));
    return { selectTab, openHref: adapter.openHref, target: () => active().target, href: () => commits.at(-1), catalog };
}

const target = { machineId: 'm1', serverId: 'home-a' };

describe('machine page tabs in the workspace router', () => {
    it('honors a direct Guard link after the machine was opened on Processes, on desktop and phone', () => {
        const guardHref = machinePageHref({ door: 'rail', target, tab: { id: 'guard' } });
        const page = workspace(machinePageHref({ door: 'rail', target, tab: { id: 'processes', sort: 'memory' } }));
        page.openHref(guardHref);
        expect(page.target()).toMatchObject({ params: { tab: 'guard', id: target.machineId, serverId: target.serverId } });
        expect(page.href()).toBe(guardHref);
        expect(resolvePhoneWorkspaceTabHref(page.catalog, guardHref)).toBe(guardHref);
    });

    it.each(['rail', 'settings'] as const)('keeps the %s door’s machine route when a tab changes', (door) => {
        const page = workspace(machinePageHref({ door, target }));
        for (const tab of [{ id: 'processes', sort: 'cpu' }, { id: 'storage' }, { id: 'guard', page: 'activity' }, { id: 'overview' }] as const) {
            page.selectTab(tab);
            expect(page.href()).toBe(machinePageHref({ door, target, tab }));
        }
    });

    it('keeps a phone-opened machine an entity leaf after a tab change', () => {
        const page = workspace(machinePageHref({ door: 'rail', target }));
        page.selectTab({ id: 'processes' });
        // The phone keys the tab by the machine's own route, not the Machines index.
        expect(resolvePhoneWorkspaceTabHref(page.catalog, page.href()!)).toBe(machinePageHref({ door: 'rail', target, tab: { id: 'processes' } }));
    });
});
