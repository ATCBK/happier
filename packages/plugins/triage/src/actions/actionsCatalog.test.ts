import { describe, expect, it } from 'vitest';

import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import {
    TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1,
    TRIAGE_DEFAULT_ACTIONS_V1,
} from '../settings/actions.js';
import {
    TriageAdministerActionInputV1Schema,
    TriageAdministerActionResultV1Schema,
    TriageReadActionsResultV1Schema,
} from './actionsCatalogProtocol.js';
import { administerTriageAction, readTriageActionsForSurface } from './actionsCatalog.js';

/**
 * The two catalog Actions, exercised through their own published schemas.
 *
 * Account KV is the one genuine host boundary replaced; the parser,
 * the bounds, the closed vocabularies and the CAS decision underneath are the
 * real `settings/actions.ts`. Every value here crosses its own wire schema
 * rather than being asserted as a bare object, so a result the transport would
 * reject cannot be recorded as one that answered.
 */

describe('the configured-action Actions', () => {
    it('keeps shipped fallback instructions read-only on the catalog mutation wire', () => {
        const customFallback = {
            v: 1,
            kind: 'create',
            expectedRevision: 'absent',
            label: 'Repair',
            enabled: true,
            appliesTo: ['issue'],
            profileId: null,
            workspaceMode: 'repository',
            target: {
                kind: 'agent',
                promptInvocationId: null,
                seededFallbackInstruction: 'Custom prompt text must live in Prompt Library.',
                delivery: 'send',
            },
        };

        expect(TriageAdministerActionInputV1Schema.safeParse(customFallback).success).toBe(false);
        expect(TriageAdministerActionInputV1Schema.safeParse({
            ...customFallback,
            kind: 'update',
            actionId: 'fix',
        }).success).toBe(false);
    });

    it('answers an absent catalog as the shipped seed rather than as an empty set', async () => {
        const testkit = createTestkitAccountKv();

        const result = TriageReadActionsResultV1Schema.parse(
            await readTriageActionsForSurface({ v: 1 }, { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) }),
        );

        // `absent` and `parsed` are different answers and the surface needs
        // both: absent is showing the seed and the first write stores it.
        expect(result.availability).toBe('absent');
        expect(result.actions.map((action) => action.label))
            .toEqual(['Ask', 'Fix', 'Review', 'Explain this PR in chat']);
        // The runnable Review arm is explicit on the wire, so nothing
        // downstream infers it from a label.
        expect(result.actions[2]?.target)
            .toEqual({
                kind: 'agent',
                promptInvocationId: null,
                seededFallbackInstruction: 'Review this change.',
                delivery: 'compose',
            });
    });

    it('creates against the seed, so a first action does not delete the shipped actions', async () => {
        const testkit = createTestkitAccountKv();

        const input = TriageAdministerActionInputV1Schema.parse({
            v: 1,
            kind: 'create',
            expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            label: 'Explain',
            enabled: true,
            appliesTo: ['errorIssue'],
            profileId: 'profile-7',
            workspaceMode: 'reference_only',
            target: {
                kind: 'agent',
                promptInvocationId: '/explain',
                promptArgsText: '--depth thorough',
                delivery: 'send',
            },
        });
        const applied = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(input, {
            catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            mintActionId: () => 'minted-1',
        }));

        expect(applied.status).toBe('applied');
        expect(applied.actions?.map((action) => action.label))
            .toEqual(['Ask', 'Fix', 'Review', 'Explain this PR in chat', 'Explain']);

        // The seed became stored bytes on that first write, which is also the
        // moment the person first expressed an opinion about it.
        const read = TriageReadActionsResultV1Schema.parse(
            await readTriageActionsForSurface({ v: 1 }, { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) }),
        );
        expect(read.availability).toBe('parsed');
        expect(read.revision).toEqual(testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1));
        expect(read.actions.at(-1)).toEqual({
            actionId: 'minted-1',
            label: 'Explain',
            enabled: true,
            appliesTo: ['errorIssue'],
            profileId: 'profile-7',
            workspaceMode: 'reference_only',
            target: {
                kind: 'agent',
                promptInvocationId: '/explain',
                promptArgsText: '--depth thorough',
                delivery: 'send',
            },
        });
    });

    it('reorders as an exact permutation and refuses anything else', async () => {
        const testkit = createTestkitAccountKv();
        const deps = { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' };

        const reordered = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'reorder',
                expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                actionIds: ['review', 'ask', 'fix', 'explain-pr'],
            }),
            deps,
        ));
        expect(reordered.actions?.map((action) => action.actionId))
            .toEqual(['review', 'ask', 'fix', 'explain-pr']);

        // A shorter list would delete an action under the guise of reordering.
        const dropped = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'reorder',
                expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                actionIds: ['review', 'ask'],
            }),
            deps,
        ));
        expect(dropped).toEqual({ v: 1, status: 'rejected', reason: 'reorder' });
    });

    it('declines to overwrite a catalog this build cannot read', async () => {
        const testkit = createTestkitAccountKv();
        testkit.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 9 });

        const read = TriageReadActionsResultV1Schema.parse(
            await readTriageActionsForSurface({ v: 1 }, { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) }),
        );
        // Not `absent`: reporting it as "you have configured nothing" is exactly
        // what would invite the next ordinary write to destroy it.
        expect(read.availability).toBe('unavailable');

        const refused = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'delete',
                expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                actionId: TRIAGE_DEFAULT_ACTIONS_V1[0]!.actionId,
            }),
            { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' },
        ));
        expect(refused).toEqual({ v: 1, status: 'unreadable' });
        expect(testkit.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toEqual({ v: 9 });
    });

    it('reports the host revision conflict as itself rather than as a failure', async () => {
        const testkit = createTestkitAccountKv();
        // Another device writes between this owner's read and its write.
        testkit.armConcurrentWrite(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 1, actions: [] });

        const result = TriageAdministerActionResultV1Schema.parse(await administerTriageAction(
            TriageAdministerActionInputV1Schema.parse({
                v: 1,
                kind: 'delete',
                expectedRevision: testkit.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                actionId: 'ask',
            }),
            { catalog: testkit.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' },
        ));

        expect(result).toEqual({ v: 1, status: 'conflict' });
    });
});
