import * as React from 'react';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1, projectMcpServerActionFailureV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { mapMcpRegistryServerV1, selectMcpRegistryServerTransportV1,
    type McpRegistryMissingValueV1 } from '@happier-dev/protocol/mcp/servers/registry/mapMcpRegistryServerV1';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistryItemPointerV1, type McpRegistryServerV1,
    type RegistryUpstreamCheckV1 } from '@happier-dev/protocol/registries';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { useRegistryUpdateCheck } from '@/registries/useRegistryUpdateCheck';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type McpServerUpdateReview =
    | Readonly<{ status: 'idle' | 'loading' }>
    | Readonly<{ status: 'failed'; code: string }>
    | Readonly<{ status: 'ready'; pointer: RegistryItemPointerV1; before: McpServerCatalogEntryV1;
        after: McpServerCatalogEntryV1 | null; missingValues: readonly McpRegistryMissingValueV1[];
        inputs: ReturnType<typeof selectMcpRegistryServerTransportV1>['inputs'] }>;
export type McpServerUpdateApplyState = Readonly<{
    status: 'idle' | 'applying' | 'applied' | 'failed'; code?: string;
}>;
type ReviewDraft = Readonly<{
    key: string;
    revision: number | 'absent';
    before: McpServerCatalogEntryV1;
    pointer: RegistryItemPointerV1;
    source: McpRegistryServerV1;
    values: Readonly<Record<string, ValueRefV1>>;
}>;

/** Review uses the same mapping as Update; user refs and policies are owned by that mapper. */
function projectReview(draft: ReviewDraft): Extract<McpServerUpdateReview, { status: 'ready' }> {
    const mapped = mapMcpRegistryServerV1({ server: draft.source, id: draft.before.id, name: draft.before.name,
        nowMs: draft.before.updatedAt, previous: draft.before, inputs: draft.values });
    return { status: 'ready', pointer: draft.pointer, before: draft.before,
        after: mapped.ok ? mapped.entry : null, missingValues: mapped.ok ? [] : mapped.missingValues,
        inputs: selectMcpRegistryServerTransportV1(draft.source, { previous: draft.before }).inputs };
}

export function useMcpServerUpdate(options: Readonly<{
    server: McpServerCatalogEntryV1;
    catalogRevision: number | 'absent' | null;
    execution: Pick<ReturnType<typeof useMountedActionExecution>, 'execute' | 'ready' | 'isCurrent'>;
    reload: () => void | Promise<void>;
    scopeKey?: string;
}>) {
    const key = JSON.stringify([options.scopeKey, options.server.id, options.server.origin?.kind === 'registry'
        ? options.server.origin.provenance : null]);
    const { execution, reload } = options;
    const retry = React.useCallback(() => { fireAndForget(Promise.resolve().then(reload), { tag: 'McpServerUpdate.reload' }); }, [reload]);
    const { check: checked, checkNow: runCheck } = useRegistryUpdateCheck({ scopeKey: key, execute: execution.execute,
        isCurrent: execution.isCurrent, kind: 'mcpServer', keys: [options.server.id], retry });
    const upstream: RegistryUpstreamCheckV1 | undefined = checked.results.find(result => result.kind === 'mcpServer'
        && result.key === options.server.id)?.upstream ?? (options.server.origin?.kind === 'registry' ? options.server.origin.upstream : undefined);
    const check = { ...checked, upstream };
    const [state, setState] = React.useState<{ key: string; review: McpServerUpdateReview;
        apply: McpServerUpdateApplyState }>({ key, review: { status: 'idle' }, apply: { status: 'idle' } });
    const draft = React.useRef<ReviewDraft | null>(null);
    const request = React.useRef<{ kind: 'review' | 'apply' } | null>(null);
    const latest = React.useRef({ options, key, check });
    latest.current = { options, key, check };
    React.useEffect(() => () => { draft.current = null; request.current = null; }, [key]);
    const checkNow = React.useCallback(async () => {
        if (latest.current.options.server.origin?.kind === 'registry' && execution.ready && execution.isCurrent()) await runCheck();
    }, [execution.ready, execution.isCurrent, runCheck]);
    const loadReview = React.useCallback(async () => {
        const { options, key, check } = latest.current;
        const { server, execution } = options;
        if (!execution.ready || !execution.isCurrent() || server.origin?.kind !== 'registry' || options.catalogRevision === null
            || request.current?.kind === 'apply') return;
        const token = { kind: 'review' } as const;
        request.current = token;
        draft.current = null;
        setState({ key, review: { status: 'loading' }, apply: { status: 'idle' } });
        const current = () => request.current === token && latest.current.key === key && execution.isCurrent();
        const refuse = (code: string) => setState({ key, review: { status: 'failed', code }, apply: { status: 'idle' } });
        if (check.checking || check.failed || check.upstream?.state !== 'update_available'
            || check.upstream.latest?.kind !== 'version') {
            refuse(check.code ?? (check.upstream?.state === 'removed_from_source' ? 'removed_from_source' : 'update_unavailable'));
            request.current = null;
            return;
        }
        const pointer: RegistryItemPointerV1 = { sourceId: server.origin.provenance.sourceId,
            itemId: server.origin.provenance.itemId, version: check.upstream.latest.version };
        try {
            const result = await execution.execute('registries.items.read', { kind: 'mcpServer', ...pointer });
            if (!current()) return;
            const parsed = result.ok ? REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].safeParse(result.result) : null;
            if (!parsed?.success) { refuse(result.ok ? 'invalid_action_output' : result.errorCode); return; }
            const { item } = parsed.data;
            if (item.payload.kind !== 'mcpServer' || item.summary.kind !== 'mcpServer' || item.summary.problem
                || item.summary.sourceId !== pointer.sourceId || item.summary.itemId !== pointer.itemId || item.summary.version !== pointer.version) {
                refuse(item.summary.problem?.code ?? 'unsupported_entry'); return;
            }
            const reviewed: ReviewDraft = { key, revision: options.catalogRevision, before: server,
                pointer, source: item.payload.server, values: {} };
            const review = projectReview(reviewed);
            draft.current = reviewed;
            setState({ key, review, apply: { status: 'idle' } });
        } catch (error) {
            if (current()) refuse(projectMcpServerActionFailureV1(error).errorCode);
        } finally { if (request.current === token) request.current = null; }
    }, []);
    const setValue = React.useCallback((name: string, value: ValueRefV1) => {
        const before = draft.current;
        if (!before || before.key !== latest.current.key || request.current) return;
        const updated = { ...before, values: { ...before.values, [name]: value } };
        try {
            const review = projectReview(updated);
            draft.current = updated;
            setState(previous => ({ ...previous, review }));
        } catch (error) {
            setState(previous => ({ ...previous, apply: { status: 'failed', code: projectMcpServerActionFailureV1(error).errorCode } }));
        }
    }, []);
    // A newer catalog projection cannot silently change the configuration or CAS the person reviewed.
    const eligible = React.useCallback(() => {
        const { options, key, check } = latest.current;
        const reviewed = draft.current;
        return reviewed?.key === key && options.execution.ready && options.execution.isCurrent()
            && options.catalogRevision === reviewed.revision && sameStrictJsonValue(options.server, reviewed.before)
            && !check.checking && !check.failed && check.upstream?.state === 'update_available';
    }, []);
    const apply = React.useCallback(async () => {
        const reviewed = draft.current;
        const { options, key } = latest.current;
        if (!reviewed || !eligible() || request.current || projectReview(reviewed).missingValues.length) return;
        const token = { kind: 'apply' } as const;
        request.current = token;
        setState(previous => ({ ...previous, apply: { status: 'applying' } }));
        const current = () => request.current === token && latest.current.key === key && options.execution.isCurrent();
        try {
            const result = await options.execution.execute('mcp.servers.update', { serverId: reviewed.before.id,
                expectedRevision: reviewed.revision, from: { registry: reviewed.pointer }, inputs: reviewed.values });
            if (!current()) return;
            const parsed = result.ok ? MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.update'].safeParse(result.result) : null;
            const code = !result.ok ? result.errorCode : !parsed?.success ? 'invalid_action_output'
                : parsed.data.status === 'updated' ? null : parsed.data.status;
            setState(previous => ({ ...previous, apply: code ? { status: 'failed', code } : { status: 'applied' } }));
            if (!code) { draft.current = null; retry(); }
        } catch (error) {
            if (current()) setState(previous => ({ ...previous, apply: { status: 'failed', code: projectMcpServerActionFailureV1(error).errorCode } }));
        } finally { if (request.current === token) request.current = null; }
    }, [eligible, retry]);
    const visible = state.key === key && execution.ready && execution.isCurrent();
    const review: McpServerUpdateReview = visible ? state.review : { status: 'idle' };
    const applyState: McpServerUpdateApplyState = visible ? state.apply : { status: 'idle' };
    return { review, check, applyState, loadReview, setValue, checkNow, apply,
        values: visible ? draft.current?.values ?? {} : {},
        staleReview: Boolean(visible && review.status === 'ready' && draft.current
            && (options.catalogRevision !== draft.current.revision || !sameStrictJsonValue(options.server, draft.current.before))),
        canApply: Boolean(visible && review.status === 'ready' && !review.missingValues.length && eligible()
            && applyState.status !== 'applying' && applyState.status !== 'applied'),
    };
}
