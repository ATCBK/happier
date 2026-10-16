import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep this shell test independent from unrelated generated plugin artifacts.
// These are the same canonical testkit owners re-exported by `@/dev/testkit`,
// imported from their owning modules because the Home boundaries are installed
// with `vi.doMock` (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    homeAccountRowFixture,
    homeGovernanceProjectionFixture,
} from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { createUiApprovalRequest, decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
// The wait budget the rest of this family already inherits from the runner
// instead of `vi.waitFor`'s 1 s default, which is a shorter competing cutoff
// inside a case the runner already bounds.
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import type { HomeAdministrationContext } from './homeAdministrationContext';

/**
 * The approval shell of Home administration, over the real approval lifecycle.
 *
 * The credential binding, projection reader and refresh are real. The approval is
 * real end to end — a present-user Home mutation creates it through the shared
 * Action front door, the Inbox decides it through the generic executor, and the
 * section reads the outcome through the real `useApprovalArtifact` over the
 * Home's stateful Artifact store. No terminal record is written by hand.
 */

// The package Vitest config supplies the canonical empty app-asset boundary.
// Artifact sources, availability readers and stores stay real.

installSettingsViewCommonModuleMocks({
    router: async () => ({
        ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
    }),
    // The approval writer and reader use the real store, with no async mock factory.
    storage: 'real',
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const ACCOUNT_ID = 'account-a';
const DISABLE_PATH = '/v1/home/accounts/disable';
const GOVERNANCE_PATH = '/v1/home/governance/get';

/** One Home whose Account requires approval for disabling another Account. */
async function addAdministeredHome(): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home One',
        serverUrl: 'https://home-administration.example',
        accountId: ACCOUNT_ID,
    });
    harness.answer(serverId, GOVERNANCE_PATH, {
        body: homeGovernanceProjectionFixture({ viewer: { accountId: ACCOUNT_ID, homeRole: 'owner', status: 'active' } }),
    });
    await harness.requireUiApproval(serverId, 'home.accounts.disable');
    return serverId;
}

/** The open approval a present-user Account hold leaves on its Home. */
async function openDisableApproval(serverId: string, requestId: string): Promise<string> {
    return await createUiApprovalRequest({
        serverId,
        actionId: 'home.accounts.disable',
        actionInput: { accountId: 'account-grace' },
        actionRequestId: requestId,
    });
}

let nextMountId = 0;
const renderedContexts: HomeAdministrationContext[] = [];
let HomeAdministrationSection: typeof import('./HomeAdministrationSection')['HomeAdministrationSection'];

function ChildProbe(props: Readonly<{ context: HomeAdministrationContext }>) {
    const [mountId] = React.useState(() => ++nextMountId);
    renderedContexts.push(props.context);
    return React.createElement('HomeAdministrationSectionProbe', {
        testID: 'home-admin-child-probe',
        mountId,
        accountId: props.context.scope.accountId,
    });
}

describe('HomeAdministrationSection Account binding', () => {
    beforeAll(async () => {
        ({ HomeAdministrationSection } = await import('./HomeAdministrationSection'));
    }, 120_000);

    afterAll(() => {
        standardCleanup();
    });

    beforeEach(async () => {
        standardCleanup();
        await harness.reset();
        const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
        const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
        resetHomeGovernanceEngineForTests();
        resetHomeGovernanceSnapshotsForTests();
        renderedContexts.length = 0;
        nextMountId = 0;
    });

    afterEach(() => standardCleanup());

    it('remounts section-local state and rejects a stale approval registration after the bound Account changes', async () => {
        const serverId = await addAdministeredHome();
        const staleArtifactId = await openDisableApproval(serverId, 'disable-stale');
        const renderSection = (title: string) => (
            <HomeAdministrationSection serverId={serverId} title={title}>
                {(context) => <ChildProbe context={context} />}
            </HomeAdministrationSection>
        );
        const screen = await renderScreen(renderSection('Home A'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-admin-child-probe')).not.toBeNull());
        const firstMountId = screen.findByTestId('home-admin-child-probe')?.props.mountId;
        const staleRequestApproval = renderedContexts.at(-1)!.requestApproval!;

        harness.answer(serverId, GOVERNANCE_PATH, {
            body: homeGovernanceProjectionFixture({ viewer: { accountId: 'account-b', homeRole: 'owner', status: 'active' } }),
        });
        await act(async () => {
            await harness.switchAccount(serverId, 'account-b');
            await screen.update(renderSection('Home B'));
        });

        await waitForHomeGovernance(() => expect(screen.findByTestId('home-admin-child-probe')?.props.accountId).toBe('account-b'));
        expect(screen.findByTestId('home-admin-child-probe')?.props.mountId).not.toBe(firstMountId);

        // A genuinely open approval begun as the previous Account must not be
        // handed to the Account now bound to this Home.
        await act(async () => staleRequestApproval(staleArtifactId));
        expect(screen.findByTestId('home-admin-approval')).toBeNull();
    });

    it.each([
        {
            status: 'rejected' as const,
            decision: 'reject' as const,
            homeAnswer: null,
        },
        {
            // The Home refuses the replayed hold, so execution settles failed.
            status: 'failed' as const,
            decision: 'approve' as const,
            homeAnswer: { status: 409, body: { error: 'account_not_found' } },
        },
    ])(
        'releases a $status approval so Home administration restores mutation availability without refreshing',
        async ({ status, decision, homeAnswer }) => {
            const serverId = await addAdministeredHome();
            if (homeAnswer) harness.answer(serverId, DISABLE_PATH, homeAnswer);
            const artifactId = await openDisableApproval(serverId, `disable-${status}`);
            const screen = await renderScreen(
                <HomeAdministrationSection serverId={serverId} title="Home A">
                    {(context) => <ChildProbe context={context} />}
                </HomeAdministrationSection>,
            );
            await waitForHomeGovernance(() => expect(screen.findByTestId('home-admin-child-probe')).not.toBeNull());
            const initialReads = harness.requestsFor(GOVERNANCE_PATH).length;
            const onTerminal = vi.fn();

            await act(async () => renderedContexts.at(-1)!.requestApproval!({
                artifactId,
                onExecuted: vi.fn(async () => 'consumed' as const),
                onTerminal,
            }));
            await waitForHomeGovernance(() => expect(screen.findByTestId('home-admin-approval')).not.toBeNull());
            expect(renderedContexts.at(-1)!.mutationsAvailable).toBe(false);

            // The approval is decided in the Inbox rather than here, so the shell
            // observes it through the shared artifact reader.
            await expect(decideApprovalAsInbox(serverId, artifactId, decision)).resolves.toMatchObject({ ok: true });

            await waitForHomeGovernance(() => expect(screen.findByTestId('home-admin-approval')).toBeNull());
            expect(onTerminal).toHaveBeenCalledOnce();
            expect(onTerminal).toHaveBeenCalledWith(status, expect.objectContaining({ id: artifactId }));
            expect(renderedContexts.at(-1)!.approvalPending).toBe(false);
            expect(renderedContexts.at(-1)!.mutationsAvailable).toBe(true);
            expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(initialReads);
            expect(harness.requestsFor(DISABLE_PATH)).toHaveLength(decision === 'approve' ? 1 : 0);
        },
    );

    it('delivers one executed Artifact to the exact process-local continuation and never redelivers it', async () => {
        const serverId = await addAdministeredHome();
        harness.answer(serverId, DISABLE_PATH, {
            body: homeAccountRowFixture('account-grace', { status: 'disabled' }),
        });
        const artifactId = await openDisableApproval(serverId, 'disable-executed');
        const renderSection = () => (
            <HomeAdministrationSection serverId={serverId} title="Home A">
                {(context) => <ChildProbe context={context} />}
            </HomeAdministrationSection>
        );
        const screen = await renderScreen(renderSection());
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-admin-child-probe')).not.toBeNull());
        const initialReads = harness.requestsFor(GOVERNANCE_PATH).length;
        harness.answer(serverId, GOVERNANCE_PATH, {
            body: homeGovernanceProjectionFixture({ activeOwnerCount: 3, viewer: { accountId: ACCOUNT_ID, homeRole: 'owner', status: 'active' } }),
        });
        const onExecuted = vi.fn(async () => 'consumed' as const);

        await act(async () => renderedContexts.at(-1)!.requestApproval!({
            artifactId,
            onExecuted,
        }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-admin-approval')).not.toBeNull());
        expect(renderedContexts.at(-1)!.mutationsAvailable).toBe(false);

        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });

        await waitForHomeGovernance(() => expect(onExecuted).toHaveBeenCalledTimes(1));
        expect(onExecuted).toHaveBeenCalledWith(expect.objectContaining({ id: artifactId }));
        await waitForHomeGovernance(() => expect(renderedContexts.at(-1)!.projection.activeOwnerCount).toBe(3));
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(initialReads + 1);
        expect(harness.requestsFor(GOVERNANCE_PATH).at(-1)?.serverId).toBe(serverId);
        expect(screen.findByTestId('home-admin-approval')).toBeNull();
        expect(renderedContexts.at(-1)!.approvalPending).toBe(false);
        expect(renderedContexts.at(-1)!.mutationsAvailable).toBe(true);

        await screen.update(renderSection());
        expect(onExecuted).toHaveBeenCalledTimes(1);
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(initialReads + 1);
        expect(harness.requestsFor(DISABLE_PATH)).toHaveLength(1);
    });
});
