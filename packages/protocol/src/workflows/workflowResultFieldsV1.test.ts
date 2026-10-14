import { describe, expect, it } from 'vitest';

import { validateExecutionRunProfileResult } from '../execution/runs/resultContract.js';
import { WORKFLOW_STARTER_EXAMPLES_V1 } from './builtins/examples.js';
import {
  applyWorkflowDefinitionEditsV1,
  listWorkflowResultFieldConsumers,
  renameWorkflowResultField,
  walkWorkflowBlocks,
  type WorkflowDefinitionDraftV1,
} from './workflowDefinitionEditV1.js';
import {
  buildWorkflowResultFieldsContract,
  projectWorkflowResultFields,
  type WorkflowResultField,
} from './workflowResultFieldsV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import type { WorkflowResultContract } from './workflowV1.js';

const FIELDS: readonly WorkflowResultField[] = [
  {
    name: 'fixed',
    type: 'boolean',
    required: true,
    description: 'Whether the fix holds',
  },
  { name: 'notes', type: 'text', required: false },
  {
    name: 'severity',
    type: 'choice',
    required: true,
    choices: ['low', 'high'],
  },
  { name: 'confidence', type: 'number', required: false },
  { name: 'files', type: 'list', required: false, itemType: 'text' },
];

describe('named result fields (04 §6.1)', () => {
  it('round-trips every field type through the schema runtime validation reads', () => {
    const contract = buildWorkflowResultFieldsContract(FIELDS);
    expect(projectWorkflowResultFields(contract)).toEqual({
      kind: 'fields',
      fields: FIELDS,
      closed: true,
    });
    // The projection writes the subset runtime validation enforces: types, required, choices, closed object.
    expect(
      validateExecutionRunProfileResult(
        { fixed: true, severity: 'high', files: ['a.ts'] },
        contract,
      ).ok,
    ).toBe(true);
    expect(
      validateExecutionRunProfileResult(
        { fixed: 'yes', severity: 'high' },
        contract,
      ).ok,
    ).toBe(false);
    expect(
      validateExecutionRunProfileResult({ fixed: true }, contract).ok,
    ).toBe(false);
    expect(
      validateExecutionRunProfileResult(
        { fixed: true, severity: 'medium' },
        contract,
      ).ok,
    ).toBe(false);
    expect(
      validateExecutionRunProfileResult(
        { fixed: true, severity: 'low', extra: 1 },
        contract,
      ).ok,
    ).toBe(false);
    expect(
      validateExecutionRunProfileResult(
        { fixed: true, severity: 'low', files: [1] },
        contract,
      ).ok,
    ).toBe(false);
  });

  it('keeps an open loaded contract open and preserves titles exactly', () => {
    const open: WorkflowResultContract = {
      kind: 'json',
      schema: {
        type: 'object',
        properties: { verdict: { type: 'string', title: 'Verdict' } },
      },
    };
    const projection = projectWorkflowResultFields(open);
    expect(projection).toEqual({
      kind: 'fields',
      closed: false,
      fields: [
        { name: 'verdict', type: 'text', required: false, title: 'Verdict' },
      ],
    });
    if (projection.kind !== 'fields') throw new Error('unreachable');
    expect(
      buildWorkflowResultFieldsContract(projection.fields, {
        closed: projection.closed,
      }),
    ).toEqual(open);
  });

  it('projects every shipped example contract exactly, so their fields are editable without rewriting', () => {
    for (const example of WORKFLOW_STARTER_EXAMPLES_V1) {
      for (const block of walkWorkflowBlocks(example.definition.blocks)) {
        if (
          (block.kind !== 'step' && block.kind !== 'wait') ||
          block.result?.kind !== 'json'
        )
          continue;
        const projection = projectWorkflowResultFields(block.result);
        expect(projection.kind).toBe('fields');
        if (projection.kind !== 'fields') continue;
        expect(
          buildWorkflowResultFieldsContract(projection.fields, {
            closed: projection.closed,
          }),
        ).toEqual(block.result);
      }
    }
  });

  it.each<[string, WorkflowResultContract]>([
    [
      'integer',
      {
        kind: 'json',
        schema: { type: 'object', properties: { n: { type: 'integer' } } },
      },
    ],
    [
      'nested object',
      {
        kind: 'json',
        schema: { type: 'object', properties: { a: { type: 'object' } } },
      },
    ],
    [
      'bounds',
      {
        kind: 'json',
        schema: {
          type: 'object',
          properties: { a: { type: 'string', maxLength: 3 } },
        },
      },
    ],
    [
      'non-object root',
      { kind: 'json', schema: { type: 'array', items: { type: 'string' } } },
    ],
    [
      'composition',
      {
        kind: 'json',
        schema: { type: 'object', anyOf: [{ required: ['a'] }] },
      },
    ],
    [
      'typed additional properties',
      {
        kind: 'json',
        schema: { type: 'object', additionalProperties: { type: 'string' } },
      },
    ],
    [
      'list of objects',
      {
        kind: 'json',
        schema: {
          type: 'object',
          properties: { a: { type: 'array', items: { type: 'object' } } },
        },
      },
    ],
    [
      'required unknown name',
      {
        kind: 'json',
        schema: { type: 'object', properties: {}, required: ['ghost'] },
      },
    ],
  ])('leaves an advanced %s schema to its owner', (_label, contract) => {
    expect(projectWorkflowResultFields(contract)).toEqual({ kind: 'advanced' });
  });
});

/** The canonical validator over a draft; asserts it parsed, so an empty issue filter is never vacuous. */
function validateDraft(draft: WorkflowDefinitionDraftV1) {
  const { name: _name, ...definition } = draft;
  const result = validateWorkflowDefinition({ ...definition, version: 1 });
  expect(result.normalizedDefinition).toBeDefined();
  return result;
}

function releaseDraft(): WorkflowDefinitionDraftV1 {
  const check = {
    kind: 'result' as const,
    producer: { blockId: 'check', scope: { kind: 'current' as const } },
    path: ['fixed'],
  };
  return {
    name: 'Release',
    inputs: [],
    defaults: {},
    blocks: [
      {
        kind: 'step',
        id: 'check',
        name: 'Check the fix',
        document: { text: 'Check', references: [], attachments: [] },
        input: [],
        result: buildWorkflowResultFieldsContract(FIELDS),
      },
      {
        kind: 'if',
        id: 'gate',
        when: {
          kind: 'compare',
          operator: 'eq',
          left: check,
          right: { kind: 'literal', value: false },
        },
        then: [
          {
            kind: 'step',
            id: 'reopen',
            document: { text: 'Reopen', references: [], attachments: [] },
            input: [
              {
                ...check,
                producer: {
                  blockId: 'check',
                  scope: { kind: 'outer', levels: 1 },
                },
                path: ['notes'],
              },
              {
                ...check,
                producer: {
                  blockId: 'check',
                  scope: { kind: 'outer', levels: 1 },
                },
                path: ['fixed'],
              },
            ],
          },
        ],
        otherwise: [],
      },
    ],
    finalOutput: { ...check, path: ['fixed'] },
  } as WorkflowDefinitionDraftV1;
}

describe('result field consumers and rename-with-consumers', () => {
  it('lists every block and the final output that read a field', () => {
    const draft = releaseDraft();
    expect(listWorkflowResultFieldConsumers(draft, 'check', 'fixed')).toEqual([
      { blockId: 'gate' },
      { blockId: 'reopen' },
      { finalOutput: true },
    ]);
    expect(listWorkflowResultFieldConsumers(draft, 'check', 'notes')).toEqual([
      { blockId: 'reopen' },
    ]);
    expect(
      listWorkflowResultFieldConsumers(draft, 'check', 'severity'),
    ).toEqual([]);
  });

  it('renames the field and every consumer in one edit, through the shared Action grammar', () => {
    const draft = releaseDraft();
    const renamed = renameWorkflowResultField(
      draft,
      'check',
      'fixed',
      'passed',
    );
    const viaAction = applyWorkflowDefinitionEditsV1(draft, [
      {
        kind: 'rename_result_field',
        blockId: 'check',
        from: 'fixed',
        to: 'passed',
      },
    ]);
    expect(viaAction).toMatchObject({ ok: true, draft: renamed });
    expect(listWorkflowResultFieldConsumers(renamed, 'check', 'fixed')).toEqual(
      [],
    );
    expect(
      listWorkflowResultFieldConsumers(renamed, 'check', 'passed'),
    ).toHaveLength(3);
    const producer = renamed.blocks[0]!;
    expect(
      producer.kind === 'step'
        ? projectWorkflowResultFields(producer.result)
        : null,
    ).toMatchObject({
      kind: 'fields',
      fields: [
        { name: 'passed', type: 'boolean', required: true },
        { name: 'notes' },
        { name: 'severity' },
        { name: 'confidence' },
        { name: 'files' },
      ],
    });
    // The untouched consumer of another field keeps its identity.
    expect(listWorkflowResultFieldConsumers(renamed, 'check', 'notes')).toEqual(
      [{ blockId: 'reopen' }],
    );
    expect(
      validateDraft(renamed).issues.filter(
        (entry) => entry.code === 'missing_reference',
      ),
    ).toEqual([]);
  });

  it('refuses a rename onto an existing field or of an absent one', () => {
    const draft = releaseDraft();
    expect(renameWorkflowResultField(draft, 'check', 'fixed', 'notes')).toBe(
      draft,
    );
    expect(renameWorkflowResultField(draft, 'check', 'ghost', 'other')).toBe(
      draft,
    );
    expect(
      applyWorkflowDefinitionEditsV1(draft, [
        {
          kind: 'rename_result_field',
          blockId: 'check',
          from: 'fixed',
          to: 'notes',
        },
      ]),
    ).toEqual({ ok: false, issue: { opIndex: 0, code: 'invalid_target' } });
  });

  it('flags a reference to a field a closed result no longer declares, so removal is repairable', () => {
    const draft = releaseDraft();
    const producer = draft.blocks[0]!;
    if (producer.kind !== 'step') throw new Error('unreachable');
    const removed: WorkflowDefinitionDraftV1 = {
      ...draft,
      blocks: [
        {
          ...producer,
          result: buildWorkflowResultFieldsContract(
            FIELDS.filter((field) => field.name !== 'notes'),
          ),
        },
        draft.blocks[1]!,
      ],
    };
    const issues = validateDraft(removed).issues.filter(
      (entry) => entry.code === 'missing_reference',
    );
    expect(issues).toEqual([
      expect.objectContaining({
        blockId: 'reopen',
        path: expect.stringMatching(/input\/0\/path\/0$/u),
      }),
    ]);
    // An open contract declares no closed set: other names stay valid.
    const open: WorkflowDefinitionDraftV1 = {
      ...removed,
      blocks: [
        {
          ...producer,
          result: buildWorkflowResultFieldsContract(
            FIELDS.filter((field) => field.name !== 'notes'),
            { closed: false },
          ),
        },
        draft.blocks[1]!,
      ],
    };
    expect(
      validateDraft(open).issues.filter(
        (entry) => entry.code === 'missing_reference',
      ),
    ).toEqual([]);
  });
});
