import {
    AutomationDefinitionCreateRequestSchema,
    AutomationDefinitionDetailSchema,
    AutomationDefinitionListItemSchema,
    AutomationDefinitionReconcileRequestSchema,
    AutomationTriggerDetailSchema,
    type AutomationDefinitionDetail,
} from '@happier-dev/protocol/automations/automationApiV3';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

export function createWorkflowAutomationDetailFixture(params: Readonly<{
    id: string; revision: number; triggerId?: string; workflowDefinitionId?: string; definition?: WorkflowDefinitionV1;
}>): AutomationDefinitionDetail {
    return AutomationDefinitionDetailSchema.parse({ id: params.id, name: 'Daily review', description: null, enabled: true,
        workflowDefinitionId: params.workflowDefinitionId ?? null, scopeSessionId: null, targetType: null, existingSessionId: null,
        templateVersion: params.revision, lastRunAt: null, createdAt: 1, updatedAt: 1,
        executionRecipe: { v: 2, templateVersion: params.revision, workflow: { t: 'plain', v: {
            workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
            ...(params.definition ? { inlineDefinition: params.definition } : {}),
        } }, triggerEvidence: null },
        assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: 1 }],
        triggers: params.triggerId ? [{ id: params.triggerId, kind: 'schedule', enabled: true, revision: 1,
            schedule: { kind: 'interval', everyMs: 86400000, scheduleExpr: null, timezone: null },
            createdAt: 1, updatedAt: 1, nextRunAt: null, triggerDefinitionEnvelope: null }] : [],
    });
}

/** Automation HTTP persistence beneath real Workflow admission, trigger policy and codecs. */
export function createWorkflowAutomationHttpBoundary(): {
    creates: Array<ReturnType<typeof AutomationDefinitionCreateRequestSchema.parse>>;
    reconciles: Array<Readonly<{ automationId: string; input: ReturnType<typeof AutomationDefinitionReconcileRequestSchema.parse> }>>;
    rows: Map<string, AutomationDefinitionDetail>;
    respondWith(response: ((method: string, input: unknown) => Response | undefined) | undefined): void;
    clear(): void;
    handle(url: URL, init?: RequestInit): Promise<Response | undefined>;
} {
    const rows = new Map<string, AutomationDefinitionDetail>();
    const creates: Array<ReturnType<typeof AutomationDefinitionCreateRequestSchema.parse>> = [];
    const reconciles: Array<Readonly<{ automationId: string; input: ReturnType<typeof AutomationDefinitionReconcileRequestSchema.parse> }>> = [];
    let respond: ((method: string, input: unknown) => Response | undefined) | undefined;
    return {
        creates, reconciles, rows,
        respondWith(response: typeof respond) { respond = response; },
        clear() { rows.clear(); creates.length = 0; reconciles.length = 0; respond = undefined; },
        async handle(url: URL, init?: RequestInit): Promise<Response | undefined> {
            const method = init?.method ?? 'GET';
            const id = /^\/v3\/automations\/([^/]+)$/.exec(url.pathname)?.[1];
            if (url.pathname !== '/v3/automations' && !id) return undefined;
            if (method === 'GET') {
                if (id) return rows.has(id) ? Response.json(rows.get(id)) : Response.json({ error: 'not-found' }, { status: 404 });
                const filtered = [...rows.values()].filter(row => !url.searchParams.has('workflowDefinitionId')
                    || row.workflowDefinitionId === url.searchParams.get('workflowDefinitionId'));
                return Response.json({ automations: filtered.map(({ executionRecipe: _recipe, templateCiphertext: _template,
                    triggers, ...row }) => AutomationDefinitionListItemSchema.parse({ ...row,
                        triggers: triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger) })), nextCursor: null });
            }
            if (method === 'POST' && !id) {
                const created = AutomationDefinitionCreateRequestSchema.parse(JSON.parse(String(init?.body)));
                creates.push(created);
                const failure = respond?.(method, created);
                if (failure) return failure;
                const detail = AutomationDefinitionDetailSchema.parse({ id: created.automationId,
                    name: created.name, description: created.description ?? null, enabled: created.enabled,
                    workflowDefinitionId: created.workflowDefinitionId ?? null, scopeSessionId: created.scopeSessionId ?? null,
                    targetType: null, existingSessionId: null, templateVersion: created.executionRecipe.templateVersion,
                    lastRunAt: null, createdAt: 1, updatedAt: 1, executionRecipe: created.executionRecipe,
                    assignments: (created.assignments ?? []).map(row => ({ ...row, enabled: row.enabled ?? true, priority: row.priority ?? 0, updatedAt: 1 })),
                    triggers: created.triggers.map(row => AutomationTriggerDetailSchema.parse({ ...row.trigger, id: row.triggerId,
                        revision: 1, createdAt: 1, updatedAt: 1, nextRunAt: null, triggerDefinitionEnvelope: null })),
                });
                rows.set(detail.id, detail);
                return Response.json(detail);
            }
            if (method === 'PUT' && id) {
                const input = AutomationDefinitionReconcileRequestSchema.parse(JSON.parse(String(init?.body)));
                reconciles.push({ automationId: id, input });
                const failure = respond?.(method, input);
                if (failure) return failure;
                const current = rows.get(id);
                if (!current) return Response.json({ error: 'not-found' }, { status: 404 });
                if (current.templateVersion !== input.expectedTemplateVersion) return Response.json({ error: 'version-conflict' }, { status: 409 });
                const detail = AutomationDefinitionDetailSchema.parse({ ...current, name: input.name, description: input.description,
                    enabled: input.enabled, workflowDefinitionId: input.workflowDefinitionId ?? null,
                    scopeSessionId: input.scopeSessionId ?? null, templateVersion: current.templateVersion + 1,
                    executionRecipe: input.executionRecipe,
                    assignments: input.assignments.map(row => ({ ...row, enabled: row.enabled ?? true, priority: row.priority ?? 0, updatedAt: 1 })),
                    triggers: input.triggers.map(row => {
                        const saved = current.triggers.find(trigger => trigger.id === row.triggerId);
                        if (row.kind === 'new') return AutomationTriggerDetailSchema.parse({ ...row.trigger, id: row.triggerId,
                            revision: 1, createdAt: 1, updatedAt: 1, nextRunAt: null, triggerDefinitionEnvelope: null });
                        if (!saved) throw new Error('Automation fixture missing retained trigger');
                        return AutomationTriggerDetailSchema.parse({ ...saved, ...(row.trigger ?? {}),
                            ...(row.enabled === undefined ? {} : { enabled: row.enabled }),
                            revision: saved.revision + (row.trigger || row.enabled !== undefined ? 1 : 0) });
                    }),
                });
                rows.set(id, detail);
                return Response.json(detail);
            }
            return undefined;
        },
    };
}
