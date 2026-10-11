import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApprovalRequestV1Schema,
    ApprovalRequestV2Schema,
    buildApprovalRequestArtifactHeaderV1,
    type ApprovalArtifactHeaderV1,
} from '@happier-dev/protocol';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel:
// the harness installs its network boundaries with `vi.doMock`, which only
// reaches modules imported afterwards (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createUiApprovalRequest, decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

/**
 * The exact-Home approval reader over real saved Homes and their stateful
 * Artifact stores.
 *
 * Home resolution (portable identity → this device's local profile), the scoped
 * Account context, the Artifact codec and the Home's own rows are all real; only
 * the network and the device credential store are replaced. An approval is
 * either created by the product's present-user front door or stored through the
 * Home's Artifact route the way any client of that route can — never injected
 * into an internal store.
 */

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const ACCOUNT_ID = 'account-1';
// Real published identities: the profile owner ignores a malformed one, so a
// fixture outside this shape would silently model a Home that published none.
const HOME_IDENTITY = 'srv_home-b';
const OTHER_IDENTITY = 'srv_other-home';

/**
 * One saved, signed-in Home, with this device's live Account scope established
 * the way the sync owner does it for the active Home (`activateAccountSettingsScope`),
 * naming the Home by its scope id — its published identity when it has one.
 */
async function addHome(serverIdentityId: string | null, url = 'https://approval-home-b.example'): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home B',
        serverUrl: url,
        accountId: ACCOUNT_ID,
        teamsEnabled: true,
        ...(serverIdentityId ? { serverIdentityId } : {}),
    });
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const { storage } = await import('@/sync/domains/state/storage');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: ACCOUNT_ID };
    await storage.getState().activateSettingsScope(scope, []);
    storage.getState().activateProfileScope(scope, []);
    return serverId;
}

type Reader = Awaited<ReturnType<typeof renderReader>>;

/** Waits for the reader's settled answer, reporting what it last showed and asked. */
async function settle(hook: Reader, artifactId: string, assertion: (state: ReturnType<Reader['getCurrent']>) => void) {
    await vi.waitFor(() => {
        const state = hook.getCurrent();
        const observed = JSON.stringify({
            artifactId: state.artifact?.id ?? null,
            error: state.error,
            invalid: state.invalidArtifact,
            homeUnavailable: state.homeUnavailable,
            loading: state.isLoading,
            reads: harness.requestsFor(`/v1/artifacts/${artifactId}`).map((entry) => entry.serverId),
        });
        try {
            assertion(state);
        } catch (cause) {
            throw new Error(`${observed}: ${String(cause)}`);
        }
    }, { timeout: 20_000 });
}

/** A present-user Team rename the Account explicitly requires approval for. */
async function openPresentUserApproval(serverId: string): Promise<string> {
    await harness.requireUiApproval(serverId, 'teams.update');
    return await createUiApprovalRequest({
        serverId,
        actionId: 'teams.update',
        actionInput: { v: 1, teamId: 'team-1', name: 'Renamed' },
        actionRequestId: 'rename-1',
    });
}

/** Stores one approval row through the Home's Artifact route, as its creator would. */
async function storeApproval(serverId: string, header: ApprovalArtifactHeaderV1, body: unknown): Promise<string> {
    const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureActionAccountContext(serverId, new AbortController().signal);
    try {
        return await context.createArtifact(header, JSON.stringify(body));
    } finally {
        context.dispose();
    }
}

/** An approval a Home signed for an external API invocation: it records the Home's portable identity. */
function homeSignedRequest(serverId: string, serverIdentityId: string) {
    return ApprovalRequestV2Schema.parse({
        v: 2,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system' },
        requestedSurface: 'api',
        executionOriginV1: {
            v: 1,
            authority: 'account_automation',
            surface: 'api',
            caller: { kind: 'host' },
            serverId,
            serverIdentityId,
            accountId: ACCOUNT_ID,
            principalId: 'principal-1',
            credentialId: 'credential-1',
            actionId: 'session.title.set',
            requestId: 'request-1',
        },
        actionId: 'session.title.set',
        actionArgs: { sessionId: 'session-1', title: 'Updated title' },
        summary: 'Set session title',
    });
}

async function renderReader(artifactId: string, serverId: string | null) {
    const { useApprovalArtifact } = await import('./useApprovalArtifact');
    return await renderHook(() => useApprovalArtifact({ artifactId, serverId }));
}

/**
 * Puts this Artifact id into the device's active-Home Artifact store the way the
 * product does: an unscoped reader (no Home named) reads it through the active
 * Home and records the row in the one Artifact store.
 */
async function primeActiveHomeArtifactRow(artifactId: string): Promise<number> {
    const active = await renderReader(artifactId, null);
    await settle(active, artifactId, (state) => expect(state.artifact?.id).toBe(artifactId));
    const { storage } = await import('@/sync/domains/state/storage');
    expect(storage.getState().artifacts[artifactId]?.id).toBe(artifactId);
    await active.unmount();
    return harness.requestsFor(`/v1/artifacts/${artifactId}`).length;
}

describe('useApprovalArtifact', () => {
    beforeEach(async () => {
        standardCleanup();
        await harness.reset();
    });

    afterEach(() => standardCleanup());

    it('observes a newer approval revision even when the local acknowledgement timestamp does not advance', async () => {
        // The OS clock is a boundary, not an Artifact revision. Fast acknowledgements
        // can share a millisecond and a server clock can run ahead of this device.
        const serverId = await addHome(HOME_IDENTITY);
        const artifactId = await openPresentUserApproval(serverId);
        const hook = await renderReader(artifactId, serverId);
        await settle(hook, artifactId, state => expect(state.artifact?.header?.approvalStatus).toBe('open'));
        vi.spyOn(Date, 'now').mockReturnValue(hook.getCurrent().artifact!.updatedAt);
        harness.answer(serverId, '/v1/teams/update', { body: teamSummaryFixture({ name: 'Renamed' }) });
        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({ ok: true });
        expect(hook.getCurrent().artifact?.header?.approvalStatus).toBe('executed');
        expect(ApprovalRequestV2Schema.parse(JSON.parse(hook.getCurrent().artifact!.body as string)))
            .toMatchObject({ status: 'executed', execution: { ok: true } });
        await hook.unmount();
    });

    it('keeps an exact-Home present-user approval readable when its origin declares no portable identity', async () => {
        // A Settings form opens its own deferred approval on one exact Home. Only a
        // Home-signed external invocation records a portable identity, so requiring
        // one here would make every locally admitted V2 approval unreadable.
        const serverId = await addHome(HOME_IDENTITY);
        const artifactId = await openPresentUserApproval(serverId);

        const hook = await renderReader(artifactId, serverId);

        await waitForHomeGovernance(() => expect(hook.getCurrent().artifact?.id).toBe(artifactId));
        expect(hook.getCurrent().error).toBe(false);
        expect(hook.getCurrent().invalidArtifact).toBe(false);
        expect(ApprovalRequestV2Schema.parse(JSON.parse(hook.getCurrent().artifact!.body as string)))
            .toMatchObject({ status: 'open', actionId: 'teams.update' });
    });

    it('reads through the active Home when the caller names no Home', async () => {
        const serverId = await addHome(null);
        const artifactId = await openPresentUserApproval(serverId);

        const hook = await renderReader(artifactId, null);

        await waitForHomeGovernance(() => expect(hook.getCurrent().artifact?.id).toBe(artifactId));
        expect(hook.getCurrent().error).toBe(false);
    });

    it('resolves a portable Home identity to this device local profile before its first body fetch', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);

        const hook = await renderReader(artifactId, HOME_IDENTITY);

        await settle(hook, artifactId, (state) => expect(state.artifact?.id).toBe(artifactId));
        expect(hook.getCurrent().homeUnavailable).toBe(false);
        expect(harness.requestsFor(`/v1/artifacts/${artifactId}`).map((entry) => entry.serverId))
            .toEqual(expect.arrayContaining([serverId]));
    });

    it('reports an unresolvable portable Home as unavailable instead of reading another Home', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);
        const readsBefore = await primeActiveHomeArtifactRow(artifactId);

        const hook = await renderReader(artifactId, 'srv_home-not-saved');

        expect(hook.getCurrent().homeUnavailable).toBe(true);
        expect(hook.getCurrent().error).toBe(true);
        // No Home is asked on behalf of an identity this device cannot resolve,
        // and the active Home's row with the same id is not presented as its answer.
        expect(harness.requestsFor(`/v1/artifacts/${artifactId}`)).toHaveLength(readsBefore);
        expect(hook.getCurrent().artifact).toBeNull();
    });

    it('keeps an approval a 0.2 client created (V1, device-local Home id) readable on its Home', async () => {
        const serverId = await addHome(null);
        const request = ApprovalRequestV1Schema.parse({
            v: 1,
            status: 'open',
            createdAtMs: 1,
            updatedAtMs: 1,
            createdBy: { surface: 'system' },
            actionId: 'session.title.set',
            actionArgs: { sessionId: 'session-1', title: 'Updated title' },
            summary: 'Set session title',
            serverId,
        });
        const artifactId = await storeApproval(
            serverId,
            buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: serverId }),
            request,
        );

        const hook = await renderReader(artifactId, serverId);

        await waitForHomeGovernance(() => expect(hook.getCurrent().artifact?.id).toBe(artifactId));
        expect(hook.getCurrent().error).toBe(false);
    });

    it('fails closed when an exact-Home read returns an approval bound to another portable Home', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, OTHER_IDENTITY);
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);

        const hook = await renderReader(artifactId, serverId);

        await settle(hook, artifactId, (state) => expect(state.invalidArtifact).toBe(true));
        expect(hook.getCurrent().error).toBe(true);
        expect(hook.getCurrent().artifact).toBeNull();
    });

    it.each([
        {
            name: 'is missing',
            header: (request: ReturnType<typeof homeSignedRequest>) => {
                const { serverIdentityId: _omitted, ...header } = buildApprovalRequestArtifactHeaderV1(request);
                return header as ApprovalArtifactHeaderV1;
            },
        },
        {
            name: 'names a different Home than its body',
            header: (request: ReturnType<typeof homeSignedRequest>) => ({
                ...buildApprovalRequestArtifactHeaderV1(request),
                serverIdentityId: OTHER_IDENTITY,
            }),
        },
    ])('fails closed when the V2 header identity $name', async ({ header }) => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, header(request), request);

        const hook = await renderReader(artifactId, HOME_IDENTITY);

        // Classified from a completed read of the Home's row, not merely unread.
        await settle(hook, artifactId, (state) => expect(state.invalidArtifact).toBe(true));
        expect(hook.getCurrent().error).toBe(true);
        expect(hook.getCurrent().artifact).toBeNull();
    });

    it('does not reinterpret an unknown device-local route as V2 Home identity', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);

        const readsBefore = await primeActiveHomeArtifactRow(artifactId);

        const hook = await renderReader(artifactId, 'unknown-local-home');

        expect(hook.getCurrent().homeUnavailable).toBe(true);
        expect(hook.getCurrent().error).toBe(true);
        expect(harness.requestsFor(`/v1/artifacts/${artifactId}`)).toHaveLength(readsBefore);
        expect(hook.getCurrent().artifact).toBeNull();
    });
});
