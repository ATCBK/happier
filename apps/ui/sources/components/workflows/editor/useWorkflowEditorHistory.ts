import * as React from 'react';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

type WorkflowEditorHistorySnapshot = WorkflowEditorDraft | Readonly<{ draft: WorkflowEditorDraft }>;

/** Schema values are already semantically equal; only declaration order remains to compare. */
function schemaPropertyOrdersEqual(left: PluginJsonSchemaV2, right: PluginJsonSchemaV2): boolean {
    const pending: Array<readonly [PluginJsonSchemaV2, PluginJsonSchemaV2]> = [[left, right]];
    while (pending.length > 0) {
        const [before, after] = pending.pop()!;
        if (!pluginJsonValuesEqual(Object.keys(before.properties ?? {}), Object.keys(after.properties ?? {}))) return false;
        for (const key of ['properties', '$defs', 'definitions'] as const) {
            for (const name of Object.keys(before[key] ?? {})) pending.push([before[key]![name]!, after[key]![name]!]);
        }
        for (const key of ['items', 'additionalProperties', 'propertyNames', 'not'] as const) {
            const child = before[key];
            const counterpart = after[key];
            if (typeof child === 'object' && typeof counterpart === 'object') pending.push([child, counterpart]);
        }
        for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
            before[key]?.forEach((child, index) => pending.push([child, after[key]![index]!]));
        }
    }
    return true;
}

/** Editor content includes visible result-field order; ordinary JSON and Plan identity do not. */
export function workflowEditorSnapshotsEqual(
    left: WorkflowEditorHistorySnapshot | null,
    right: WorkflowEditorHistorySnapshot | null,
): boolean {
    if (!pluginJsonValuesEqual(left, right)) return false;
    if (left === null || right === null) return true;
    const before = walkWorkflowBlocks(('draft' in left ? left.draft : left).blocks);
    const after = walkWorkflowBlocks(('draft' in right ? right.draft : right).blocks);
    return before.every((block, index) => {
        const counterpart = after[index]!;
        return !('result' in block) || block.result?.kind !== 'json'
            || ('result' in counterpart && counterpart.result?.kind === 'json'
                && schemaPropertyOrdersEqual(block.result.schema, counterpart.result.schema));
    });
}

export type WorkflowEditorHistoryControls = Readonly<{
    undoLabel: string | null;
    redoLabel: string | null;
    undo: () => void;
    redo: () => void;
}>;

type Change<T> = Readonly<{ before: T; after: T; label: string }>;

/** One source-local history. Native inputs stage a transaction until their commit boundary. */
export function useWorkflowEditorHistory<T extends WorkflowEditorHistorySnapshot>(scope: string, restore: (snapshot: T) => void) {
    const [, refresh] = React.useReducer((value: number) => value + 1, 0);
    const state = React.useRef({ scope, revision: 0, past: [] as Change<T>[], future: [] as Change<T>[], pending: null as Change<T> | null });
    if (state.current.scope !== scope) state.current = { scope, revision: 0, past: [], future: [], pending: null };
    const restoreRef = React.useRef(restore);
    restoreRef.current = restore;
    const commit = React.useCallback(() => {
        const current = state.current;
        if (current.pending === null) return;
        if (!workflowEditorSnapshotsEqual(current.pending.before, current.pending.after)) {
            current.past.push(current.pending);
            current.future = [];
        }
        current.pending = null;
        refresh();
    }, []);
    const record = React.useCallback((before: T, after: T, label: string, committed = true) => {
        if (workflowEditorSnapshotsEqual(before, after)) { if (committed) commit(); return false; }
        if (committed) {
            commit();
            state.current.past.push({ before, after, label });
            state.current.future = [];
        } else {
            state.current.pending = { before: state.current.pending?.before ?? before, after, label: state.current.pending?.label ?? label };
            state.current.future = [];
        }
        state.current.revision += 1;
        refresh();
        return true;
    }, [commit]);
    const undo = React.useCallback(() => {
        commit();
        const change = state.current.past.at(-1);
        if (!change) return;
        // A failed restoration leaves the entry intact (e.g. a removed private trigger requiring setup).
        restoreRef.current(change.before);
        state.current.past.pop();
        state.current.future.push(change);
        state.current.revision += 1;
        refresh();
    }, [commit]);
    const redo = React.useCallback(() => {
        commit();
        const change = state.current.future.at(-1);
        if (!change) return;
        restoreRef.current(change.after);
        state.current.future.pop();
        state.current.past.push(change);
        state.current.revision += 1;
        refresh();
    }, [commit]);
    const reset = React.useCallback(() => {
        const current = state.current;
        current.past = [];
        current.future = [];
        current.pending = null;
        current.revision += 1;
        refresh();
    }, []);
    const controls: WorkflowEditorHistoryControls = {
        undoLabel: state.current.past.at(-1)?.label ?? null,
        redoLabel: state.current.future.at(-1)?.label ?? null,
        undo, redo,
    };
    const getRevision = React.useCallback(() => state.current.revision, []);
    return { controls, record, commit, reset, getRevision };
}
