import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { applyReachRulesChangeV1, reachRulesToDraftsV1, ReachRulesChangeV1Schema, type ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { readReachRulesAcknowledgment } from './reachRulesAcknowledgment';
import { projectMcpServerActionFailureV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { randomUUID } from '@/platform/randomUUID';

export type ReachRulesWriteResult = Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>;
export type ReachRulesSource = Readonly<{ key: string; kind: 'skill' | 'mcp_server'; itemId: string; rules: ReachRulesV1;
    revision: number | 'absent'; status: 'ready' | 'loading' | 'unavailable'; valueAvailable: boolean }>;
type McpRulesInput = Readonly<{
    items: readonly Readonly<{ serverId: string }>[]; change: ReachRulesChangeV1;
}>;
type SkillRulesInput = Readonly<{
    items: readonly Readonly<{ skillId: string }>[]; change: ReachRulesChangeV1;
}>;
export type ExecuteReachRules = (...args: [actionId: 'mcp.rules.set', input: McpRulesInput]
    | [actionId: 'skills.rules.set', input: SkillRulesInput]) => Promise<ActionExecuteResult>;

type PendingChange = {
    change: ReachRulesChangeV1; nowMs: number; ids: string[]; execute: ExecuteReachRules;
    resolve: (result: ReachRulesWriteResult) => void;
};
type State = {
    key: string; rules: ReachRulesV1; written: ReachRulesV1; revision: number | 'absent';
    previous: ReachRulesV1 | null; pending: PendingChange[]; running: boolean; mounted: boolean;
    publishOptimistic?: (rules: ReachRulesV1 | null) => void;
};

function project(state: State): ReachRulesV1 {
    return state.pending.reduce<ReachRulesV1>((rules, operation) => {
        let index = 0;
        return applyReachRulesChangeV1(rules, operation.change, { nowMs: operation.nowMs,
            newId: () => {
                const position = index++;
                return operation.ids[position] ?? (operation.ids[position] = randomUUID());
            } });
    }, state.written);
}

/** One optimistic owner; reads never replace a newer acknowledged write with an older projection. */
export function useReachRulesState(source: ReachRulesSource, execute: ExecuteReachRules,
    publishOptimistic?: (rules: ReachRulesV1 | null) => void) {
    const [, render] = React.useState(0);
    const latest = React.useRef(source);
    latest.current = source;
    const owner = React.useRef<State | null>(null);
    if (!owner.current || owner.current.key !== source.key) owner.current = { key: source.key, rules: source.rules,
        written: source.rules, revision: source.revision, previous: null, pending: [], running: false, mounted: true, publishOptimistic };
    const state = owner.current;
    const publish = React.useCallback((current: State, operation = false) => {
        const next = project(current);
        if (operation) current.publishOptimistic?.(current.pending.length ? next : null);
        if (JSON.stringify(next) === JSON.stringify(current.rules)) return;
        current.rules = next;
        if (owner.current === current && current.mounted) render(value => value + 1);
    }, []);
    React.useEffect(() => {
        state.mounted = true;
        return () => { state.mounted = false; if (state.pending.length) state.publishOptimistic?.(null); };
    }, [state]);
    React.useLayoutEffect(() => {
        if (source.status !== 'ready' || source.revision === 'absent') return;
        if (state.revision !== 'absent' && source.revision < state.revision) return;
        state.written = source.rules;
        state.revision = source.revision;
        publish(state);
    }, [source.rules, source.revision, source.status, state, publish]);

    const drain = React.useCallback(async (current: State) => {
        if (current.running) return;
        current.running = true;
        while (current.pending.length > 0) {
            const operation = current.pending[0]!;
            let result: ReachRulesWriteResult;
            if (owner.current !== current || !current.mounted) result = { ok: false, message: 'scope-retired' };
            else if (latest.current.status === 'unavailable') result = { ok: false, message: 'catalog_unavailable' };
            else {
                try {
                    const receipt = source.kind === 'skill'
                        ? await operation.execute('skills.rules.set', { items: [{ skillId: source.itemId }], change: operation.change })
                        : await operation.execute('mcp.rules.set', { items: [{ serverId: source.itemId }], change: operation.change });
                    const acknowledgment = readReachRulesAcknowledgment(source.kind, source.itemId, receipt);
                    if (!acknowledgment.ok) result = acknowledgment;
                    else {
                        if (current.revision === 'absent' || acknowledgment.revision >= current.revision) {
                            current.written = acknowledgment.item.rules;
                            current.revision = acknowledgment.revision;
                        }
                        current.previous = acknowledgment.item.previous;
                        result = { ok: true };
                    }
                } catch (error) {
                    const refusal = projectMcpServerActionFailureV1(error);
                    result = { ok: false, message: refusal.errorCode ?? refusal.error };
                }
            }
            current.pending.shift();
            publish(current, true);
            operation.resolve(result);
        }
        current.running = false;
    }, [source.kind, source.itemId, publish]);

    const change = React.useCallback((input: ReachRulesChangeV1): Promise<ReachRulesWriteResult> => {
        if (owner.current !== state || !state.mounted) return Promise.resolve({ ok: false, message: 'scope-retired' });
        if (latest.current.status !== 'ready') return Promise.resolve({ ok: false, message: 'catalog_unavailable' });
        const parsed = ReachRulesChangeV1Schema.safeParse(input);
        if (!parsed.success) return Promise.resolve({ ok: false, message: 'invalid_action_input' });
        return new Promise(resolve => {
            const operation: PendingChange = { change: parsed.data, nowMs: Date.now(), ids: [], execute, resolve };
            state.previous = state.rules;
            state.pending.push(operation);
            try { publish(state, true); }
            catch (error) {
                state.pending.pop();
                resolve({ ok: false, message: error instanceof Error ? error.message : 'invalid_action_input' });
                return;
            }
            void drain(state);
        });
    }, [state, execute, publish, drain]);
    const undoLast = React.useCallback(() => state.previous ? change({ kind: 'replace', rules: reachRulesToDraftsV1(state.previous) })
        : Promise.resolve<ReachRulesWriteResult>({ ok: true }), [state, change]);
    return { rules: source.valueAvailable ? state.rules : source.rules, revision: state.revision, status: source.status, change, undoLast };
}
