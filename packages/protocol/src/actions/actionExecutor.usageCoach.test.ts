import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import type { ActionId } from './actionIds.js';
import { resolveUsagePageAggregation } from '../usage/resolveUsagePageAggregation.js';
import { UsageCoachPreferencesV1Schema } from '../account/settings/usageCoachPreferencesV1.js';
import { buildUsageCoachRemedies } from '../usage/coach/buildUsageCoachRemedies.js';
import { evaluateUsageCoach } from '../usage/coach/evaluateUsageCoach.js';
import { UsageMcpBindingUsageSchema } from '../usage/coach/usageMcpBindingUsage.js';

const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });

describe('evidence-bound Coach Action admission', () => {
    it('prepares the canonical rules address from witnessed MCP usage', () => {
        const usage = UsageMcpBindingUsageSchema.parse({ v: 1, evidenceId: 'mcp-window', sessionId: 'session', turnId: 'turn',
            observedAtMs: 150, window: { startMs: 100, endMs: 150 }, coverage: 'complete', bindings: [{ serverId: 'server',
                bindingId: 'rule', serverRevision: 10, bindingRevision: 20, catalogRevision: 40, toolCallCount: 0, schemaBytes: null }] });
        const finding = evaluateUsageCoach({ queryKey: 'query', period: { startMs: 100, endMs: 200 }, asOfMs: 200,
            currentness: 'current', detail: { coverage: 'partial', mcpUsage: [usage] } }).findings;
        expect(buildUsageCoachRemedies({ findings: finding, composition: [], mcpUsage: [usage], serverId: 'home',
            sessions: [{ id: 'session', serverId: 'home', active: true, ownerMetadata: {}, agentTarget: null,
                access: { capabilities: { submitAgentInput: true } } }],
            mcpCatalog: { status: 'ready', authority: 'active', revision: 40, diagnostics: [], catalog: { v: 1,
                servers: [{ id: 'server', name: 'docs', transport: 'stdio', stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 10 }],
                bindings: [{ id: 'rule', serverId: 'server', enabled: true, target: { t: 'allMachines' }, agentId: 'codex', createdAt: 1, updatedAt: 20 }] } },
        })).toMatchObject([{ remedy: { kind: 'mcp_binding', bindingId: 'rule', serverId: 'server',
            target: { t: 'allMachines' }, agentId: 'codex', enabled: false, expectedRevision: 40 } }]);
    });
    it('forwards private evidence preference Actions to the available answering client owner', async () => {
        const detail = { status: 'partial' as const, permissions: [{ requestId: 'permission', workId: 'work',
            requestedAtMs: 120, decidedAtMs: 160, toolId: null, answeringClientCategory: null }] };
        const batch = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query, detail, asOfMs: 200 }] });
        const finding = batch.results[0]!.coach!.findings.find(row => row.detectorId === 'approval_friction')!;
        let preferences = UsageCoachPreferencesV1Schema.parse({ v: 1, suppressions: [] });
        const client = createActionExecutor({ isActionApprovalRequired: () => false,
            usageActions: { query: async () => batch },
            settingsDeclarationAction: async request => {
                if (request.actionId === 'settings.get') return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion: 1 };
                preferences = UsageCoachPreferencesV1Schema.parse('value' in request.input ? request.input.value : undefined);
                return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion: 2 };
            },
        } as ActionExecutorDeps);
        const headless = createActionExecutor({ isActionApprovalRequired: () => false,
            // This transport reaches the existing client Action executor; no private finding crosses in input.
            clientActionExecute: async request => client.execute(request.actionId, request.input, { ...request.context, surface: 'ui' }),
            usageActions: { query: async input => resolveUsagePageAggregation({ queries: input.queries }) },
        } as ActionExecutorDeps);
        const input = { query, evidenceKey: finding.evidenceKey, dismissed: true };
        for (const surface of ['cli', 'agent', 'mcp', 'api'] as const) {
            const result = await headless.execute('usage.coach.dismiss', input,
                { surface, authority: 'present_user' });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
                result: { kind: 'preference_updated', evidenceKey: finding.evidenceKey, dismissed: true } });
            expect(preferences.suppressions).toEqual([{ kind: 'dismissed', evidenceKey: finding.evidenceKey }]);
        }
    });
    it('admits strict evidence references and keeps every retained Coach write dangerous', async () => {
        const executor = createActionExecutor({} as ActionExecutorDeps);
        for (const id of ['usage.coach.apply', 'usage.coach.undo', 'usage.coach.dismiss', 'usage.coach.snooze'] as const) {
            expect(getActionSpec(id as ActionId).safety).toBe('danger');
        }
        const injectedRemedy = await executor.execute('usage.coach.apply' as ActionId, {
            query, evidenceKey: 'finding', remedy: { kind: 'setting', anchor: 'injected', value: true },
        }, { surface: 'ui' });
        expect(injectedRemedy, JSON.stringify(injectedRemedy)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await executor.execute('usage.coach.apply' as ActionId, {
            query, evidenceKey: 'finding', confirmed: true,
        }, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });
    it('requires normal dangerous-Action approval before reading or applying a valid finding', async () => {
        const executor = createActionExecutor({} as ActionExecutorDeps);
        const admitted = await executor.execute('usage.coach.apply', { query, evidenceKey: 'finding' }, {
            surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
        });
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    });
    it('uses canonical confirmation for the present-user UI because Coach has no separate confirmation host', async () => {
        const executor = createActionExecutor({} as ActionExecutorDeps);
        expect(await executor.execute('usage.coach.apply', { query, evidenceKey: 'finding' }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    });
});
