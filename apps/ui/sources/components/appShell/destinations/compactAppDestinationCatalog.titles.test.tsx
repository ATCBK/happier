import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { storage } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import {
    readDestinationInstanceTitle,
    resolveCompactAppDestinations,
    resolveDestinationRefFromHref,
    useDestinationInstanceTitles,
} from './compactAppDestinationCatalog';

installPanelCommonModuleMocks();
// Catalog titles never access the Session-envelope HTTP boundary.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Unexpected Session-envelope HTTP request in catalog title test'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});

const scope = { serverId: 'home-a', accountId: 'account-a' };
const lumen: WorkspaceRefV1 = { id: 'checkout', serverId: scope.serverId, machineId: 'machine-a',
    rootPath: '/work/lumen', label: 'Lumen', createdAtMs: 1 };
const atlas: WorkspaceRefV1 = { ...lumen, serverId: 'home-b', label: 'Atlas' };
const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
    externalSessions: false, inbox: false, workflows: false, friends: false,
} });
function destination(href: string) {
    const ref = resolveDestinationRefFromHref(catalog, href);
    if (!ref) throw new Error(`Unregistered fixture destination: ${href}`);
    return ref;
}

beforeEach(() => {
    storage.getState().activateProfileScope(scope);
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [lumen, atlas] });
});
afterEach(() => {
    standardCleanup();
    storage.setState(storage.getInitialState(), true);
});

describe('Project destination instance titles', () => {
    it('does not name a nested screen after its parent area before its title supplier loads', () => {
        for (const href of ['/session/example/info', '/session/example/files', '/artifacts/example', '/settings/prompts/docs/example']) {
            expect(readDestinationInstanceTitle(catalog, destination(href)), href).toBeNull();
        }
        expect(readDestinationInstanceTitle(catalog, destination('/'))).toBe(t('tabs.sessions'));
        expect(readDestinationInstanceTitle(catalog, destination('/settings/appearance'))).toBe(t('settings.appearance'));
    });
    it('names qualified Projects and their pages while only the hub keeps the catalog title', () => {
        expect(readDestinationInstanceTitle(catalog, destination('/projects'))).toBe(t('tabs.projects'));
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout?serverId=home-a'))).toBe('Lumen');
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout?serverId=home-b'))).toBe('Atlas');
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout/code?serverId=home-a')))
            .toBe(`Lumen · ${t('projects.pages.code')}`);
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout/code?serverId=home-a&activeRootPath=%2Fwork%2Flumen-release')))
            .toBe(`Lumen · lumen-release · ${t('projects.pages.code')}`);
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout/code?serverId=home-a&worktreeId=%40root&activeRootPath=%2Fwork%2Flumen-release')))
            .toBe(`Lumen · ${t('projects.pages.code')}`);
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout/terminal?serverId=home-a')))
            .toBe(`Lumen · ${t('settings.terminal')}`);
    });

    it('leaves unavailable or ambiguous identities unnamed for the existing saved-title placeholder', () => {
        expect(readDestinationInstanceTitle(catalog, destination('/projects/not-loaded/code?serverId=home-a'))).toBeNull();
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout'))).toBeNull();
        expect(readDestinationInstanceTitle(catalog, destination('/projects/checkout?serverId=unknown-home'))).toBeNull();
    });

    it('updates retained and duplicate tab titles through rename and refresh without changing their keys', async () => {
        const ref = destination('/projects/checkout/code?serverId=home-a');
        const entries = [{ key: 'first', ref }, { key: 'explicit-duplicate', ref },
            { key: 'loading', ref: destination('/projects/not-loaded/code?serverId=home-a') }];
        const hook = await renderHook(() => useDestinationInstanceTitles(catalog, entries));
        expect([...hook.getCurrent()]).toEqual([
            ['first', `Lumen · ${t('projects.pages.code')}`],
            ['explicit-duplicate', `Lumen · ${t('projects.pages.code')}`],
        ]);
        const unchanged = hook.getCurrent();
        await act(async () => { storage.setState({ isDataReady: false }); });
        expect(hook.getCurrent()).toBe(unchanged);
        await act(async () => {
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ ...lumen, label: 'Lumen renamed' }, atlas] });
            storage.getState().setProjectAccountRowsStatusForScope(scope, 'loading');
        });
        expect(hook.getCurrent().get('first')).toBe(`Lumen renamed · ${t('projects.pages.code')}`);
        expect(hook.getCurrent().get('explicit-duplicate')).toBe(hook.getCurrent().get('first'));
        expect(hook.getCurrent().has('loading')).toBe(false);
        await act(async () => {
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ ...lumen, label: null }, atlas] });
        });
        expect(hook.getCurrent().get('first')).toBe(`lumen · ${t('projects.pages.code')}`);
        await act(async () => { storage.getState().activateProfileScope({ ...scope, accountId: 'account-b' }); });
        expect(hook.getCurrent().size).toBe(0);
        expect(readDestinationInstanceTitle(catalog, ref)).toBeNull();
        await hook.unmount();
    });
});
