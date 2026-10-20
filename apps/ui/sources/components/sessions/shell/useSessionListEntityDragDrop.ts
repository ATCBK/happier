import type { ActionId } from '@happier-dev/protocol';
import type {
    EntityDragItemV1,
    EntityDragScopeV1,
    EntityDropAdmissionV1,
    EntityDropEffectV1,
    EntityDropOutcomeV1,
    PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';

import {
    createEntityDragGestureAdapter,
    useEntityDragDropRuntime,
    type EntityDragDropRuntime,
    type EntityDropResolveContext,
    type TreeDropVisualGeometry,
    type TreeInstructionVisual,
    type WindowBounds,
    type WindowPointer,
} from '@/components/ui/treeDragDrop';
import { projectActionOutcome } from './dropPreview/sessionListActionOutcome';
export { projectActionOutcome } from './dropPreview/sessionListActionOutcome';
import { resolvePutUnderEligibility } from '@/components/sessions/work/putUnderCandidates';
import { selectSessionRelationRecords } from '@/components/sessions/work/reportSubtree';
import { getStorage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
    loadSessionManagerEligibility,
    type SessionManagerEligibilitySnapshot,
} from '@/sync/ops/relations/sessionManagerEligibility';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import type { SessionOrganizationMutationScope } from '@/sync/ops/sessionOrganization';
import { t } from '@/text';
import { parseToken } from '@/utils/auth/parseToken';
import { getSessionCarriedLine, getSessionName } from '@/utils/sessions/sessionUtils';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { AgentIcon } from '@/agents/registry/AgentIcon';

import { resolveSessionListDragTree, type CommitSessionListDragIntentContext, type SessionListDragAdmission } from './drag/commitSessionListDragIntent';
import type { SessionListDragIntent, SessionListDragSnapshot } from './drag/_types';
import { listSessionListEntityDropDestinations, readSessionListFolderAssignmentDestination, resolveSessionListFolderAssignmentDrop, resolveSessionListEntityDrop } from './drag/resolveSessionListEntityDrop';
import {
    createSessionListOrganizationActionAdapter,
    registerMountedSessionListOrganizationAction,
} from './drag/sessionListOrganizationAction';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListDragSnapshot } from './drag/sessionListDragSnapshot';
import { treeRowId } from './drop-resolution/treeRowId';
import { buildSessionListDragIntent } from './drag/sessionListDragIntent';
import type { SessionListTreeRowMetadata } from './drop-resolution/sessionListTreeTypes';
import {
    describeSessionListDropPreview,
    describeSessionListDropReason,
    describeSessionListRefusedPutUnder,
    SESSION_LIST_NO_TARGET_CODE,
} from './dropPreview/sessionListDropPresentation';
import type { UseSessionInlineDragResolvedDrop } from './useSessionInlineDrag';

/**
 * The Session list's binding to the ONE entity drag owner (`components/ui/treeDragDrop`).
 *
 * The list is one mounted drop target for the active Home: its pointer geometry (tree thirds and
 * container zones) selects a semantic intent, the Session domain resolver admits it, and the owner's
 * canonical Actions (`session.manager.set`, `session.organization.move`) execute it. A row carry
 * is a source the list registers for exactly as long as it is carried. Feedback leaves read the
 * owner's snapshot; only refusal-free targets draw a line or outline.
 */

export type SessionListBaseCommitContext = Omit<CommitSessionListDragIntentContext, 'scope' | 'resolvePutSessionUnder'>;

export type UseSessionListEntityDragDropInput = Readonly<{
    /** The list's pointer geometry strategy (tree thirds, container zones) for the current snapshot. */
    resolvePointerGeometry: (pointer: WindowPointer | null) => UseSessionInlineDragResolvedDrop;
    getCommitContext: (mutationScope?: SessionOrganizationMutationScope) => SessionListBaseCommitContext;
    getListBounds: () => WindowBounds | null;
    getSourceBounds?: (rowId: string) => WindowBounds | null;
    resolveKeyboardGeometry?: (visual: TreeInstructionVisual) => TreeDropVisualGeometry;
    onKeyboardGeometry?: (geometry: TreeDropVisualGeometry) => void;
    onCarryRetired?: () => void;
}>;

export type SessionListCarry = Readonly<{
    sourceId: string;
    move: (pointer: WindowPointer | null) => TreeDropVisualGeometry;
    /** Keyboard/chooser: stage a semantic destination (the same intent pointer geometry produces). */
    choose: (destination: SessionListDragIntent) => void;
    end: (success: boolean, pointer: WindowPointer | null) => Promise<void>;
    cancel: () => void;
}>;

const NO_GEOMETRY: TreeDropVisualGeometry = Object.freeze({ kind: 'none' });
const ACCEPTED_KINDS = Object.freeze(['session', 'session-folder', 'session-workspace'] as const);

function sessionsRecord(serverId: string | null): Readonly<Record<string, Session>> {
    const state = getStorage().getState();
    return selectSessionRelationRecords(state.sessions, serverId, state.sessionListRowsByServerId);
}

function rowName(metadata: SessionListTreeRowMetadata | undefined): string {
    if (!metadata) return '';
    if (metadata.kind === 'session' && metadata.sessionId) {
        const session = sessionsRecord(metadata.serverId)[metadata.sessionId];
        return session ? getSessionName(session, metadata.serverId) : metadata.sessionId;
    }
    const item = metadata.item;
    return item.type === 'header' ? item.title : '';
}

function itemForSnapshot(snapshot: SessionListDragSnapshot, scope: EntityDragScopeV1): EntityDragItemV1 | null {
    const metadata = snapshot.source.treeSource.metadata as SessionListTreeRowMetadata;
    if (metadata.serverId && metadata.serverId !== scope.serverId) return null;
    if (metadata.kind === 'session' && metadata.sessionId && metadata.serverId) {
        return { kind: 'session', scope, address: { serverId: metadata.serverId, sessionId: metadata.sessionId } };
    }
    if (metadata.kind === 'folder' && metadata.folderId) return { kind: 'session-folder', scope, folderId: metadata.folderId };
    if (metadata.kind === 'workspace-root') {
        try {
            const tuple = JSON.parse(metadata.rowId) as unknown[];
            const workspaceId = typeof tuple[1] === 'string' ? tuple[1] : '';
            return workspaceId ? { kind: 'session-workspace', scope, workspaceId } : null;
        } catch {
            return null;
        }
    }
    return null;
}

/** Keyboard and chooser destinations carry the same semantic intent the pointer geometry produces. */
export function readSessionListDestinationIntent(destination: PluginUiJsonValueV1 | null | undefined, scope: EntityDragScopeV1): SessionListDragIntent | null {
    if (!destination || typeof destination !== 'object' || Array.isArray(destination)) return null;
    const value = destination as Readonly<Record<string, unknown>>;
    if (typeof value.sourceRowId !== 'string' || typeof value.instructionKind !== 'string') return null;
    const text = (key: string) => (typeof value[key] === 'string' ? value[key] as string : null);
    const blockedReason = text('blockedReason');
    return {
        scope,
        sourceRowId: value.sourceRowId,
        sourceKind: value.sourceKind as SessionListDragIntent['sourceKind'],
        instructionKind: value.instructionKind as SessionListDragIntent['instructionKind'],
        ...(value.instructionKind === 'blocked' && blockedReason ? { blockedReason } : {}),
        targetRowId: text('targetRowId'),
        containerId: text('containerId'),
        parentRowId: text('parentRowId'),
        depth: typeof value.depth === 'number' ? value.depth : null,
        edge: value.edge === 'top' || value.edge === 'bottom' ? value.edge : null,
        sourceSnapshotSignature: `keyboard:${value.sourceRowId}`,
    };
}

function previewForFolderAssignment(folderName: string | null) {
    return folderName === null ? describeSessionListDropPreview({ kind: 'top-level' })
        : describeSessionListDropPreview({ kind: 'folder', folderName });
}

function previewForDestination(intent: Pick<SessionListDragIntent, 'instructionKind'>, target: SessionListTreeRowMetadata | null) {
    if (intent.instructionKind === 'nest-into') {
        return target?.kind === 'session'
            ? describeSessionListDropPreview({ kind: 'put-under', leadName: rowName(target) })
            : describeSessionListDropPreview({ kind: 'folder', folderName: rowName(target ?? undefined) });
    }
    if (intent.instructionKind === 'reorder-before' || intent.instructionKind === 'reorder-after') {
        return describeSessionListDropPreview({
            kind: 'reorder',
            edge: intent.instructionKind === 'reorder-before' ? 'above' : 'below',
            siblingName: rowName(target ?? undefined),
        });
    }
    return describeSessionListDropPreview({ kind: 'top-level' });
}

function previewForAdmission(admission: Extract<SessionListDragAdmission, { ok: true }>) {
    if (admission.effect === 'manager') return describeSessionListDropPreview({ kind: 'put-under', leadName: rowName(admission.lead) });
    const instruction = admission.result.instruction;
    const target = 'targetId' in instruction ? admission.tree.rowMetadataById.get(instruction.targetId) ?? null : null;
    return previewForDestination({ instructionKind: instruction.kind }, target);
}

export function sessionListDropTargetId(scope: EntityDragScopeV1): string {
    return `session-list:${scope.serverId}:${scope.accountId}`;
}

export function useSessionListEntityDragDrop(input: UseSessionListEntityDragDropInput): Readonly<{
    runtime: EntityDragDropRuntime;
    scope: EntityDragScopeV1 | null;
    targetId: string | null;
    beginCarry: (snapshot: SessionListDragSnapshot, mode: 'pointer' | 'keyboard') => SessionListCarry | null;
    prepareSource: (request: SessionListDragSnapshot | Readonly<{ sourceRowId: string }>) => Readonly<{ sourceId: string; dispose: () => void }> | null;
}> {
    const runtime = useEntityDragDropRuntime();
    const activeScope = useActiveServerAccountScope();
    const scope = React.useMemo<EntityDragScopeV1 | null>(
        () => (activeScope ? { serverId: activeScope.serverId, accountId: activeScope.accountId } : null),
        [activeScope?.serverId, activeScope?.accountId],
    );
    const inputRef = React.useRef(input);
    inputRef.current = input;
    const scopeRef = React.useRef(scope);
    scopeRef.current = scope;
    const factsRef = React.useRef<SessionManagerEligibilitySnapshot | null>(null);
    const pointerVisualRef = React.useRef<TreeDropVisualGeometry>(NO_GEOMETRY);
    /** The topology the current carry started from (pointer or keyboard). */
    const carriedSnapshotRef = React.useRef<SessionListDragSnapshot | null>(null);
    const sourceRef = React.useRef<Readonly<{ sourceId: string; dispose: () => void }> | null>(null);
    const { execute: executeMountedAction } = useMountedActionExecution(activeScope);

    const buildContext = React.useCallback((mutationScope?: SessionOrganizationMutationScope): CommitSessionListDragIntentContext | null => {
        const current = scopeRef.current;
        if (!current) return null;
        return {
            ...inputRef.current.getCommitContext(mutationScope),
            scope: current,
            resolvePutSessionUnder: ({ serverId, sessionId, managerSessionId }) => {
                const verdict = resolvePutUnderEligibility(sessionsRecord(current.serverId), sessionId, managerSessionId, factsRef.current, {
                    serverId,
                    accountId: current.accountId,
                });
                return verdict.allowed ? { allowed: true, expectedManagerSessionId: verdict.expectedManagerSessionId } : { allowed: false, reason: verdict.reason };
            },
        };
    }, []);

    // The mounted list answers `session.organization.move` for menus, keyboard and agents alike.
    const buildActionContext = React.useCallback((mutationScope: SessionOrganizationMutationScope) => {
        const captured = scopeRef.current;
        if (!captured) return null;
        if (parseToken(mutationScope.credentials.token) !== captured.accountId) return null;
        if (mutationScope.serverId !== captured.serverId && !mutationScope.serverIdAliases.includes(captured.serverId)) return null;
        return buildContext(mutationScope);
    }, [buildContext]);
    React.useEffect(() => registerMountedSessionListOrganizationAction(createSessionListOrganizationActionAdapter(buildActionContext)), [buildActionContext]);

    const resolve = React.useCallback((context: EntityDropResolveContext): EntityDropAdmissionV1 => {
        if (context.input === 'keyboard') inputRef.current.onKeyboardGeometry?.(NO_GEOMETRY);
        const current = scopeRef.current;
        const refuse = (code: string): EntityDropAdmissionV1 => ({ status: 'refused', reason: describeSessionListDropReason(code) });
        const commitContext = buildContext();
        if (!current || !commitContext) return refuse('scope-mismatch');
        let intent: SessionListDragIntent | null;
        let geometry: TreeDropVisualGeometry = NO_GEOMETRY;
        if (context.input === 'pointer') {
            const snapshot = carriedSnapshotRef.current;
            if (!snapshot) return refuse('source-missing');
            const resolved = inputRef.current.resolvePointerGeometry(context.pointer);
            const instruction = resolved.result.instruction;
            if (instruction.kind === 'idle') {
                pointerVisualRef.current = NO_GEOMETRY;
                return refuse(SESSION_LIST_NO_TARGET_CODE);
            }
            if (instruction.kind === 'blocked') {
                // Over its own place there is nothing to say; any other structural block says why.
                pointerVisualRef.current = NO_GEOMETRY;
                return refuse(instruction.reason === 'same-position' || instruction.reason === 'no-target'
                    ? SESSION_LIST_NO_TARGET_CODE
                    : resolved.result.sessionListBlockReason ?? instruction.reason);
            }
            geometry = resolved.geometry;
            intent = buildSessionListDragIntent({
                result: resolved.result,
                sourceRowId: snapshot.source.sourceRowId,
                sourceKind: snapshot.source.kind,
                snapshotSignature: snapshot.signature,
                scope: current,
            });
        } else {
            const assignment = readSessionListFolderAssignmentDestination(context.destination);
            if (assignment) return resolveSessionListFolderAssignmentDrop({ item: context.item, folderId: assignment.folderId,
                context: commitContext, preview: previewForFolderAssignment, reason: describeSessionListDropReason });
            intent = readSessionListDestinationIntent(context.destination, current);
        }
        if (!intent || intent.instructionKind === 'idle') return refuse(SESSION_LIST_NO_TARGET_CODE);
        const admission = resolveSessionListEntityDrop({
            item: context.item,
            intent,
            context: commitContext,
            preview: admitted => {
                if (context.input === 'keyboard') {
                    const visual: TreeInstructionVisual = admitted.effect === 'manager'
                        ? { kind: 'outline', targetId: admitted.lead.rowId } : admitted.result.visual;
                    inputRef.current.onKeyboardGeometry?.(inputRef.current.resolveKeyboardGeometry?.(visual) ?? NO_GEOMETRY);
                }
                return previewForAdmission(admitted);
            },
            refusedPreview: ({ intent, target }) => intent.instructionKind === 'nest-into' && target?.kind === 'session'
                ? describeSessionListRefusedPutUnder(rowName(target)) : undefined,
            reason: describeSessionListDropReason,
        });
        // Refusals light nothing: only an admitted place draws its line or outline.
        if (context.input === 'pointer') pointerVisualRef.current = admission.status === 'allowed' ? geometry : NO_GEOMETRY;
        return admission;
    }, [buildContext]);

    const execute = React.useCallback(async (effect: EntityDropEffectV1): Promise<EntityDropOutcomeV1> => {
        const current = scopeRef.current;
        if (!current) return { status: 'refused', reason: describeSessionListDropReason('scope-mismatch') };
        const result = await executeMountedAction(effect.actionId as ActionId, effect.input);
        return projectActionOutcome(effect.actionId, result);
    }, [executeMountedAction]);

    const targetId = scope ? sessionListDropTargetId(scope) : null;
    React.useEffect(() => {
        if (!scope || !targetId) return;
        return runtime.registerTarget({
            id: targetId,
            scope,
            acceptedKinds: ACCEPTED_KINDS,
            getBounds: () => inputRef.current.getListBounds(),
            listDestinations: (item) => {
                const context = buildContext();
                return context ? listSessionListEntityDropDestinations({ item, context, preview: previewForDestination, folderPreview: previewForFolderAssignment }) : [];
            },
            resolve,
            execute,
        });
    }, [buildContext, execute, resolve, runtime, scope, targetId]);

    const prepareSource = React.useCallback((request: SessionListDragSnapshot | Readonly<{ sourceRowId: string }>) => {
        if (runtime.getSnapshot().phase === 'pending') return null;
        sourceRef.current?.dispose();
        const current = scopeRef.current;
        if (!current) return null;
        const context = buildContext();
        if (!context) return null;
        const sourceRowId = 'source' in request ? request.source.sourceRowId : request.sourceRowId;
        const semanticRow = 'source' in request ? null : context.latestItems.find(
            (candidate): candidate is Extract<SessionListIndexItem, { type: 'session' }> => candidate.type === 'session'
                && candidate.serverId === current.serverId && treeRowId.session(current.serverId, candidate.sessionId) === sourceRowId,
        );
        const snapshot = 'source' in request ? request : semanticRow ? null : buildSessionListDragSnapshot({
            items: context.latestItems, viewItems: context.latestItems, sessionDragKey: sourceRowId,
            foldersFeatureEnabled: context.isFolderOrganizationEnabled?.(current.serverId) === true,
        });
        const item: EntityDragItemV1 | null = semanticRow
            ? { kind: 'session', scope: current, address: { serverId: current.serverId, sessionId: semanticRow.sessionId } }
            : snapshot ? itemForSnapshot(snapshot, current) : null;
        if (!item) return null;
        const sourceId = `session-list-source:${current.serverId}:${current.accountId}:${sourceRowId}`;
        let live = true;
        carriedSnapshotRef.current = snapshot;
        const sourceMetadata = snapshot?.source.treeSource.metadata as SessionListTreeRowMetadata | undefined;
        const retireSource = runtime.registerSource({
            id: sourceId,
            scope: current,
            getItem: () => item,
            isCurrent: () => {
                if (!live || scopeRef.current?.serverId !== current.serverId || scopeRef.current?.accountId !== current.accountId) return false;
                const context = buildContext();
                if (!context) return false;
                if (!sourceMetadata && item.kind === 'session') return context.latestItems.some(candidate => candidate.type === 'session'
                    && candidate.serverId === item.address.serverId && candidate.sessionId === item.address.sessionId);
                if (!sourceMetadata) return false;
                const row = resolveSessionListDragTree(context).rowMetadataById.get(sourceMetadata.rowId);
                return row?.kind === sourceMetadata.kind && row.serverId === sourceMetadata.serverId;
            },
            describe: () => {
                const session = item.kind === 'session' ? sessionsRecord(item.address.serverId)[item.address.sessionId] : undefined;
                const title = sourceMetadata ? rowName(sourceMetadata)
                    : session ? getSessionName(session, current.serverId) : semanticRow?.sessionId ?? '';
                if (!title) return null;
                // A Session carries its mark and its state line, as the lab's carried card does.
                const subtitle = session ? getSessionCarriedLine(session, current.serverId) : null;
                const agentId = session ? readSessionPresentationAgentId(session) : null;
                return { title, ...(subtitle ? { subtitle } : {}),
                    ...(agentId ? { renderMark: (size: number) => React.createElement(AgentIcon, { agentId, size }) } : {}) };
            },
            getBounds: () => inputRef.current.getSourceBounds?.(sourceRowId) ?? null,
        });
        const abort = new AbortController();
        factsRef.current?.dispose();
        factsRef.current = null;
        if (item.kind === 'session') {
            const candidateSessionIds = Object.values(sessionsRecord(item.address.serverId))
                .filter((session) => session.id !== item.address.sessionId)
                .map((session) => session.id);
            void loadSessionManagerEligibility({ serverId: item.address.serverId, sessionId: item.address.sessionId,
                candidateSessionIds, signal: abort.signal }).then((facts) => {
                if (abort.signal.aborted || carriedSnapshotRef.current !== snapshot) { facts?.dispose(); return; }
                factsRef.current = facts;
                runtime.refresh();
            });
        }
        let unsubscribe = () => {};
        const source = { sourceId, dispose: () => {
            if (!live) return;
            live = false;
            unsubscribe();
            abort.abort();
            if (carriedSnapshotRef.current === snapshot) {
                carriedSnapshotRef.current = null;
                factsRef.current?.dispose();
                factsRef.current = null;
                pointerVisualRef.current = NO_GEOMETRY;
                inputRef.current.onKeyboardGeometry?.(NO_GEOMETRY);
                inputRef.current.onCarryRetired?.();
            }
            if (sourceRef.current === source) sourceRef.current = null;
            retireSource();
        } };
        sourceRef.current = source;
        let engaged = false;
        unsubscribe = runtime.subscribe(() => {
            const state = runtime.getSnapshot();
            if (state.sourceId === sourceId && (state.phase === 'carrying' || state.phase === 'pending')) engaged = true;
            else if (engaged) source.dispose();
        });
        return source;
    }, [buildContext, runtime]);

    React.useEffect(() => () => sourceRef.current?.dispose(), [runtime, scope?.serverId, scope?.accountId]);
    // Current list membership is read through the source descriptor, including while the pointer is still.
    React.useEffect(() => { runtime.refresh(); });

    const beginCarry = React.useCallback((snapshot: SessionListDragSnapshot, mode: 'pointer' | 'keyboard'): SessionListCarry | null => {
        const source = prepareSource(snapshot);
        if (!source) return null;
        const carry = runtime.begin(source.sourceId, mode);
        if (!carry) { source.dispose(); return null; }
        const adapter = createEntityDragGestureAdapter(carry);
        if (mode === 'keyboard' && targetId) carry.choose(targetId);
        return {
            sourceId: source.sourceId,
            move: (pointer) => {
                adapter.update(pointer);
                return runtime.getSnapshot().targetId === targetId ? pointerVisualRef.current : NO_GEOMETRY;
            },
            choose: (destination) => {
                if (!targetId) return;
                const { scope: _scope, ...semantic } = destination;
                carry.choose(targetId, semantic as unknown as PluginUiJsonValueV1);
            },
            end: async (success, pointer) => {
                inputRef.current.onKeyboardGeometry?.(NO_GEOMETRY);
                // A late refusal or an unknown result stays on the source row's line (lab ST4), not in an alert.
                await adapter.end(success, pointer);
                source.dispose();
            },
            cancel: () => adapter.cancel(),
        };
    }, [prepareSource, runtime, targetId]);

    // Row callbacks depend on this binding. Unchanged list refreshes must not
    // invalidate every mounted row merely by allocating a new binding object.
    return React.useMemo(() => ({ runtime, scope, targetId, beginCarry, prepareSource }),
        [runtime, scope, targetId, beginCarry, prepareSource]);
}
