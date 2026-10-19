import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef, testkitLocator, testkitSnapshot, testkitViewer } from '../corpus/testkit/observations.test-support.js';
import type { PluginClientActionContext } from '@happier-dev/plugin-sdk/actions';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 } from '@happier-dev/triage-protocol/v1';
import { createTriageRunConfiguredActionHandler } from '../actions/configuredActionRun.js';
import { TriageRunConfiguredActionInputV1Schema, TriageRunConfiguredActionResultV1Schema } from '../actions/configuredActionRunProtocol.js';
import { TriageReadActionsResultV1Schema } from '../actions/actionsCatalogProtocol.js';
import type { TriageActionV1 } from '../settings/actions.js';
import { startTriageEntrySession } from '../actions/entrySession.js';
import { TriageStartEntrySessionInputV1Schema } from '../actions/entrySessionProtocol.js';
import { createTestkitActionInvoker, spawnSuccess, testkitConfiguredInstance, TESTKIT_OBSERVED_REVISION } from './testkit/entrySessionTestkit.test-support.js';
import { deriveSessionLinkTag } from '../corpus/identity/tags.js';
import { runTriageConfiguredActionV1, type TriageConfiguredActionRunHostV1 } from './configuredActionRun.js';
import { createTriageBulkEntrySessionsController } from './bulkEntrySessionsController.js';
import { continueTriagePullRequestReviewV1 } from './pullRequestReviewContinuation.js';
import { readTriageActionsForSurface } from '../actions/actionsCatalog.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import { mutateTriageAction, TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../settings/actions.js';
import { parseTriageComposerEntryAttachmentValue } from '../composer/attachmentValue.js';
import { PLUGIN_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol';

const action = {
    actionId: 'custom-fix', label: 'Repair', enabled: true, appliesTo: ['issue'],
    profileId: null, workspaceMode: 'reference_only',
    target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Repair this issue.', delivery: 'send' },
} as const satisfies TriageActionV1;
const catalog = TriageReadActionsResultV1Schema.parse({ v: 1, availability: 'parsed', revision: '1', actions: [action] });
const entry = {
    key: 'issue-1', entryRef: testkitEntryRef(),
    display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
    sourceInstance: { source: testkitEntryRef().source, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
    presentation: { label: 'Repair the issue' }, workflowSubject: 'issue' as const,
};
const settlement = {
    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.example.agent', localId: 'example' } },
    directory: { kind: 'path', path: '/workspaces/example' },
};

describe('configured action execution through the shared Session owner', () => {
    it('explains a pull request through ordinary chat with its canonical context attachment and opens the Session', async () => {
        const kv = createTestkitAccountKv();
        const { collections } = createTestkitCorpusCollections();
        const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess()] });
        const host = {
            version: () => ({ methods: [] }),
            executeAction: async (id: string, input: JsonValue) => {
                if (id === 'actions/read-v1') return TriageReadActionsResultV1Schema.parse(await readTriageActionsForSurface(
                    { v: 1 }, { catalog: kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) },
                ));
                if (id === 'projects.list') return { items: [], truncated: false };
                if (id === 'sessions/start-entry-v1') return startTriageEntrySession(
                    TriageStartEntrySessionInputV1Schema.parse(input), { collections, execute: invoker.execute, nowMs: () => 1 },
                );
                throw new Error(`unexpected Action ${id}`);
            },
        } as unknown as TriageConfiguredActionRunHostV1; // Host RPC and persistent Account storage boundaries.
        const pullRequest = { ...entry, key: 'pull-request-17',
            entryRef: testkitEntryRef({ kindId: 'pull-request', entryId: '17' }),
            presentation: { label: testkitSnapshot().title }, workflowSubject: 'pullRequest' as const };
        const request = { actionId: 'explain-pr', destination: 'single' as const,
            entries: [pullRequest], settlements: [settlement] };
        const result = TriageRunConfiguredActionResultV1Schema.parse(await runTriageConfiguredActionV1(host, request));
        expect(result).toMatchObject({ status: 'single', result: { type: 'opened', sessionId: 'session-a', delivery: 'accepted' } });
        const sent = PLUGIN_ACTION_INPUT_SCHEMAS['session.message.send'].parse(invoker.callsFor('session.message.send')[0]?.input);
        expect(sent).toMatchObject({ sessionId: 'session-a', message: expect.stringMatching(/explain/i) });
        expect('recipient' in sent && sent.recipient != null).toBe(false);
        expect('attachments' in sent && sent.attachments).toHaveLength(1);
        const attachment = 'attachments' in sent ? sent.attachments?.[0] : undefined;
        const authored = attachment?.value;
        expect(authored).toMatchObject({ presentation: { label: testkitSnapshot().title } });
        const value = authored !== null && typeof authored === 'object' && 'value' in authored ? authored.value : undefined;
        expect(parseTriageComposerEntryAttachmentValue(value)).toMatchObject({
            status: 'valid', value: { entryRef: pullRequest.entryRef, sourceInstance: pullRequest.sourceInstance },
        });
        expect(invoker.callsFor('session.open')[0]?.input).toEqual({ sessionId: 'session-a' });
        expect(kv.setCallCount()).toBe(0);
        const inapplicable = await runTriageConfiguredActionV1(host, { ...request, entries: [entry] });
        expect(inapplicable).toMatchObject({ status: 'unavailable', reason: 'actionInapplicable' });
    });
    it.each(['single', 'oneSessionPerEntry'] as const)('retains unknown dispatch custody for $0 without repeating successful bulk units', async (destination) => {
        const { collections } = createTestkitCorpusCollections();
        const invoker = createTestkitActionInvoker({ spawn: [
            spawnSuccess({ sessionId: 'session-a' }),
            spawnSuccess({ sessionId: destination === 'single' ? 'session-a' : 'session-b',
                disposition: destination === 'single' ? 'rejoined' : 'created' }),
            spawnSuccess({ sessionId: 'session-b', disposition: 'rejoined' }),
        ] });
        const emitted: ReturnType<typeof TriageStartEntrySessionInputV1Schema.parse>[] = [];
        let loseReply = true;
        const host = {
            version: () => ({ methods: [] }),
            executeAction: async (id: string, input: JsonValue) => {
                if (id === 'actions/read-v1') return catalog;
                if (id === 'projects.list') return { items: [], truncated: false };
                if (id === 'sessions/start-entry-v1') {
                    const start = TriageStartEntrySessionInputV1Schema.parse(input);
                    emitted.push(start);
                    const result = await startTriageEntrySession(start, { collections, execute: invoker.execute, nowMs: () => 1 });
                    if (loseReply && (destination === 'single' || emitted.length === 2)) {
                        loseReply = false;
                        throw new Error('host reply lost after dispatch');
                    }
                    return result;
                }
                if (id === 'session.open') return null;
                throw new Error(`unexpected Action ${id}`);
            },
        } as unknown as TriageConfiguredActionRunHostV1; // Host RPC and persistent Collection boundaries only.
        const entries = destination === 'single' ? [entry] : [entry,
            { ...entry, key: 'issue-2', entryRef: { ...entry.entryRef, entryId: '2' } }];
        const request = { actionId: action.actionId, destination, entries, settlements: entries.map(() => settlement) };
        const first = TriageRunConfiguredActionResultV1Schema.parse(await runTriageConfiguredActionV1(host, request));
        expect(first.recovery).toBeDefined();
        const resume = TriageRunConfiguredActionInputV1Schema.parse({ v: 1, actionId: action.actionId, destination,
            entries: entries.map((selected) => ({ entryRef: selected.entryRef, sourceInstanceId: selected.sourceInstance.sourceInstanceId })),
            resumeStart: JSON.parse(JSON.stringify(first.recovery)),
        });
        const resumed = await runTriageConfiguredActionV1(host, { ...request, settlements: [], resumeStart: resume.resumeStart,
            // Reobservation can update presentation, but a repeated delivery
            // must keep the payload originally emitted under its identity.
            entries: entries.map((selected) => ({ ...selected, presentation: { label: 'Updated source title' },
                display: { ...selected.display, scopeLabel: 'Updated source scope' } })),
        });
        expect(resumed.status).toBe(destination === 'single' ? 'single' : 'bulk');
        expect(resumed.recovery).toBeUndefined();
        expect(emitted).toHaveLength(destination === 'single' ? 2 : 3);
        expect(emitted.at(-1)).toEqual(emitted[destination === 'single' ? 0 : 1]);
        const mismatched = await runTriageConfiguredActionV1(host, { ...request,
            entries: [{ ...entry, entryRef: { ...entry.entryRef, entryId: 'different' } }], resumeStart: resume.resumeStart });
        expect(mismatched).toMatchObject({ status: 'unavailable', reason: 'startContinuationMismatch' });
        expect(emitted).toHaveLength(destination === 'single' ? 2 : 3);
    });

    it.each(['enabled', 'deleted', 'deletedUnknown'] as const)('cancels after an emitted bulk start without discarding receipts (%s)', async (mode) => {
        const abort = new AbortController();
        const emitted: JsonValue[] = [];
        const kv = createTestkitAccountKv();
        const host = {
            version: () => ({ methods: [] }),
            executeAction: async (id: string, input: JsonValue) => {
                if (id === 'actions/read-v1') return readTriageActionsForSurface(
                    { v: 1 }, { catalog: kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) },
                );
                if (id === 'projects.list') return { items: [], truncated: false };
                if (id === 'sessions/start-entry-v1') {
                    emitted.push(input);
                    if (emitted.length === 1) abort.abort();
                    if (mode === 'deletedUnknown') throw new Error('host reply lost after dispatch');
                    return { v: 1, type: 'linked', sessionId: `session-${emitted.length}`, disposition: 'created',
                        delivery: 'accepted', finalOpen: 'suppressed' };
                }
                throw new Error(`unexpected Action ${id}`);
            },
        } as unknown as TriageConfiguredActionRunHostV1; // Host RPC boundary, including cancellation after dispatch.
        const request = { actionId: 'fix', destination: 'oneSessionPerEntry' as const, settlements: [settlement, settlement],
            entries: [entry, { ...entry, key: 'issue-2', entryRef: { ...entry.entryRef, entryId: '2' } }] };
        const first = TriageRunConfiguredActionResultV1Schema.parse(await runTriageConfiguredActionV1(host, request, { signal: abort.signal }));
        expect(first.results?.map((result) => result.status)).toEqual([mode === 'deletedUnknown' ? 'unknownOutcome' : 'settled', 'notStarted']);
        expect(first.recovery).toBeDefined();
        if (mode !== 'enabled') {
            expect(await mutateTriageAction({ catalog: kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' }, {
                kind: 'delete', actionId: 'fix', expectedRevision: kv.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
            })).toMatchObject({ status: 'applied', value: { actions: expect.arrayContaining([expect.objectContaining({ actionId: 'fix', enabled: false })]) } });
            // The mounted UI retry reaches this same controller directly.
            const mountedOwner = createTriageBulkEntrySessionsController(host);
            try {
                expect(first.recovery?.state.kind).toBe('bulk');
                if (first.recovery?.state.kind !== 'bulk') throw new Error('bulk recovery required');
                expect(mountedOwner.restore(first.recovery.state, request.entries)).toBe(true);
                mountedOwner.getSnapshot().retry();
                const snapshot = await mountedOwner.waitForSettled();
                expect(emitted).toHaveLength(1);
                expect(snapshot.phase.kind).toBe('settled');
                expect(mountedOwner.getRecovery()).toEqual(first.recovery.state);
            } finally { mountedOwner.dispose(); }
        }
        const resumed = TriageRunConfiguredActionResultV1Schema.parse(await runTriageConfiguredActionV1(host, {
            ...request, resumeStart: first.recovery,
        }));
        if (mode !== 'enabled') {
            expect(resumed).toMatchObject({ status: 'unavailable', reason: 'actionInapplicable' });
            expect(emitted).toHaveLength(1);
            expect(resumed.results).toEqual(first.results);
            expect(resumed.recovery).toEqual(first.recovery);
            return;
        }
        expect(resumed.results?.map((result) => result.status)).toEqual(['settled', 'settled']);
        expect(emitted).toHaveLength(2);
        expect(resumed.results?.[0]).toEqual(first.results?.[0]);
        expect(resumed.results?.[1]?.creationKey).toBe(first.results?.[1]?.creationKey);
    });

    it('forwards single-start cancellation and keeps the emitted identity when its reply is lost', async () => {
        const abort = new AbortController();
        let startSignal: AbortSignal | undefined;
        const host = {
            version: () => ({ methods: [] }),
            executeAction: async (id: string, _input: JsonValue, options?: { signal?: AbortSignal }) => {
                if (id === 'actions/read-v1') return catalog;
                if (id === 'projects.list') return { items: [], truncated: false };
                if (id === 'sessions/start-entry-v1') {
                    startSignal = options?.signal;
                    abort.abort();
                    throw new Error('cancelled after dispatch');
                }
                throw new Error(`unexpected Action ${id}`);
            },
        } as unknown as TriageConfiguredActionRunHostV1; // Host RPC boundary and externally owned cancellation.
        const result = await runTriageConfiguredActionV1(host, {
            actionId: action.actionId, destination: 'single', entries: [entry], settlements: [settlement],
        }, { signal: abort.signal });
        expect(startSignal).toBe(abort.signal);
        expect(result).toMatchObject({ status: 'cancelled', recovery: { state: { kind: 'single' } } });
    });

    it.each([false, true, 'partial', 'disabled', 'disabledWhileChoosing'] as const)('does not report prepared formal Review as complete (explicit engines: %s)', async (hasChoices) => {
        const reviewAction = { ...action, actionId: 'fix', appliesTo: ['pullRequest'], workspaceMode: 'pull_request',
            target: { kind: 'reviewStart', promptInvocationId: null, seededFallbackInstruction: 'Review this pull request.' },
        } as const satisfies TriageActionV1;
        const kv = createTestkitAccountKv();
        kv.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 1, actions: [{ ...reviewAction, appliesTo: [...reviewAction.appliesTo] }] });
        const disabledContinuation = hasChoices === 'disabled' || hasChoices === 'disabledWhileChoosing';
        const launchImmediately = hasChoices !== false && !disabledContinuation;
        const events: string[] = [];
        const engineIds = hasChoices === 'partial' ? ['engine-a', 'engine-b'] : ['engine-a'];
        const failedEngineIds = hasChoices === 'partial' ? ['engine-b'] : [];
        const instance = testkitConfiguredInstance();
        const review = { instance, entryRef: entry.entryRef, lastKnownLocator: testkitLocator(), observed: TESTKIT_OBSERVED_REVISION,
            workspace: { serverId: 'server-a', machineId: 'machine-a', rootPath: settlement.directory.path },
            repositoryPath: settlement.directory.path, pullRequest: { number: 17 } };
        const operation = { point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol: {
            id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        } }, contributor: { pluginId: entry.entryRef.source.pluginId, contributionId: entry.entryRef.source.localId,
            occurrenceId: 'source-1', sourceCustody: { kind: 'development', registeredRootId: 'source-root' } },
            role: 'prepareReviewWorkspace', action: { pluginId: entry.entryRef.source.pluginId, localId: 'prepare' } } as const;
        const host = {
            version: () => ({ methods: [] }),
            selectActionInput: async (request: { draft: JsonValue; hostAction?: unknown }) => {
                if (request.hostAction !== undefined && hasChoices === 'disabledWhileChoosing') {
                    expect(await mutateTriageAction({ catalog: kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' }, {
                        kind: 'delete', actionId: 'fix', expectedRevision: kv.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                    })).toMatchObject({ status: 'applied' });
                    return { kind: 'executionRunLaunch', input: {} };
                }
                return { kind: 'submitted', action: operation.action, input: request.draft,
                selection: { target: { pluginId: 'happier.triage', sourceCustody: { kind: 'development', registeredRootId: 'target-root' } },
                    point: operation.point, contributor: { pluginId: operation.contributor.pluginId,
                        contributionId: operation.contributor.contributionId, sourceCustody: operation.contributor.sourceCustody } },
                connectedAccount: { kind: 'selected', fieldPath: 'instance.binding.account', ref: instance.binding.account },
                presentation: { connectedAccountLabel: 'Example account', machineDisplayName: 'Example machine' } };
            },
            executeAction: async (id: string, input: JsonValue) => {
                events.push(id);
                if (id === 'actions/read-v1') return readTriageActionsForSurface(
                    { v: 1 }, { catalog: kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) },
                );
                if (id === 'projects.list') return { items: [], truncated: false };
                if (id === 'sessions/start-entry-v1') return { v: 1, type: 'linked', sessionId: 'session-a', disposition: 'created',
                    delivery: 'none', finalOpen: 'deferred', review };
                if (id === 'sessions/start-pull-request-review-v1') {
                    expect(input).toMatchObject({ sessionId: 'session-a', engineIds,
                        instructions: reviewAction.target.seededFallbackInstruction, review });
                    return { v: 1, status: 'started', startedEngineIds: ['engine-a'], failedEngineIds };
                }
                if (id === 'session.open') return null;
                throw new Error(`unexpected Action ${id}`);
            },
        } as unknown as TriageConfiguredActionRunHostV1; // Exact daemon RPC and host selection boundaries.
        const request = { actionId: reviewAction.actionId, destination: 'single' as const, settlements: [settlement],
            entries: [{ ...entry, workflowSubject: 'pullRequest' as const, reviewWorkspace: {
                operation, preparation: { instance, entryRef: entry.entryRef, lastKnownLocator: testkitLocator(), observed: TESTKIT_OBSERVED_REVISION },
            } }], ...(launchImmediately ? { reviewChoices: { engineIds, launchSelection: {} } } : {}),
        };
        const result = await runTriageConfiguredActionV1(host, request);
        expect(result).toMatchObject({ status: hasChoices === 'partial' ? 'reviewPartial' : launchImmediately ? 'reviewStarted' : 'awaitingReview' });
        expect(events.includes('sessions/start-pull-request-review-v1')).toBe(launchImmediately);
        if (launchImmediately) expect(result.reviewResult).toMatchObject({ startedEngineIds: ['engine-a'], failedEngineIds });
        if (hasChoices === 'partial') expect(events).not.toContain('session.open');
        if (disabledContinuation) {
            if (hasChoices === 'disabled') {
                expect(await mutateTriageAction({ catalog: kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'unused' }, {
                    kind: 'delete', actionId: 'fix', expectedRevision: kv.revision(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                })).toMatchObject({ status: 'applied' });
            }
            // The mounted chooser and its failed-engine retry share this continuation.
            expect(await continueTriagePullRequestReviewV1(host, {
                actionId: reviewAction.actionId, sessionId: 'session-a', review, instructions: result.reviewInstructions!,
            }, { engineIds, ...(hasChoices === 'disabled' ? { launchSelection: {} } : {}) })).toEqual({ kind: 'unavailable' });
            expect(events).not.toContain('sessions/start-pull-request-review-v1');
            const resumed = TriageRunConfiguredActionResultV1Schema.parse(await runTriageConfiguredActionV1(host, {
                ...request, resumeReview: { result: result.result!, instructions: result.reviewInstructions! },
                reviewChoices: { engineIds, launchSelection: {} },
            }));
            expect(resumed).toMatchObject({ status: 'unavailable', reason: 'actionInapplicable' });
            expect(resumed.result).toEqual(result.result);
            expect(resumed.reviewInstructions).toEqual(result.reviewInstructions);
            expect(events.filter((id) => id === 'sessions/start-entry-v1')).toHaveLength(1);
            expect(events).not.toContain('sessions/start-pull-request-review-v1');
            return;
        }
        if (hasChoices === false || hasChoices === 'partial') {
            const startsBefore = events.filter((event) => event === 'sessions/start-entry-v1').length;
            const resumed = await createTriageRunConfiguredActionHandler()(TriageRunConfiguredActionInputV1Schema.parse({
                v: 1, actionId: request.actionId, destination: 'single', entries: [{ entryRef: entry.entryRef,
                    sourceInstanceId: entry.sourceInstance.sourceInstanceId }],
                resumeReview: { result: result.result!, instructions: result.reviewInstructions! },
                reviewChoices: { engineIds, launchSelection: {} },
            }), { signal: new AbortController().signal, ui: { ...host,
                context: async () => ({ targetedContributions: null }),
            } } as unknown as PluginClientActionContext); // Host RPC boundary; final Review keeps source verification.
            expect(resumed.status).toBe(hasChoices === 'partial' ? 'reviewPartial' : 'reviewStarted');
            expect(events.filter((event) => event === 'sessions/start-entry-v1')).toHaveLength(startsBefore);
            const mismatched = await runTriageConfiguredActionV1(host, {
                ...request,
                entries: [{ ...request.entries[0]!, entryRef: { ...entry.entryRef, entryId: 'different' } }],
                resumeReview: { result: result.result!, instructions: result.reviewInstructions! },
                reviewChoices: { engineIds, launchSelection: {} },
            });
            expect(mismatched).toMatchObject({ status: 'unavailable', reason: 'reviewContinuationMismatch' });
            expect(events.filter((event) => event === 'sessions/start-entry-v1')).toHaveLength(startsBefore);
        }
    });

    it('does not read configuration when its caller has already cancelled', async () => {
        const abort = new AbortController();
        abort.abort();
        const executeAction = vi.fn(async () => catalog);
        const result = await runTriageConfiguredActionV1({ executeAction } as unknown as TriageConfiguredActionRunHostV1, {
            actionId: action.actionId, destination: 'single', entries: [entry],
        }, { signal: abort.signal });
        expect(result).toEqual({ v: 1, status: 'cancelled' });
        expect(executeAction).not.toHaveBeenCalled();
    });

    it.each(['beforeContext', 'duringContext'] as const)('propagates cancellation $0', async (phase) => {
        const abort = new AbortController();
        if (phase === 'beforeContext') abort.abort();
        const readContext = vi.fn(async () => { abort.abort(); return { targetedContributions: null }; });
        const executeAction = vi.fn();
        const result = await createTriageRunConfiguredActionHandler()(TriageRunConfiguredActionInputV1Schema.parse({
            v: 1, actionId: action.actionId, destination: 'single', entries: [{
                entryRef: entry.entryRef, sourceInstanceId: entry.sourceInstance.sourceInstanceId,
            }],
        }), { signal: abort.signal, ui: { context: readContext, executeAction } } as unknown as PluginClientActionContext);
        expect(result).toEqual({ v: 1, status: 'cancelled' });
        if (phase === 'beforeContext') expect(readContext).not.toHaveBeenCalled();
        expect(executeAction).not.toHaveBeenCalled();
    });

    it.each([
        { surface: 'agent', destination: 'single', missingMiddle: false },
        { surface: 'mcp', destination: 'single', missingMiddle: false },
        { surface: 'agent', destination: 'oneSessionPerEntry', missingMiddle: false },
        { surface: 'agent', destination: 'oneSessionForAllEntries', missingMiddle: false },
        { surface: 'agent', destination: 'oneSessionPerEntry', missingMiddle: true },
    ] as const)(
        '$surface runs $destination (missing middle: $missingMiddle) using configured instructions and durable links', async ({ surface, destination, missingMiddle }) => {
            const { collections, control } = createTestkitCorpusCollections();
            const invoker = createTestkitActionInvoker({ spawn: [spawnSuccess({ sessionId: 'session-a' }),
                spawnSuccess({ sessionId: destination === 'oneSessionPerEntry' ? 'session-b' : 'session-a',
                    disposition: destination === 'oneSessionPerEntry' ? 'created' : 'rejoined' }),
                spawnSuccess({ sessionId: 'session-b', disposition: 'rejoined' })] });
            const emitted: ReturnType<typeof TriageStartEntrySessionInputV1Schema.parse>[] = [];
            let loseReply = !missingMiddle;
            let providerUnavailable = false;
            const host = {
                version: () => ({ methods: [] }),
                executeAction: async (id: string, input: JsonValue) => {
                    if (providerUnavailable && id === 'entries/reobserve-v1') return { kind: 'unavailable' };
                    if (id === 'actions/read-v1') return catalog;
                    if (id === 'projects.list') return { items: [], truncated: false };
                    if (id === 'entries/reobserve-v1' && missingMiddle && (input as Readonly<{ entryRef: { entryId: string } }>).entryRef.entryId === '2') return { kind: 'unavailable' };
                    if (id === 'entries/reobserve-v1') return {
                        kind: 'observed', entryRef: (input as Readonly<{ entryRef: JsonValue }>).entryRef,
                        observation: { sourceInstanceId: entry.sourceInstance.sourceInstanceId, observedAtMs: 1,
                            outcome: { kind: 'present', locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer() } },
                    };
                    if (id === 'entries/read-detail-v1') return { kind: 'read', instance: testkitConfiguredInstance(), linkedSessions: [] };
                    if (id === 'sessions/start-entry-v1') {
                        const start = TriageStartEntrySessionInputV1Schema.parse(input);
                        emitted.push(start);
                        const result = await startTriageEntrySession(start, { collections, execute: invoker.execute, nowMs: () => 1 });
                        if (loseReply && (destination !== 'oneSessionPerEntry' || emitted.length === 2)) {
                            loseReply = false; throw new Error('host reply lost after dispatch');
                        }
                        return result;
                    }
                    if (id === 'session.open') return null;
                    throw new Error(`unexpected Action ${id}`);
                },
            } as unknown as TriageConfiguredActionRunHostV1; // Host RPC boundary; no chooser is installed.
            const entries = destination === 'single' ? [entry] : [entry,
                { ...entry, key: 'issue-2', entryRef: { ...entry.entryRef, entryId: '2' } },
                ...(missingMiddle ? [{ ...entry, key: 'issue-3', entryRef: { ...entry.entryRef, entryId: '3' } }] : []),
            ];
            const availableEntries = entries.filter((selected) => !missingMiddle || selected.entryRef.entryId !== '2');
            const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
            const clientContext = {
                plugin: { id: 'happier.triage', version: '1.0.0' },
                contribution: { id: 'sessions/run-configured-v1', qualifiedId: 'happier.triage/actions/sessions/run-configured-v1' },
                invocationSurface: surface, signal: new AbortController().signal, ephemeralSharedScope: null,
                ui: { ...host, context: async () => ({ targetedContributions: providerUnavailable ? null : {
                    target: { pluginId: 'happier.triage', immutableGenerationId: 'target-1' },
                    points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol, contributions: [{
                        contributor: { pluginId: entry.entryRef.source.pluginId, contributionId: entry.entryRef.source.localId, immutableGenerationId: 'source-1' },
                        protocol, descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example source',
                            kinds: [{ id: entry.entryRef.kindId, displayName: 'Issue', workflowSubject: 'issue' }] },
                        operations: [], surfaces: [],
                    }] }] }],
                } }) },
            } as unknown as PluginClientActionContext; // Client RPC boundary with target-owned admitted source facts.
            const configuredInput = TriageRunConfiguredActionInputV1Schema.parse({
                v: 1, actionId: action.actionId, entries: entries.map((selected) => ({
                    entryRef: selected.entryRef, sourceInstanceId: selected.sourceInstance.sourceInstanceId,
                })), destination, drafts: entries.map((_, index) => ({ ...settlement, directory: { kind: 'path', path: `${settlement.directory.path}-${index}` } })),
            });
            const handler = createTriageRunConfiguredActionHandler();
            let result = await handler(configuredInput, clientContext);
            if (!missingMiddle) {
                expect(result).toMatchObject(destination === 'single'
                    ? { status: 'unavailable', reason: 'startOutcomeUnknown' } : { status: 'bulk' });
                expect(result.recovery).toBeDefined();
                const { drafts: _initialDrafts, ...continuationInput } = configuredInput;
                providerUnavailable = true;
                result = await handler(TriageRunConfiguredActionInputV1Schema.parse({
                    ...continuationInput, resumeStart: JSON.parse(JSON.stringify(result.recovery)),
                }), clientContext);
                expect(emitted.at(-1)).toEqual(emitted[destination === 'oneSessionPerEntry' ? 1 : 0]);
            }
            expect(result).toMatchObject({ v: 1, status: destination === 'single' ? 'single' : 'bulk' });
            for (const [index, selected] of availableEntries.entries()) {
                const tag = await deriveSessionLinkTag(collections.sessionLinks, selected.entryRef,
                    destination === 'oneSessionForAllEntries' || index === 0 ? 'session-a' : 'session-b');
                expect(control.sessionLinks.inspect(tag)).toMatchObject({ deleted: false });
            }
            const sends = invoker.callsFor('session.message.send');
            expect(sends).toHaveLength(destination === 'single' ? 2 : destination === 'oneSessionForAllEntries'
                ? 2 : availableEntries.length + (missingMiddle ? 0 : 1));
            expect(sends[0]?.input).toMatchObject({ message: action.target.seededFallbackInstruction });
            if (missingMiddle) {
                expect(invoker.callsFor('session.spawn_new').map((call) => call.input)).toMatchObject([
                    { directory: { kind: 'path', path: `${settlement.directory.path}-0` } },
                    { directory: { kind: 'path', path: `${settlement.directory.path}-2` } },
                ]);
            }
        },
    );
});
