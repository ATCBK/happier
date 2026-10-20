import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import type { UsageCoachFinding, UsageCoachAdmittedRemedy } from '../../usage/coach/coachFinding.js';
import type { UsagePromptComposition } from '../../usage/coach/usagePromptComposition.js';
import { UsageCoachRemedySchema } from '../../usage/coach/coachRemedy.js';
import { SessionModelSelectionIntentV1Schema } from '../../providers/selection/v1.js';
import { buildBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { selectLatestUsageMcpBindingWindows, type UsageMcpBindingUsage } from '../../usage/coach/usageMcpBindingUsage.js';
import type { McpServerCatalogSnapshotV1 } from '../../mcp/servers/serverCatalogV1.js';
import { readSessionMcpSelectionV1FromMetadata } from '../../mcp/servers/sessionSelectionV1.js';

import type { AgentExecutionTargetV1 } from '../../agents/executionTargetV1.js';

export type UsageCoachRemedySession = Readonly<{
    id: string; serverId?: string; active: boolean;
    access?: Readonly<{ capabilities: Readonly<{ submitAgentInput: boolean }> }>;
    ownerMetadata: Readonly<Record<string, unknown>> | null;
    agentTarget: AgentExecutionTargetV1 | null;
}>;

export function buildUsageCoachRemedies(input: Readonly<{
    findings: readonly UsageCoachFinding[];
    composition: readonly UsagePromptComposition[];
    mcpUsage?: readonly UsageMcpBindingUsage[];
    mcpCatalog?: McpServerCatalogSnapshotV1;
    sessions: readonly UsageCoachRemedySession[];
    serverId: string;
    accountId?: string;
}>): UsageCoachAdmittedRemedy[] {
    const proposals: UsageCoachAdmittedRemedy[] = [];
    for (const finding of input.findings) {
        if (finding.currentness === 'current' && finding.detectorId === 'model_misfit' && finding.modelComparison && input.accountId) {
            const observed = finding.modelComparison;
            const targets = input.sessions.filter(session => session.id === observed.sessionId && session.serverId === input.serverId);
            const session = targets.length === 1 ? targets[0] : undefined;
            if (!session || session.active !== false || session.access?.capabilities.submitAgentInput !== true) continue;
            const metadata = session.ownerMetadata;
            // The active runtime coordinator/runId is not projected here. Only this real
            // inactive V1 intent owner can supply an exact Apply and Undo condition.
            if (!metadata || metadata.modelSelectionIntentV2 !== undefined) continue;
            const intent = createStoredReadSchema(SessionModelSelectionIntentV1Schema).safeParse(metadata.modelSelectionIntentV1);
            const target = session.agentTarget;
            if (!intent.success || !intent.data.selection || !target
                || buildBackendTargetKeyV2(target) !== observed.agentTargetKey
                || intent.data.selection.agentTargetKey !== observed.agentTargetKey
                || intent.data.selection.modelId !== observed.modelId
                || intent.data.selection.providerConnectionId !== observed.providerConnectionId) continue;
            const remedy = UsageCoachRemedySchema.safeParse({ kind: 'model', sessionId: session.id,
                modelId: observed.candidateModelId, providerConnectionId: observed.providerConnectionId,
                expected: { owner: 'inactive', scope: { serverId: input.serverId, accountId: input.accountId, sessionId: session.id },
                    selection: intent.data.selection, updatedAt: intent.data.updatedAt } });
            if (remedy.success) proposals.push({ detectorId: finding.detectorId,
                evidenceIds: [...new Set(finding.evidence.map(ref => ref.id))], remedy: remedy.data });
            continue;
        }
        if (finding.currentness === 'current' && finding.detectorId === 'mcp_overhead') {
            const catalog = input.mcpCatalog;
            if (!catalog || catalog.status !== 'ready' || catalog.authority !== 'active' || typeof catalog.revision !== 'number'
                || finding.evidence.some(ref => ref.kind !== 'mcp_usage')) continue;
            const evidenceIds = [...new Set(finding.evidence.map(ref => ref.id))];
            const records = selectLatestUsageMcpBindingWindows((input.mcpUsage ?? []).filter(row => evidenceIds.includes(row.evidenceId)));
            if (!records.length || records.length !== evidenceIds.length
                || new Set(records.map(row => row.evidenceId)).size !== records.length
                || records.some(row => row.v !== 2 || row.coverage !== 'complete')) continue;
            const sources = [...new Set(records.map(row => row.sessionId))].map(id => input.sessions.filter(session => session.id === id));
            if (sources.some(sessions => sessions.length !== 1 || sessions[0]!.serverId !== input.serverId
                || sessions[0]!.access?.capabilities.submitAgentInput !== true)) continue;
            const bindingIds = [...new Set(records.flatMap(row => row.bindings.map(binding => binding.bindingId)))];
            const candidates = bindingIds.flatMap(bindingId => {
                const witnessed = records.flatMap(row => row.bindings.filter(binding => binding.bindingId === bindingId));
                const binding = catalog.catalog.bindings.find(binding => binding.id === bindingId);
                const server = binding && catalog.catalog.servers.find(server => server.id === binding.serverId);
                if (!binding?.enabled || !server || witnessed.some(row => row.toolCallCount > 0 || row.serverId !== server.id
                    || row.serverRevision !== server.updatedAt || row.bindingRevision !== binding.updatedAt)) return [];
                if (sources.some(sessions => readSessionMcpSelectionV1FromMetadata(sessions[0]!.ownerMetadata)
                    ?.forceIncludeServerIds.includes(server.id))) return [];
                return [binding];
            });
            // One exact target is actionable; a multi-binding finding needs another observation.
            if (candidates.length !== 1) continue;
            const candidate = candidates[0]!;
            const remedy = UsageCoachRemedySchema.safeParse({ kind: 'mcp_binding', bindingId: candidate.id,
                serverId: candidate.serverId, target: candidate.target, agentId: candidate.agentId,
                enabled: false, expectedRevision: catalog.revision });
            if (remedy.success) proposals.push({ detectorId: finding.detectorId, evidenceIds, remedy: remedy.data });
            continue;
        }
        if (finding.currentness !== 'current' || !['duplicated_instructions', 'context_bloat'].includes(finding.detectorId)) continue;
        const evidenceIds = [...new Set(finding.evidence.map(ref => ref.id))];
        if (finding.evidence.some(ref => ref.kind !== 'composition')) continue;
        const records = input.composition.filter(row => evidenceIds.includes(row.evidenceId));
        if (records.length !== evidenceIds.length || new Set(records.map(row => row.evidenceId)).size !== records.length) continue;
        const sessionIds = new Set(records.map(row => row.sessionId));
        if (sessionIds.size !== 1) continue;
        const sessions = input.sessions.filter(session => session.id === records[0]?.sessionId);
        if (sessions.length !== 1) continue;
        const session = sessions[0]!;
        if (session.serverId !== input.serverId || session.access?.capabilities.submitAgentInput !== true) continue;
        const metadata = session.ownerMetadata;
        const agentTarget = session.agentTarget;
        if (typeof metadata?.machineId !== 'string' || !metadata.machineId || typeof metadata.path !== 'string' || !metadata.path || !agentTarget) continue;
        const text = [
            `Review the repository instruction/context configuration associated with the observed Usage Coach finding ${finding.summaryCode}.`,
            `Evidence: ${finding.evidenceKey}; observations: ${finding.measurements.map(row => `${row.metric}=${row.value} ${row.unit}`).join(', ')}.`,
            'Inspect the actual source configuration, explain a minimal improvement that preserves intended instructions and behavior, and perform the repository remedy through this Session.',
            'These observations do not authorize Git rollback, permission-policy changes, or cache-TTL changes.',
        ].join('\n');
        const remedy = UsageCoachRemedySchema.safeParse({ kind: 'prepared_session', input: {
            executionTarget: { serverId: input.serverId, machineId: metadata.machineId },
            directory: { kind: 'path', path: metadata.path }, agentTarget, initialInput: { text },
        } });
        if (remedy.success) proposals.push({ detectorId: finding.detectorId, evidenceIds, remedy: remedy.data });
    }
    return proposals;
}
