import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { getActionSpec, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { listWorkflowStepActionSpecs } from './workflowActionCatalog';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';

describe('workflow executing-machine Action catalog', () => {
    it('carries the shared trigger-list union fields into Action steps without losing required inputs', () => {
        const step = listWorkflowStepActionSpecs().find(spec => spec.id === 'workflow.trigger.list');
        expect(step).toBeDefined();
        const input = { workflow: 'builtin:keep-going' };
        const fields = resolveEffectiveActionInputFields(step!, input);
        expect(fields.find(field => field.path === 'workflow'))
            .toMatchObject({ required: true, optionsSourceId: 'workflows.references.available' });
        const candidate = Object.fromEntries(fields.flatMap(field => field.path in input
            ? [[field.path, input[field.path as keyof typeof input]]] : []));
        expect(getActionSpec('workflow.trigger.list').inputSchema.parse(candidate)).toEqual(input);
        expect(resolveEffectiveActionInputFields(step!, { scope: 'account_all' })
            .find(field => field.path === 'workflow')?.required).toBe(false);
    });
    it('localizes declared host setup prompts without rewriting plugin-authored questions or noun titles', async () => {
        const previousLanguage = getPreferredLanguage();
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('fr');
        try {
            const action = { id: 'example.tools/select', pluginId: 'example.tools', occurrenceId: 'occurrence-a',
                title: 'Select', scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' },
                dangerLevel: 'safe', available: true,
                inputHints: { fields: [{ path: 'project', title: 'Plugin project', prompt: 'Which project?', widget: 'text' }] } };
            const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, actionsById: { [action.id]: action } });
            const specs = listWorkflowStepActionSpecs(projection);
            expect(specs.find(spec => spec.id === 'projects.context.update')?.inputHints?.fields.find(field => field.path === 'target'))
                .toMatchObject({ title: 'Qualified Project', prompt: t('widgetAdd.prompts.project') });
            expect(specs.find(spec => spec.id === 'example.tools/actions/select')?.inputHints?.fields[0])
                .toMatchObject({ title: 'Plugin project', prompt: 'Which project?' });
        } finally {
            setPreferredLanguageFromSettings(previousLanguage);
        }
    });
    it('offers host Actions by their execution-placement metadata, excluding client UI and composition controls', () => {
        const specs = listWorkflowStepActionSpecs();
        const eligible = listActionSpecs().filter((spec) => spec.surfaces.agent
            && spec.executionPlacement !== 'client' && !spec.id.startsWith('workflow.run.'));
        expect(specs.map((spec) => spec.id).sort()).toEqual(eligible.map((spec) => spec.id).sort());
        expect(specs.slice(0, 2).map(spec => spec.id)).toEqual(['notifications.notify_me', 'review.start']);
        expect(specs.some((spec) => spec.id === 'notifications.notify_me')).toBe(true);
        expect(specs.some((spec) => spec.id === 'session.terminals.open')).toBe(false);
        expect(specs.find((spec) => spec.id === 'artifact.create')?.title).toBe('Create a document');
        expect(specs.find((spec) => spec.id === 'session.role.set')?.title).toBe('Set a session’s role');
        expect(specs.filter((spec) => spec.title === 'Action').map((spec) => spec.id),
            'Every offered Action needs a human catalog title').toEqual([]);
    });

    it('includes daemon plugin Actions with canonical qualified ids and excludes unavailable/client-only Actions', () => {
        const action = { id: 'example.tools/summarize', pluginId: 'example.tools', occurrenceId: 'occurrence-a',
            title: 'Summarize', scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' },
            dangerLevel: 'safe', available: true,
            inputHints: { fields: [{ path: 'topic', title: 'Topic', widget: 'text', required: true }] } };
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, actionsById: {
            [action.id]: action,
            'example.tools/missing': { ...action, id: 'example.tools/missing', available: false },
            'example.tools/ui-only': { ...action, id: 'example.tools/ui-only', surfaces: ['ui'] },
            'example.tools/client-only': { ...action, id: 'example.tools/client-only',
                execution: { target: 'client', client: { artifactId: 'client', exportName: 'activate' }, platforms: ['web'] } },
        } });
        const specs = listWorkflowStepActionSpecs(projection);
        expect(specs.find((spec) => spec.id === 'example.tools/actions/summarize')).toMatchObject({
            title: 'Summarize', plugin: { id: 'example.tools' }, inputHints: { fields: [{ path: 'topic', required: true }] },
        });
        expect(specs.some((spec) => ['example.tools/actions/missing', 'example.tools/actions/ui-only',
            'example.tools/actions/client-only'].includes(spec.id))).toBe(false);
        expect(specs.some((spec) => spec.id === 'review.start')).toBe(true);
        expect(specs.some((spec) => spec.id.startsWith('workflow.run.'))).toBe(false);
    });
});
