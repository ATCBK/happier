import { describe, expect, it } from 'vitest';

import {
    startEntrySession,
    type TriageEntrySessionDepsV1,
} from './entrySessionOrchestrator.js';
import type { TriageSessionActionInvokerV1 } from './entrySessionOpen.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';

/**
 * The Account Collection and generic Session Actions are the two real process
 * boundaries this owner crosses. The canonical Collection testkit keeps link
 * identity, relation queries and persistence real beneath that boundary.
 */
function ownerBoundary() {
    const calls: string[] = [];
    const execute = (async (actionId: string, input: Readonly<{ initialInput?: unknown }>) => {
        calls.push(actionId);
        if (actionId === 'session.spawn_new') {
            return {
                type: 'success',
                disposition: 'created',
                sessionId: 'session-a',
                executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: input.initialInput === undefined
                    ? { status: 'notRequested' }
                    : { status: 'accepted', localId: 'local-a' },
            };
        }
        if (actionId === 'session.message.send') return { status: 'accepted', localId: 'local-a' };
        if (actionId === 'session.open') return null;
        throw new Error(`unexpected generic action: ${actionId}`);
    }) as unknown as TriageSessionActionInvokerV1;
    const { collections } = createTestkitCorpusCollections();
    return {
        calls,
        deps: {
            collections,
            execute,
            nowMs: 1_760_000_900_000,
        } satisfies TriageEntrySessionDepsV1,
    };
}

describe('entry Session final-open ownership', () => {
    it('retains final navigation after linking and delivery when a batch explicitly owns it', async () => {
        const boundary = ownerBoundary();

        const result = await startEntrySession(boundary.deps, {
            entryRef: {
                source: { pluginId: 'happier.example.source', localId: 'example-forge' },
                kindId: 'pull-request',
                collisionScope: 'example/repository',
                entryId: '17',
            },
            display: {
                locator: {
                    v: 1,
                    webUrl: 'https://example.test/example/repository/pull/17',
                    displayPath: 'example/repository #17',
                },
                scopeLabel: 'example/repository',
            },
            workspaceMode: 'reference_only',
            destination: {
                kind: 'new',
                creationKey: 'creation-key-retained-open',
                spawn: {
                    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                    agentTarget: {
                        kind: 'agent',
                        identity: { pluginId: 'happier.claude', localId: 'claude' },
                    },
                },
                materialization: { kind: 'referenceOnly', directory: '/projects/example' },
            },
            delivery: {
                text: 'Repair the failing parser test.',
                attachments: [],
                idempotencyKey: 'delivery-key-a',
            },
            finalOpen: 'deferred',
        });

        expect(result).toEqual({
            type: 'linked',
            sessionId: 'session-a',
            disposition: 'created',
            workspace: { kind: 'referenceOnly' },
            delivery: 'accepted',
            finalOpen: 'deferred',
        });
        expect(boundary.calls).toEqual([
            'session.spawn_new',
            'session.message.send',
        ]);
    });
});
