import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
// These view primitives stand in for platform rendering only; the directory
// reader, Action executor, transport and paged-list lifetime remain real.
vi.mock('@/components/ui/lists/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { DirectoryPeopleList } = await import('./DirectoryPeopleList');
afterEach(async () => { standardCleanup(); await harness.reset(); });

const path = '/v1/teams/team-1/directory-sources/source-1/people?limit=50';
const person = {
    v: 1, id: 'person-1', sourceId: 'source-1', externalUserId: 'external-1',
    displayName: 'Ada', email: null, externalLogin: null, state: 'active',
    accountBinding: { state: 'unbound' }, sourceLabel: 'Directory',
};

async function mountPeople() {
    const serverId = await harness.addHome({ name: 'Directory Home', serverUrl: 'https://directory-people.example', accountId: 'account-1', teamsEnabled: true });
    harness.answer(serverId, path, { body: { items: [person], nextCursor: 'next' } });
    const screen = await renderScreen(<DirectoryPeopleList scope={{ serverId, accountId: 'account-1' }} address={{ serverId, teamId: 'team-1' }} sourceId="source-1" />);
    await waitForHomeGovernance(() => expect(screen.tree.root.findAllByType('Item' as never).some((item) => item.props.loading === true)).toBe(false));
    expect(screen.findByTestId('directory-person:person-1'), JSON.stringify(harness.requests.map((request) => request.path))).not.toBeNull();
    return { serverId, screen };
}

describe('Directory people read outcomes', () => {
    it('withdraws previously loaded people after an authoritative denial without showing a false empty state', async () => {
        const { serverId, screen } = await mountPeople();
        harness.answer(serverId, `${path}&cursor=next`, { status: 403, body: { error: 'forbidden' } });
        await screen.pressByTestIdAsync('directory-people-load-more');
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-people-load-more')?.props.loading).not.toBe(true));
        expect(screen.findByTestId('directory-person:person-1')).toBeNull();
        expect(screen.findByTestId('directory-people-error')).not.toBeNull();
        expect(screen.findByTestId('directory-people-empty')).toBeNull();
        expect(screen.findByTestId('directory-people-retry')).toBeNull();
    });

    it('keeps a loaded page on transport failure and recovers through the rendered retry', async () => {
        const { serverId, screen } = await mountPeople();
        harness.answer(serverId, `${path}&cursor=next`, { dispatchThenFail: true });
        await screen.pressByTestIdAsync('directory-people-load-more');
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-people-retry')).not.toBeNull());
        expect(screen.findByTestId('directory-person:person-1')).not.toBeNull();
        harness.answer(serverId, path, { body: { items: [{ ...person, displayName: 'Ada refreshed' }], nextCursor: null } });
        await screen.pressByTestIdAsync('directory-people-retry');
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-person:person-1')?.props.title).toBe('Ada refreshed'));
        expect(screen.findByTestId('directory-people-error')).toBeNull();
    });
});
