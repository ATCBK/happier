import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactTestInstance } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowCondition, WorkflowReferenceScope, WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { setWorkflowInputs } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
// Load the real owner during collection, not against the first interaction's timeout.
import { formatWorkflowValueReference, WorkflowBindingRow, WorkflowStepDataEditor, WorkflowValueReferenceEditor } from './WorkflowStepDataEditor';
import { formatWorkflowConditionSentence, WorkflowConditionEditor } from './WorkflowConditionEditor';
import { formatWorkflowLoopSentence } from './WorkflowLoopEditor';
import { getBuiltinWorkflowCatalogV1 } from '@happier-dev/protocol';
import { buildWorkflowEditorDraftFromDefinition } from '@/sync/domains/workflows/workflowAuthoring';

/**
 * Where a binding's value comes from, which workflow input it reads and which step produces it
 * are each one labelled field select (07 §3 control table): a reader hears the set by its name
 * and its current value, and every valid choice is offered with the current one selected.
 */

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const { workflowFieldTranslations } = await import('@/text/translations/workflowFieldTranslations');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            const field = Object.entries(workflowFieldTranslations.en).find(([name]) => key === `workflows.page.fields.${name}`);
            return field?.[1] ?? (params ? `${key}:${JSON.stringify(params)}` : key);
        },
    });
});

afterEach(async () => {
    await standardCleanup();
});

function stepBlock(id: string, input: WorkflowStep['input']): WorkflowStep {
    return {
        kind: 'step',
        id,
        document: { text: '', references: [], attachments: [] },
        input,
        result: { kind: 'text' },
    };
}

async function renderEditor(draft: unknown, step: WorkflowStep) {
    return renderScreen(
        <WorkflowStepDataEditor
            draft={draft as Parameters<typeof WorkflowStepDataEditor>['0']['draft']}
            step={step}
            onChangeInput={() => {}}
            testIDPrefix="editor"
        />,
    );
}

type FieldSelect = Readonly<{
    props: Readonly<{ items: ReadonlyArray<Readonly<{ id: string; title: string }>>; selectedId: string | null; onSelect: (id: string) => void }>;
}>;

function fieldSelect(root: ReactTestInstance, testID: string): FieldSelect {
    const match = root.findAll((node) => node.props?.testID === testID && typeof node.props?.onSelect === 'function')[0];
    if (match === undefined) throw new Error(`No field select ${testID}`);
    return match as unknown as FieldSelect;
}

function selectTrigger(root: ReactTestInstance, testID: string): ReactTestInstance {
    const match = root.findAll((node) => typeof node.type === 'string' && node.props?.testID === `${testID}-trigger`)[0];
    if (match === undefined) throw new Error(`No trigger for ${testID}`);
    return match;
}

describe('WorkflowStepDataEditor field selects', () => {
    it('shows and edits an input field path without losing it when selecting another input', async () => {
        const draft = setWorkflowInputs(createWorkflowEditorDraft({ draftId: 'input-path' }), [
            { name: 'reviewSession', valueType: 'json', required: true },
            { name: 'otherSession', valueType: 'json', required: true },
        ]);
        let current: WorkflowValueReference = { kind: 'input', name: 'reviewSession', path: ['sessionId'] };
        function Editor() {
            const [reference, setReference] = React.useState(current);
            current = reference;
            return <WorkflowValueReferenceEditor reference={reference} index={0} draft={draft} stepId={draft.blocks[0]!.id}
                onChange={setReference} testIDPrefix="input-path" />;
        }
        expect(formatWorkflowValueReference(draft, current)).not.toBe(
            formatWorkflowValueReference(draft, { kind: 'input', name: 'reviewSession' }));
        const screen = await renderScreen(<Editor />);
        expect(screen.findByTestId('input-path-input-0-path')?.props.value).toBe('sessionId');
        await act(async () => { screen.changeTextByTestId('input-path-input-0-path', 'targets.0.sessionId'); });
        expect(current).toEqual({ kind: 'input', name: 'reviewSession', path: ['targets', 0, 'sessionId'] });
        await act(async () => { fieldSelect(screen.root, 'input-path-input-0-input-name').props.onSelect('otherSession'); });
        expect(current).toEqual({ kind: 'input', name: 'otherSession', path: ['targets', 0, 'sessionId'] });
    });
    it('preserves a named result operand when changing between existence, comparison and negation', async () => {
        const reference: WorkflowValueReference = { kind: 'result', producer: { blockId: 'check', scope: { kind: 'current' } }, path: ['fixed'] };
        const producer = stepBlock('check', []);
        const draft = createWorkflowEditorDraft({ draftId: 'conditions', blocks: [producer] });
        let current: WorkflowCondition | undefined;
        function Editor() {
            const [condition, setCondition] = React.useState<WorkflowCondition | undefined>({ kind: 'exists', value: reference });
            current = condition;
            return <WorkflowConditionEditor label="If" condition={condition} draft={draft} consumerBlockId="if"
                onChange={setCondition} testIDPrefix="condition" required />;
        }
        const screen = await renderScreen(<Editor />);
        const changeKind = async (kind: string) => {
            await act(async () => fieldSelect(screen.root, 'condition-kind').props.onSelect(kind));
        };
        await changeKind('compare');
        expect(current).toEqual({ kind: 'compare', operator: 'eq', left: reference, right: { kind: 'literal', value: true } });
        await act(async () => fieldSelect(screen.root, 'condition-operator').props.onSelect('neq'));
        expect(current).toMatchObject({ operator: 'neq', left: reference });
        await changeKind('not');
        expect(current).toMatchObject({ kind: 'not', condition: { kind: 'compare', operator: 'neq', left: reference } });
        await changeKind('compare');
        expect(current).toMatchObject({ kind: 'compare', operator: 'neq', left: reference });
        await changeKind('exists');
        expect(current).toEqual({ kind: 'exists', value: reference });
    });
    it('reads human input and result field names without leaking wire keys or clipped prompt titles', () => {
        const producer = stepBlock('opaque-producer', []);
        const draft = createWorkflowEditorDraft({ draftId: 'human-references', name: 'Review', blocks: [producer] });
        expect(formatWorkflowValueReference(draft, { kind: 'input', name: 'sessionId' })).not.toContain('sessionId');
        expect(formatWorkflowValueReference(draft, { kind: 'result', producer: { blockId: producer.id, scope: { kind: 'current' } }, path: ['expectedServerRevision'] }))
            .not.toContain('expectedServerRevision');
        expect(formatWorkflowValueReference(draft, { kind: 'literal', value: { sessionId: 'bound session' } })).not.toContain('sessionId');
    });
    it('reads a result from an enclosing list by its step alone, keeping only the previous-round scope (DESIGN-13)', () => {
        const producer = stepBlock('gather', []);
        const draft = createWorkflowEditorDraft({ draftId: 'scoped-references', name: 'Release', blocks: [producer] });
        const read = (scope: WorkflowReferenceScope) =>
            formatWorkflowValueReference(draft, { kind: 'result', producer: { blockId: producer.id, scope }, path: ['issues'] });
        // "Gather changes · Issues", lab E1: a step name already names one step; "Parent scope" is structure, not meaning.
        expect(read({ kind: 'outer', levels: 1 })).toBe(read({ kind: 'current' }));
        expect(read({ kind: 'outer', levels: 2 })).toBe(read({ kind: 'current' }));
        // The previous round is a different value of the same step, so it keeps its words.
        expect(read({ kind: 'previous_iteration', loopBlockId: 'rounds' })).toContain('workflows.input.scopePreviousIteration');
    });
    it('reads declared execution values as words without rewriting arbitrary authored strings', () => {
        const draft = createWorkflowEditorDraft({ draftId: 'execution-values', name: 'Plan' });
        expect(formatWorkflowValueReference(draft, { kind: 'literal', value: { kind: 'detached' } }, 'target'))
            .toBe('workflows.page.sections.aBackgroundRun');
        expect(formatWorkflowValueReference(draft, { kind: 'literal', value: 'read_only' }, 'permissionMode'))
            .toBe('executionRuns.newRun.permissionModes.readOnly');
        expect(formatWorkflowValueReference(draft, { kind: 'literal', value: 'read_only' }))
            .toBe('“read_only”');
        expect(formatWorkflowValueReference(draft, { kind: 'literal', value: 'custom permission' }, 'permissionMode'))
            .toBe('“custom permission”');
        expect(formatWorkflowValueReference(draft, { kind: 'literal', value: { kind: 'detached', note: 'Keep this' } }, 'target'))
            .toContain('Keep this');
    });
    it('reads every reference kind without a wire-object fallback and labels unavailable values', () => {
        const draft = createWorkflowEditorDraft({ draftId: 'references', name: 'Review' });
        const producer = { blockId: draft.blocks[0]!.id, scope: { kind: 'outer', levels: 1 } } as const;
        const references: WorkflowValueReference[] = [
            { kind: 'literal', value: { kind: 'exhausted', rounds: 3 } },
            { kind: 'input', name: 'files' }, { kind: 'result', producer, path: ['verdict'] },
            { kind: 'loop_trailing_count', producer, path: ['verdict'], equals: true },
            { kind: 'workspace', producer, field: 'checkoutRootPath' },
            { kind: 'item', field: 'value', path: ['name'] }, { kind: 'iteration', field: 'stopReason' },
            { kind: 'session_context', recentTurns: 2 }, { kind: 'session_context_field', field: 'goal.tokenBudget' },
        ];
        for (const reference of references) expect(formatWorkflowValueReference(draft, reference)).not.toContain('"kind"');
        expect(formatWorkflowValueReference(draft, references[4]!)).toContain('workflows.input.checkoutRoot');
        // External/future values may be unavailable to this reader; never expose their native bag.
        expect(formatWorkflowValueReference(draft, { kind: 'future', data: { secret: 'hidden' } } as unknown as WorkflowValueReference)).toBe('workflows.input.unavailableValue');
    });
    it('reads builtin loop conditions as human reference labels, including typed stop reasons', () => {
        const definition = getBuiltinWorkflowCatalogV1().find(entry => entry.id === 'builtin:keep-going')!.definition;
        const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'keep-going', name: 'Keep going', definition });
        const loop = draft.blocks[0]!;
        const condition = draft.blocks[1]!;
        if (loop.kind !== 'loop' || condition.kind !== 'if') throw new Error('Invalid builtin fixture');
        const label = formatWorkflowConditionSentence(draft, condition.when);
        expect(label).not.toContain('"kind"');
        // "Keep going until done stopped because …" — the stop condition read as itself (DESIGN-5 M4).
        expect(label).toContain('workflows.condition.loopStoppedBecause');
        expect(formatWorkflowLoopSentence(draft, loop)).toContain('workflows.input.tokensUsed');
        expect(formatWorkflowValueReference(draft, { kind: 'iteration', field: 'position' })).toBe('workflows.input.iterationField.position');
        expect(formatWorkflowValueReference(draft, { kind: 'session_context', recentTurns: 1 })).toContain('workflows.input.sessionContext');
    });
    it('offers where a value comes from as one labelled select with the current kind selected', async () => {
        const step = stepBlock('step-a', [{ kind: 'literal', value: '' }]);
        const draft = createWorkflowEditorDraft({ draftId: 'draft-1', name: 'Review', blocks: [step] });
        const changes: unknown[] = [];
        const screen = await renderScreen(
            <WorkflowStepDataEditor
                draft={draft as Parameters<typeof WorkflowStepDataEditor>['0']['draft']}
                step={step}
                onChangeInput={(next) => changes.push(next)}
                testIDPrefix="editor"
            />,
        );

        const select = fieldSelect(screen.root, 'editor-step-step-a-input-0-kind');
        expect(select.props.selectedId).toBe('literal');
        expect(select.props.items.map((item) => item.id)).toEqual(['literal', 'input', 'result', 'workspace']);
        expect(selectTrigger(screen.root, 'editor-step-step-a-input-0-kind').props.accessibilityLabel)
            .toBe('workflows.input.valueKindGroup: workflows.condition.valuePlaceholder');
        await act(async () => { select.props.onSelect('input'); });
        expect(changes.at(-1)).toEqual([{ kind: 'input', name: 'input' }]);
    });

    it('offers which workflow input it reads as one select with the current input selected', async () => {
        const step = stepBlock('step-a', [{ kind: 'input', name: 'tone' }]);
        const draft = setWorkflowInputs(
            createWorkflowEditorDraft({ draftId: 'draft-1', name: 'Review', blocks: [step] }),
            [
                { name: 'topic', valueType: 'string', required: false },
                { name: 'tone', valueType: 'string', required: false },
            ],
        );

        const screen = await renderEditor(draft, step);

        const select = fieldSelect(screen.root, 'editor-step-step-a-input-0-input-name');
        expect(select.props.items.map((item) => item.id)).toEqual(['topic', 'tone']);
        expect(select.props.selectedId).toBe('tone');
    });

    it('offers which step produces it as one select naming each step and its scope', async () => {
        const producer = stepBlock('producer-a', []);
        const step = stepBlock('step-a', [
            { kind: 'result', producer: { blockId: 'producer-a', scope: { kind: 'current' } }, path: [] },
        ]);
        const draft = createWorkflowEditorDraft({
            draftId: 'draft-1',
            name: 'Review',
            blocks: [producer, step],
        });

        const screen = await renderEditor(draft, step);

        const select = fieldSelect(screen.root, 'editor-step-step-a-input-0-producer');
        expect(select.props.items).toEqual([
            expect.objectContaining({ id: 'producer-a:current', title: 'workflows.editor.addStep', subtitle: 'workflows.input.scopeCurrent' }),
        ]);
        expect(select.props.selectedId).toBe('producer-a:current');
    });
});

describe('WorkflowBindingRow help (DESIGN-13)', () => {
    it('keeps a field\'s binding note out of a resting card and shows it while the step is edited', async () => {
        const draft = createWorkflowEditorDraft({ draftId: 'note' });
        const row = (editing: boolean) => (
            <WorkflowBindingRow label="Command" note="Values go in as environment variables." binding={{ kind: 'literal', value: 'yarn test' }}
                draft={draft} editable editing={editing} onEdit={() => {}} renderEditor={() => null} testID="row" />
        );
        const resting = await renderScreen(row(false));
        expect(resting.findByTestId('row-note')).toBeNull();
        expect(resting.getTextContent()).not.toContain('Values go in as environment variables.');
        const editing = await renderScreen(row(true));
        expect(editing.findByTestId('row-note')).not.toBeNull();
    });
});
