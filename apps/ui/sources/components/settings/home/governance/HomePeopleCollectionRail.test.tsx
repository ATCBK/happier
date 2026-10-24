import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeAccountPickerRowFixture, homeAccountRowFixture, homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
// Replace only the third-party recycler; rail, search, admission and Item owners remain real.
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { HomePeopleCollectionRail } = await import('./HomePeopleCollectionRail');
const { Item } = await import('@/components/ui/lists/Item');
const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
const { applyHomeGovernanceProjection, resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
const { resetHomeAccountRosterEngineForTests } = await import('@/sync/engine/home/governance/homeAccountRosterEngine');
const { resetHomeAccountRosterSnapshotsForTests } = await import('@/sync/store/home/governance/homeAccountRosterSnapshots');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const SEARCH_PATH = '/v1/home/accounts/search';

beforeEach(async () => {
    resetHomeGovernanceEngineForTests();
    resetHomeGovernanceSnapshotsForTests();
    resetHomeAccountRosterEngineForTests();
    resetHomeAccountRosterSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await home.reset();
});
afterEach(() => standardCleanup());

describe('People split rail search authority', () => {
    it.each(['capability withdrawn', 'search forbidden'] as const)('withdraws cached rows when %s and revalidates the same query after re-enabling', async refusal => {
        const serverId = await home.addHome({ name: 'Studio', serverUrl: 'https://rail-search.example', accountId: 'account-ada' });
        const scope = { serverId, accountId: 'account-ada' };
        const governance = homeGovernanceProjectionFixture();
        home.answer(serverId, '/v1/home/governance/get', { body: governance });
        home.answer(serverId, '/v1/home/accounts/list', { body: { items: [], nextCursor: null } });
        home.answer(serverId, SEARCH_PATH, { body: { accounts: [homeAccountPickerRowFixture('ada', 'Ada')] } });
        const screen = await renderScreen(<HomePeopleCollectionRail serverId={serverId} selectedAccountId={null} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-people-rail-search')).toBeTruthy());
        await act(async () => { screen.changeTextByTestId('home-people-rail-search', 'Ada'); });
        const rows = () => screen.tree.findAllByType(Item).filter(node => String(node.props.testID).startsWith('home-people-rail-row:'));
        await waitForHomeGovernance(() => expect(rows().map(node => node.props.title)).toEqual(['Ada']));
        expect(home.requestsFor(SEARCH_PATH)).toHaveLength(1);
        if (refusal === 'search forbidden') {
            home.answer(serverId, SEARCH_PATH, { status: 403, body: { error: 'forbidden' } });
            await act(async () => { screen.changeTextByTestId('home-people-rail-search', 'Grace'); });
            await waitForHomeGovernance(() => expect(screen.findByTestId('home-people-rail-search-failed')).toBeTruthy());
            await act(async () => { screen.changeTextByTestId('home-people-rail-search', 'Ada'); });
            expect(rows()).toHaveLength(0);
        }
        await act(async () => {
            applyHomeGovernanceProjection({ scope, projection: { ...governance,
                capabilities: { ...governance.capabilities, manageAccounts: false } }, observedAt: Date.now() });
        });
        expect(rows()).toHaveLength(0);
        expect(screen.findByTestId('home-people-rail-search')).toBeNull();
        const beforeRecovery = home.requestsFor(SEARCH_PATH).length;
        home.answer(serverId, SEARCH_PATH, { body: { accounts: [homeAccountPickerRowFixture('fresh-ada', 'New Ada')] } });
        await act(async () => { applyHomeGovernanceProjection({ scope, projection: governance, observedAt: Date.now() }); });
        expect(rows()).toHaveLength(0);
        await waitForHomeGovernance(() => expect(rows().map(node => node.props.title)).toEqual(['New Ada']));
        expect(home.requestsFor(SEARCH_PATH)).toHaveLength(beforeRecovery + 1);
    });
});

describe('People rail status slot', () => {
    it('says a disabled person in the icon-only status slot and keeps an active person quiet', async () => {
        const serverId = await home.addHome({ name: 'Studio', serverUrl: 'https://rail-status.example', accountId: 'account-ada' });
        home.answer(serverId, '/v1/home/governance/get', { body: homeGovernanceProjectionFixture() });
        home.answer(serverId, '/v1/home/accounts/list', { body: { items: [
            homeAccountRowFixture('ada', { status: 'suspended' }), homeAccountRowFixture('grace')], nextCursor: null } });
        const screen = await renderScreen(<HomePeopleCollectionRail serverId={serverId} selectedAccountId={null} />);
        const glyphs = () => screen.tree.findAll(node => node.props.accessibilityRole === 'image'
            && node.props.accessibilityLabel === 'homeGovernance.statusDisabled');
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-people-rail-row:grace')).toBeTruthy());
        expect(glyphs().length).toBeGreaterThan(0);
        const quiet = screen.tree.findAll(node => node.props.accessibilityRole === 'image');
        expect(new Set(quiet.map(node => node.props.accessibilityLabel))).toEqual(new Set(['homeGovernance.statusDisabled']));
    });
});
