import { describe, expect, it } from 'vitest';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';

import type { DecryptedArtifact } from './artifactTypes';
import {
    collectOpenApprovalSessionReferences,
    isOpenApprovalInboxArtifact,
    listOpenApprovalInboxArtifactHydrationRequests,
    readOpenApprovalDiscussionAttention,
    readOpenManagedMachineApprovalId,
    listOpenApprovalArtifactsForSession,
    listTranscriptApprovalArtifactsForSession,
    resolveOpenApprovalSessionKeys,
} from './approvalArtifacts';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { buildDiscussionListAttention } from '@/activity/attention/buildDiscussionListAttention';

function artifact(
    id: string,
    header: NonNullable<DecryptedArtifact['header']>,
    body?: unknown,
): Extract<DecryptedArtifact, { isDecrypted: true }> {
    return {
        id,
        header,
        title: header.title ?? null,
        sessions: header.sessions,
        draft: header.draft,
        body: typeof body === 'undefined' ? undefined : JSON.stringify(body),
        headerVersion: 1,
        bodyVersion: typeof body === 'undefined' ? undefined : 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        isDecrypted: true,
    };
}

function approvalBody(sessionId: string, actionId = 'session.list') {
    return {
        v: 1,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId },
        requestedSurface: 'agent',
        actionId,
        actionArgs: {},
        summary: 'List sessions',
    };
}

describe('readOpenManagedMachineApprovalId', () => {
    const deleteBody = (managedId: string, status = 'open') => ({ ...approvalBody('session-1', 'machines.managed.delete'), status,
        summary: 'Delete managed machine',
        actionArgs: { homeId: 'home-1', managedId, when: 'now', expectedRevision: 3, intent: 'delete', reviewedDependencies: true },
        ...(status === 'rejected' ? { decision: { kind: 'reject', decidedAtMs: 2 } } : {}) });
    const stored = (id: string, body: ReturnType<typeof deleteBody>) => artifact(id,
        buildApprovalRequestArtifactHeaderV1(ApprovalRequestV1Schema.parse(body)), body);

    it('finds the open Ask already filed for this managed resource and Action, so the page shows it instead of filing another', () => {
        const artifacts = [stored('other-resource', deleteBody('managed-2')), stored('settled', deleteBody('managed-1', 'rejected')),
            stored('pending', deleteBody('managed-1'))];
        expect(readOpenManagedMachineApprovalId(artifacts, { homeId: 'home-1', managedId: 'managed-1', actionId: 'machines.managed.delete' }))
            .toBe('pending');
        expect(readOpenManagedMachineApprovalId(artifacts, { homeId: 'home-2', managedId: 'managed-1', actionId: 'machines.managed.delete' }))
            .toBeNull();
        expect(readOpenManagedMachineApprovalId(artifacts.slice(0, 2), { homeId: 'home-1', managedId: 'managed-1',
            actionId: 'machines.managed.delete' })).toBeNull();
    });
});

function durableApprovalBody(sessionId: string) {
    return {
        v: 2,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system', sessionId },
        requestedSurface: 'api',
        executionOriginV1: {
            v: 1,
            authority: 'account_automation',
            surface: 'api',
            caller: { kind: 'host' },
            serverId: 'server-a',
            accountId: 'account-1',
            principalId: 'principal-1',
            credentialId: 'credential-1',
            sessionId,
            machineId: 'machine-1',
            target: { kind: 'session', sessionId },
            actionId: 'session.title.set',
            requestId: 'request-1',
        },
        actionId: 'session.title.set',
        actionArgs: { sessionId, title: 'Current title' },
        summary: 'Set session title',
    };
}

describe('listOpenApprovalArtifactsForSession', () => {
    it('distinguishes immutable pending draft-review purpose through the strict private Inbox reader', () => {
        const request = ApprovalRequestV2Schema.parse({
            ...durableApprovalBody('publisher'), actionId: 'discussion.reply',
            actionArgs: { discussionId: 'discussion-a', content: { v: 1, parts: [{ t: 'text', text: 'Private answer' }] },
                replyTarget: { kind: 'message', messageId: 'question' } },
            executionOriginV1: { ...durableApprovalBody('publisher').executionOriginV1, actionId: 'discussion.reply' },
        });
        const reviewed = ApprovalRequestV2Schema.parse({ ...request, discussionDraftReview: true });
        const ordinary = artifact('ordinary', buildApprovalRequestArtifactHeaderV1(request), request);
        const draft = artifact('private-draft', buildApprovalRequestArtifactHeaderV1(reviewed), reviewed);
        const scope = { serverId: 'server-a', accountId: 'account-1' };
        const input = { scope, artifactScope: scope, artifactsLoaded: true, artifacts: [ordinary, draft],
            items: [{ id: 'discussion-a', unreadMentionCount: 1 }] };
        const rows = buildDiscussionListAttention(input);
        expect(rows[0]).toMatchObject({ attentionReason: 'draft_waiting', approvalArtifactIds: [ordinary.id, draft.id] });
        expect(buildDiscussionListAttention(input, rows)).toBe(rows);
        expect(buildDiscussionListAttention({ ...input, artifacts: [ordinary] }, rows)[0])
            .toMatchObject({ attentionReason: 'approval_pending', approvalArtifactIds: [ordinary.id] });
        expect(buildDiscussionListAttention({ ...input, artifacts: [{ ...draft, body: undefined }] }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [] });
        const settled = ApprovalRequestV2Schema.parse({ ...reviewed, status: 'executed', updatedAtMs: 2,
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {} } });
        expect(buildDiscussionListAttention({ ...input,
            artifacts: [artifact(draft.id, buildApprovalRequestArtifactHeaderV1(settled), settled)] }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [] });
        expect(buildDiscussionListAttention({ ...input, artifactScope: { ...scope, accountId: 'other-account' } }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [], approvalAttentionAvailable: false });
        const otherHome = { ...scope, serverId: 'other-home' };
        expect(buildDiscussionListAttention({ ...input, scope: otherHome, artifactScope: otherHome }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [] });
    });

    it('qualifies Discussion approval attention by the strict Action target and captured Home', () => {
        const request = ApprovalRequestV2Schema.parse({
            ...durableApprovalBody('publisher'), actionId: 'discussion.reply',
            actionArgs: { discussionId: 'same-raw-discussion', content: { v: 1, parts: [{ t: 'text', text: 'Private answer' }] },
                replyTarget: { kind: 'message', messageId: 'question' } },
            executionOriginV1: { ...durableApprovalBody('publisher').executionOriginV1, actionId: 'discussion.reply' },
        });
        const open = artifact('reply-approval', buildApprovalRequestArtifactHeaderV1(request), request);
        const target = { serverId: 'server-a', discussionId: 'same-raw-discussion' };
        expect(readOpenApprovalDiscussionAttention(open)).toEqual({ ...target, reason: 'approval_pending' });
        expect(readOpenApprovalDiscussionAttention({ ...open, body: undefined })).toBeNull();
        expect(readOpenApprovalDiscussionAttention({ ...open, header: { ...open.header, title: 'Changed index' } })).toBeNull();
        expect(readOpenApprovalDiscussionAttention({ ...open, draft: true })).toBeNull();
        const scope = { serverId: target.serverId, accountId: 'account-1' };
        const items = [{ id: target.discussionId, unreadMentionCount: 2 }, { id: 'quiet', unreadMentionCount: 0 }];
        const input = { scope, artifactScope: scope, artifactsLoaded: true, artifacts: [open], items };
        const rows = buildDiscussionListAttention(input);
        expect(rows).toMatchObject([{ attentionReason: 'approval_pending', approvalArtifactIds: [open.id] },
            { attentionReason: null, approvalArtifactIds: [] }]);
        expect(buildDiscussionListAttention(input, rows)).toBe(rows);
        const otherHome = { ...scope, serverId: 'other-home' };
        expect(buildDiscussionListAttention({ ...input, scope: otherHome, artifactScope: otherHome }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [] });
        expect(buildDiscussionListAttention({ ...input, items: [{ id: 'other-discussion', unreadMentionCount: 0 }] }, rows)[0])
            .toMatchObject({ attentionReason: null, approvalArtifactIds: [] });
        expect(buildDiscussionListAttention({ ...input, artifacts: [] }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [] });
        expect(buildDiscussionListAttention({ ...input, artifactScope: { ...scope, accountId: 'different-account' } }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [], approvalAttentionAvailable: false });
        expect(buildDiscussionListAttention({ ...input, artifactsLoaded: false }, rows)[0])
            .toMatchObject({ attentionReason: 'mentioned', approvalArtifactIds: [], approvalAttentionAvailable: false });
    });

    it('keeps draft requests out of the canonical Inbox approval predicate', () => {
        const body = approvalBody('s1');
        const header = buildApprovalRequestArtifactHeaderV1(ApprovalRequestV1Schema.parse(body));
        expect(isOpenApprovalInboxArtifact(artifact('open', header, body))).toBe(true);
        expect(isOpenApprovalInboxArtifact(artifact('draft', { ...header, draft: true }, body))).toBe(false);
    });
    it('preserves every open approval when the Inbox uses its predicate as an array callback', () => {
        const body = ApprovalRequestV1Schema.parse(approvalBody('s1'));
        const header = buildApprovalRequestArtifactHeaderV1(body);
        const first = artifact('first', header, body);
        const second = artifact('second', header, body);
        expect([first, second, artifact('draft', { ...header, draft: true }, body)]
            .filter(isOpenApprovalInboxArtifact).map(row => row.id)).toEqual(['first', 'second']);
    });
    it('rejects bodyless approval indexes until the authoritative body is hydrated', () => {
        const approvals = listOpenApprovalArtifactsForSession([
            artifact('matching-session-id', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessionId: 's1',
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }),
            artifact('matching-sessions-array', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessions: ['s1'],
                actionId: 'session.status.get',
                approvalSummary: 'Read status',
            }),
            artifact('closed', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'executed',
                sessionId: 's1',
            }),
            artifact('other-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessionId: 's2',
            }),
        ], { serverId: 'home-a', sessionId: 's1' }, {
            knownSessionAddresses: [{ serverId: 'home-a', sessionId: 's1' }],
        });

        expect(approvals).toEqual([]);
    });
    it('requests each bodyless open Ask for Inbox admission exactly once and ignores settled indexes', () => {
        const open = artifact('managed-delete', {
            v: 1, kind: 'approval_request.v1', title: 'Delete managed machine', approvalStatus: 'open',
            actionId: 'machines.managed.delete', serverIdentityId: 'home-a',
        });
        const duplicate = { ...open };
        const settled = artifact('settled-delete', {
            v: 1, kind: 'approval_request.v1', title: 'Delete managed machine', approvalStatus: 'executed',
            actionId: 'machines.managed.delete', serverIdentityId: 'home-a',
        });
        expect(listOpenApprovalInboxArtifactHydrationRequests([open, duplicate, settled])).toEqual([
            { artifactId: 'managed-delete', serverId: 'home-a' },
        ]);
    });

    it('parses available approval bodies and drops malformed bodies', () => {
        const approvals = listOpenApprovalArtifactsForSession([
            artifact('body', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's1',
                sessions: ['s1'],
                actionId: 'session.history.get',
            }, approvalBody('s1', 'session.history.get')),
            {
                ...artifact('malformed', {
                    v: 1,
                    kind: 'approval_request.v1',
                    title: 'List sessions',
                    approvalStatus: 'open',
                    sessionId: 's1',
                    sessions: ['s1'],
                    actionId: 'session.history.get',
                }),
                body: '{',
            },
        ], { serverId: 'home-a', sessionId: 's1' }, {
            knownSessionAddresses: [{ serverId: 'home-a', sessionId: 's1' }],
        });

        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.artifact.id).toBe('body');
        expect(approvals[0]?.approval.actionId).toBe('session.history.get');
    });

    it('projects current V2 durable approvals into the Session approval surface', () => {
        const request = ApprovalRequestV2Schema.parse(durableApprovalBody('s1'));
        const approvals = listOpenApprovalArtifactsForSession([
            artifact('durable', buildApprovalRequestArtifactHeaderV1(request), request),
        ], buildSessionListServerScopedRowKey('server-a', 's1')!);

        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.approval).toMatchObject({ v: 2, actionId: 'session.title.set' });
    });

    it('links a remote Agent approval by its portable Home identity through hydration and settlement', async () => {
        const serverUrl = 'https://approval-cross-device-home.test';
        const profile = await upsertServerProfile({ serverUrl });
        await setServerProfileIdentityForUrl(serverUrl, 'srv_approval_cross_device');
        const request = ApprovalRequestV2Schema.parse({
            ...durableApprovalBody('same-session'),
            executionOriginV1: { ...durableApprovalBody('same-session').executionOriginV1,
                serverId: 'remote-cli-profile', serverIdentityId: 'srv_approval_cross_device' },
        });
        const header = buildApprovalRequestArtifactHeaderV1(request);
        const head = artifact('remote-approval', header);
        const opened = artifact('remote-approval', header, request);
        const address = { serverId: profile.id, sessionId: 'same-session' };
        const knownSessionAddresses = [address, { serverId: 'other-home', sessionId: address.sessionId }];

        expect([...resolveOpenApprovalSessionKeys(collectOpenApprovalSessionReferences([head]), knownSessionAddresses)])
            .toEqual([buildSessionListServerScopedRowKey(profile.id, address.sessionId)]);
        expect(listOpenApprovalArtifactsForSession([opened], address, { knownSessionAddresses }))
            .toHaveLength(1);
        expect(listOpenApprovalArtifactsForSession([opened], {
            serverId: 'srv_approval_cross_device', sessionId: address.sessionId,
        }, { knownSessionAddresses })).toHaveLength(1);
        expect(listOpenApprovalArtifactsForSession([opened], knownSessionAddresses[1]!, { knownSessionAddresses })).toEqual([]);

        const settled = ApprovalRequestV2Schema.parse({ ...request, status: 'executed', updatedAtMs: 2,
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {} } });
        const completed = artifact('remote-approval', buildApprovalRequestArtifactHeaderV1(settled), settled);
        expect(collectOpenApprovalSessionReferences([completed])).toEqual([]);
        expect(listOpenApprovalArtifactsForSession([completed], address, { knownSessionAddresses })).toEqual([]);
        expect(listTranscriptApprovalArtifactsForSession([completed], address, {
            knownSessionAddresses, settledPresentations: [() => true],
        })).toHaveLength(1);
    });

    it('admits a legacy unscoped approval only when canonical membership resolves one exact Home', () => {
        const legacy = artifact('legacy', {
            v: 1,
            kind: 'approval_request.v1',
            title: 'List sessions',
            approvalStatus: 'open',
            sessionId: 'same',
            sessions: ['same'],
            actionId: 'session.list',
        }, approvalBody('same'));

        expect(collectOpenApprovalSessionReferences([legacy])).toEqual([
            { kind: 'legacy_unscoped', sessionId: 'same' },
        ]);

        expect(listOpenApprovalArtifactsForSession([legacy], { serverId: 'home-a', sessionId: 'same' }, {
            knownSessionAddresses: [{ serverId: 'home-a', sessionId: 'same' }],
        })).toHaveLength(1);
        expect(listOpenApprovalArtifactsForSession([legacy], { serverId: 'home-a', sessionId: 'same' }, {
            knownSessionAddresses: [
                { serverId: 'home-a', sessionId: 'same' },
                { serverId: 'home-b', sessionId: 'same' },
            ],
        })).toEqual([]);
    });
});

describe('collectOpenApprovalSessionReferences', () => {
    it('collects only sessions linked to currently open approval artifacts', () => {
        const references = collectOpenApprovalSessionReferences([
            artifact('header-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's1',
                sessions: ['s1'],
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }, approvalBody('s1')),
            artifact('body-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's2',
                sessions: ['s2'],
                actionId: 'session.list',
            }, approvalBody('s2')),
            artifact('closed', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'rejected',
                sessionId: 's3',
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }),
        ]);

        expect(references).toEqual([
            { kind: 'legacy_unscoped', sessionId: 's1' },
            { kind: 'legacy_unscoped', sessionId: 's2' },
        ]);
    });

    it('uses server-scoped identities when approval artifacts carry a server id', () => {
        const references = collectOpenApprovalSessionReferences([
            artifact('header-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's1',
                sessions: ['s1'],
                serverId: 'server-a',
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }, approvalBody('s1')),
        ]);

        expect(references).toEqual([{
            kind: 'exact',
            address: { serverId: 'server-a', sessionId: 's1' },
        }]);
    });

    it('resolves legacy references once and never broadcasts them across duplicate Homes', () => {
        const references = [{ kind: 'legacy_unscoped', sessionId: 'same' }] as const;
        expect([...resolveOpenApprovalSessionKeys(references, [
            { serverId: 'home-a', sessionId: 'same' },
        ])]).toEqual([buildSessionListServerScopedRowKey('home-a', 'same')]);
        expect([...resolveOpenApprovalSessionKeys(references, [
            { serverId: 'home-a', sessionId: 'same' },
            { serverId: 'home-b', sessionId: 'same' },
        ])]).toEqual([]);
    });
});

describe('listTranscriptApprovalArtifactsForSession', () => {
    const settled = (status: 'rejected' | 'executed') => ApprovalRequestV2Schema.parse({
        ...durableApprovalBody('s1'), status, updatedAtMs: 2,
        decision: { kind: status === 'rejected' ? 'reject' : 'approve', decidedAtMs: 2 },
        ...(status === 'executed' ? { execution: { executedAtMs: 3, ok: true, result: {} } } : {}),
    });
    const target = buildSessionListServerScopedRowKey('server-a', 's1')!;

    it('keeps a settled approval in the transcript only when its body declares a settled presentation', () => {
        const declined = settled('rejected');
        const executed = settled('executed');
        const artifacts = [
            artifact('declined', buildApprovalRequestArtifactHeaderV1(declined), declined),
            artifact('executed', buildApprovalRequestArtifactHeaderV1(executed), executed),
            artifact('open', buildApprovalRequestArtifactHeaderV1(ApprovalRequestV2Schema.parse(durableApprovalBody('s1'))), durableApprovalBody('s1')),
        ];
        const presents = [(approval: { status: string }) => approval.status === 'executed'];

        expect(listTranscriptApprovalArtifactsForSession(artifacts, target, { settledPresentations: presents })
            .map((entry) => entry.artifact.id).sort()).toEqual(['executed', 'open']);
        // Without a declaring body nothing settled is kept, and the open projection is unchanged.
        expect(listTranscriptApprovalArtifactsForSession(artifacts, target).map((entry) => entry.artifact.id)).toEqual(['open']);
        expect(listOpenApprovalArtifactsForSession(artifacts, target).map((entry) => entry.artifact.id)).toEqual(['open']);
    });
});
