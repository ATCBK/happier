import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import type { ActionId } from './actionIds.js';
import { resolveUsagePageAggregation } from '../usage/resolveUsagePageAggregation.js';
import { UsageCoachPreferencesV1Schema } from '../account/settings/usageCoachPreferencesV1.js';
import { buildUsageCoachRemedies } from '../usage/coach/buildUsageCoachRemedies.js';
import { applyUsageCoachPreferences, evaluateUsageCoach } from '../usage/coach/evaluateUsageCoach.js';
import { UsageMcpBindingUsageSchema } from '../usage/coach/usageMcpBindingUsage.js';
import { UsageCoachApplyResultSchema } from '../usage/coach/coachActions.js';
import { createMcpServerActionExecuteV1 } from '../mcp/servers/serverActionsV1.js';
import { commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '../mcp/servers/serverCatalogV1.js';
import type { McpServerCatalogV1 } from '../mcp/servers/serverRowsV1.js';

const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });

describe('evidence-bound Coach Action admission', () => {
    it('composes witnessed MCP remedies with exact Undo and refuses intervening catalog edits', async () => {
        let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'docs', transport: 'stdio',
            stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 10 },
            { id: 'other-server', name: 'other', transport: 'stdio', stdio: { command: 'other', args: [] }, env: {}, createdAt: 1, updatedAt: 10 }], bindings: [{
            id: 'rule', serverId: 'server', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 20,
        }] };
        let revision = 40;
        const usage = UsageMcpBindingUsageSchema.parse({ v: 2, evidenceId: 'mcp-window', sessionId: 'session', turnId: 'turn',
            observedAtMs: 150, window: { startMs: 100, endMs: 150 }, coverage: 'complete', bindings: [{ serverId: 'server',
                bindingId: 'rule', serverRevision: 10, bindingRevision: 20, catalogRevision: 40, toolCallCount: 0, schemaBytes: null }] });
        const snapshot = () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
            readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) });
        let raceAfterQuery = false;
        let nextRuleId = 0;
        let preferences = UsageCoachPreferencesV1Schema.parse({});
        let settingsVersion = 1;
        const mcp = createMcpServerActionExecuteV1({ readCatalog: snapshot,
            // Only the durable row transport is replaced; reducers and CAS remain real.
            mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
                ctx: { nowMs: 300, newId: () => `new-rule-${++nextRuleId}` }, writeCatalog: async candidate => {
                    if (expectedRevision !== revision || candidate.expectedRevision !== revision) return { status: 'conflict', revision };
                    catalog = candidate.catalog; return { status: 'updated', revision: ++revision, cursor: revision };
                } }), machine: async () => { throw Error('No machine effect'); },
        });
        const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        // A real unrelated rules mutation advances the same catalog after capture.
        expect(await mcp({ actionId: 'mcp.rules.set', input: { items: [{ serverId: 'other-server' }], change: {
            kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' },
        } }, context })).toMatchObject({ ok: true, result: { ok: true, revision: 41 } });
        const original = catalog.bindings;
        const originalBinding = original.find(rule => rule.id === 'rule')!;
        const executor = createActionExecutor({ mcpServerAction: mcp,
            settingsDeclarationAction: async request => {
                if (request.actionId === 'settings.get') return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion };
                preferences = UsageCoachPreferencesV1Schema.parse('value' in request.input ? request.input.value : undefined);
                return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion: ++settingsVersion };
            },
            usageActions: { query: async () => {
                const finding = evaluateUsageCoach({ queryKey: 'query', period: { startMs: 100, endMs: 200 }, asOfMs: 200,
                    currentness: 'current', detail: { coverage: 'partial', mcpUsage: [usage] } }).findings;
                const admittedRemedies = buildUsageCoachRemedies({ findings: finding, composition: [], mcpUsage: [usage], serverId: 'home',
                    sessions: [{ id: 'session', serverId: 'home', active: false, ownerMetadata: {}, agentTarget: null,
                        access: { capabilities: { submitAgentInput: true } } }], mcpCatalog: await snapshot() });
                const batch = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query, asOfMs: 200,
                    detail: { status: 'partial', coach: { detail: { coverage: 'partial', mcpUsage: [usage] }, admittedRemedies } } }] });
                if (raceAfterQuery) { revision += 1; raceAfterQuery = false; }
                return batch;
            } },
        } as ActionExecutorDeps);
        const queried = await executor.execute('usage.query', { queries: [query] }, context);
        expect(queried.ok).toBe(true);
        const evaluation = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query, asOfMs: 200,
            detail: { status: 'partial', coach: { detail: { coverage: 'partial', mcpUsage: [usage] } } } }] });
        const evidenceKey = evaluation.results[0]!.coach!.findings.find(row => row.detectorId === 'mcp_overhead')!.evidenceKey;
        const snooze = await executor.execute('usage.coach.snooze', { query, evidenceKey, untilMs: 250 }, context);
        expect(snooze).toMatchObject({ ok: true, result: { kind: 'preference_updated' } });
        expect(applyUsageCoachPreferences(evaluation.results[0]!.coach!, preferences, 249).findings[0]!.state.snoozedUntilMs).toBe(250);
        expect(applyUsageCoachPreferences(evaluation.results[0]!.coach!, preferences, 250).findings[0]!.state.snoozedUntilMs).toBeNull();
        expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: true }, context)).toMatchObject({ ok: true });
        expect(applyUsageCoachPreferences(evaluation.results[0]!.coach!, preferences, 250).findings[0]!.state.dismissed).toBe(true);
        expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: false }, context)).toMatchObject({ ok: true });
        expect(applyUsageCoachPreferences(evaluation.results[0]!.coach!, preferences, 250).findings[0]!.state.dismissed).toBe(false);
        const apply = await executor.execute('usage.coach.apply', { query, evidenceKey }, context);
        expect(apply, JSON.stringify(apply)).toMatchObject({ ok: true, result: { kind: 'applied', reversal: { kind: 'mcp_binding' } } });
        if (!apply.ok) throw Error('Apply failed');
        const receipt = UsageCoachApplyResultSchema.parse(apply.result);
        expect(catalog.bindings.find(rule => rule.id === 'rule')!.enabled).toBe(false);
        const undo = await executor.execute('usage.coach.undo', { query, evidenceKey, reversal: receipt.reversal }, context);
        expect(undo, JSON.stringify(undo)).toMatchObject({ ok: true, result: { kind: 'undone' } });
        const configuration = (rules: McpServerCatalogV1['bindings']) => rules.map(({ updatedAt: _clock, ...rule }) => rule)
            .sort((a, b) => a.id.localeCompare(b.id));
        expect(configuration(catalog.bindings)).toEqual(configuration(original));
        // New native observation sees the restored configuration and its real row revision.
        usage.bindings[0]!.catalogRevision = revision;
        usage.bindings[0]!.bindingRevision = catalog.bindings.find(rule => rule.id === 'rule')!.updatedAt;
        const reapplied = await executor.execute('usage.coach.apply', { query, evidenceKey }, context);
        expect(reapplied.ok).toBe(true);
        if (!reapplied.ok) throw Error('Reapply failed');
        const nextReceipt = UsageCoachApplyResultSchema.parse(reapplied.result);
        await mcp({ actionId: 'mcp.rules.set', input: { items: [{ serverId: 'server' }], change: {
            kind: 'write', write: { place: { t: 'machine', machineId: 'other-machine' }, state: 'on' },
        } }, context });
        const intervening = catalog;
        expect(await executor.execute('usage.coach.undo', { query, evidenceKey, reversal: nextReceipt.reversal }, context))
            .toMatchObject({ ok: false, errorCode: 'coach_owner_refused' });
        expect(catalog).toBe(intervening);
        // Apply must also refuse a row changed between the authorized query and effect.
        catalog = { ...catalog, bindings: original }; usage.bindings[0]!.catalogRevision = revision;
        usage.bindings[0]!.bindingRevision = originalBinding.updatedAt; raceAfterQuery = true;
        expect(await executor.execute('usage.coach.apply', { query, evidenceKey }, context)).toMatchObject({ ok: false });
        expect(catalog.bindings).toBe(original);
        // Changing the actual server or rule voids the old witness before mutation.
        catalog = { ...catalog, servers: catalog.servers.map(server => server.id === 'server' ? { ...server, updatedAt: 301 } : server) };
        expect(await executor.execute('usage.coach.apply', { query, evidenceKey }, context))
            .toMatchObject({ ok: false, errorCode: 'coach_remedy_unavailable' });
        catalog = { ...catalog, servers: catalog.servers.map(server => server.id === 'server' ? { ...server, updatedAt: 10 } : server),
            bindings: original.map(rule => rule.id === 'rule' ? { ...rule, updatedAt: 302 } : rule) };
        expect(await executor.execute('usage.coach.apply', { query, evidenceKey }, context))
            .toMatchObject({ ok: false, errorCode: 'coach_remedy_unavailable' });
    });
    it('prepares the canonical rules address from witnessed MCP usage', () => {
        const usage = UsageMcpBindingUsageSchema.parse({ v: 1, evidenceId: 'mcp-window', sessionId: 'session', turnId: 'turn',
            observedAtMs: 150, window: { startMs: 100, endMs: 150 }, coverage: 'complete', bindings: [{ serverId: 'server',
                bindingId: 'rule', serverRevision: 10, bindingRevision: 20, catalogRevision: 40, toolCallCount: 0, schemaBytes: null }] });
        const finding = evaluateUsageCoach({ queryKey: 'query', period: { startMs: 100, endMs: 200 }, asOfMs: 200,
            currentness: 'current', detail: { coverage: 'partial', mcpUsage: [usage] } }).findings;
        const input = { findings: finding, composition: [], mcpUsage: [usage], serverId: 'home',
            sessions: [{ id: 'session', serverId: 'home', active: true, ownerMetadata: {}, agentTarget: null,
                access: { capabilities: { submitAgentInput: true } } }],
            mcpCatalog: { status: 'ready', authority: 'active', revision: 40, diagnostics: [], catalog: { v: 1,
                servers: [{ id: 'server', name: 'docs', transport: 'stdio', stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 10 }],
                bindings: [{ id: 'rule', serverId: 'server', enabled: true, target: { t: 'allMachines' }, agentId: 'codex', createdAt: 1, updatedAt: 20 }] } },
        } satisfies Parameters<typeof buildUsageCoachRemedies>[0];
        expect(buildUsageCoachRemedies(input)).toEqual([]);
        const currentUsage = UsageMcpBindingUsageSchema.parse({ ...usage, v: 2 });
        const currentFinding = evaluateUsageCoach({ queryKey: 'query', period: { startMs: 100, endMs: 200 }, asOfMs: 200,
            currentness: 'current', detail: { coverage: 'partial', mcpUsage: [currentUsage] } }).findings;
        expect(buildUsageCoachRemedies({ ...input, findings: currentFinding, mcpUsage: [currentUsage] }))
            .toMatchObject([{ remedy: { kind: 'mcp_binding', bindingId: 'rule', serverId: 'server',
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
    it('reaches evidence admission directly for the present-user UI without an approval host', async () => {
        const executor = createActionExecutor({} as ActionExecutorDeps);
        expect(await executor.execute('usage.coach.apply', { query, evidenceKey: 'finding' }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    });
});
