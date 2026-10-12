import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Imported from their own testkit modules rather than the `@/dev/testkit` barrel: see
// `HomeAdministrationPeopleScreen.test.tsx` for why the barrel would bind the real transports first.
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { installSettingsViewCommonModuleMocks } from '../settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const machines = vi.hoisted(() => ({ value: [] as unknown[] }));

installSettingsViewCommonModuleMocks({
    storage: async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
        return { ...actual, useAllMachines: () => machines.value };
    },
});

// Only the network and the device credential store are replaced; the Home binding, engine and
// governance store below the header are the production ones.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");

const GOVERNANCE_PATH = '/v1/home/governance/get';

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    resetHomeGovernanceSnapshotsForTests();
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    machines.value = [{ id: 'm1' }, { id: 'm2' }];
});

afterEach(() => {
    standardCleanup();
    machines.value = [];
});

async function renderHeader() {
    const { HubIdentityHeader } = await import('./HubIdentityHeader');
    return renderScreen(<HubIdentityHeader />);
}

describe('HubIdentityHeader', () => {
    it('says which Home this is and the viewer\'s role in it, not a machine count', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada' });
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        const screen = await renderHeader();

        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-overview-role')).toBeTruthy());
        expect(screen.getTextContent()).toContain('homeGovernance.roleOwner');
        expect(screen.findByTestId('settings-overview-home')).toBeTruthy();
        expect(screen.findByTestId('settings-overview-machines')).toBeNull();
    });

    it('never waits on a Home that does not answer: the header shows without a role', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada' });
        harness.answer(home, GOVERNANCE_PATH, { status: 503, body: { error: 'unavailable' } });
        const screen = await renderHeader();

        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-overview-home')).toBeTruthy());
        expect(screen.findByTestId('settings-overview-role')).toBeNull();
    });
});
