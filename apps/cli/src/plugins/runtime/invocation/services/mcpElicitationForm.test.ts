import { describe, expect, it } from 'vitest';
import { InteractionTransientAuthorRequestV1Schema } from '@happier-dev/protocol';

import {
  mcpElicitationFormContent,
  mcpElicitationFormQuestions,
  mcpElicitationFormRequest,
  parseAcpElicitationFormSchema,
  parseMcpElicitationFormSchema,
} from './mcpElicitationForm';

describe('mcpElicitationForm', () => {
  it('preserves option descriptions, string defaults, and single-question message fallback', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        value: {
          type: 'string',
          default: 'approve',
          oneOf: [
            {
              const: 'approve',
              title: 'Approve plan',
              description: 'Exit plan mode and execute the plan',
            },
            {
              const: 'refine',
              title: 'Refine plan',
              description: 'Stay in plan mode and iterate',
            },
          ],
        },
      },
      required: ['value'],
    });

    const request = mcpElicitationFormRequest(schema, 'Approve plan ready at plan://session/plan.md?');
    expect(request.kind).toBe('questions');
    const questions = request.kind === 'questions' ? request.questions : [];

    expect(questions).toEqual([
      {
        id: 'value',
        prompt: 'Approve plan ready at plan://session/plan.md?',
        type: 'singleChoice',
        required: true,
        choices: [
          {
            id: 'approve',
            label: 'Approve plan',
            description: 'Exit plan mode and execute the plan',
          },
          {
            id: 'refine',
            label: 'Refine plan',
            description: 'Stay in plan mode and iterate',
          },
        ],
      },
    ]);

    const textSchema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        notes: {
          type: 'string',
          default: 'Initial draft',
        },
      },
      required: ['notes'],
    });
    expect(
      mcpElicitationFormRequest(textSchema, 'Provide notes:'),
    ).toEqual({ kind: 'questions', questions: [
      {
        id: 'notes',
        prompt: 'Provide notes:',
        type: 'text',
        required: true,
        initialValue: 'Initial draft',
      },
    ] });
  });

  it('collapses companion __other fields into allowCustom choice questions and maps custom answers back to __other', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          title: 'Target scope',
          oneOf: [
            { const: 'cli', title: 'CLI', description: 'Command line package' },
            { const: 'ui', title: 'UI', description: 'Expo UI package' },
            { const: 'Other (type your own)', title: 'Other (type your own)' },
          ],
        },
        scope__other: {
          type: 'string',
          title: 'Other (type your own)',
        },
        tags: {
          type: 'array',
          title: 'Select tags',
          items: {
            type: 'string',
            anyOf: [
              { const: 'acp', title: 'ACP', description: 'Agent Client Protocol' },
              { const: 'mcp', title: 'MCP', description: 'Model Context Protocol' },
              { const: 'Other (type your own)', title: 'Other (type your own)' },
            ],
          },
        },
        tags__other: {
          type: 'string',
          title: 'Other (type your own)',
        },
      },
      required: ['scope', 'tags'],
    });

    const questions = mcpElicitationFormQuestions(schema);
    expect(questions).toEqual([
      {
        id: 'scope',
        prompt: 'Target scope',
        type: 'singleChoice',
        required: true,
        allowCustom: true,
        choices: [
          { id: 'cli', label: 'CLI', description: 'Command line package' },
          { id: 'ui', label: 'UI', description: 'Expo UI package' },
        ],
      },
      {
        id: 'tags',
        prompt: 'Select tags',
        type: 'multipleChoice',
        required: true,
        allowCustom: true,
        choices: [
          { id: 'acp', label: 'ACP', description: 'Agent Client Protocol' },
          { id: 'mcp', label: 'MCP', description: 'Model Context Protocol' },
        ],
      },
    ]);

    const content = mcpElicitationFormContent(schema, {
      scope: {
        kind: 'singleChoice',
        answer: { kind: 'custom', value: 'Custom scope' },
      },
      tags: {
        kind: 'multipleChoice',
        answers: [
          { kind: 'choice', choiceId: 'acp' },
          { kind: 'custom', value: 'Custom tag' },
        ],
      },
    });

    expect(content).toEqual({
      scope: 'Other (type your own)',
      scope__other: 'Custom scope',
      tags: ['acp', 'Other (type your own)'],
      tags__other: 'Custom tag',
    });
  });

  it('matches lower-case choice IDs for "other" companion fields and retains the choice ID', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          title: 'Selection',
          oneOf: [
            { const: 'first', title: 'First option' },
            { const: 'other', title: 'Other' },
          ],
        },
        choice__other: {
          type: 'string',
          title: 'Other',
        },
      },
      required: ['choice'],
    });

    const questions = mcpElicitationFormQuestions(schema);
    expect(questions).toEqual([
      {
        id: 'choice',
        prompt: 'Selection',
        type: 'singleChoice',
        required: true,
        allowCustom: true,
        choices: [
          { id: 'first', label: 'First option' },
        ],
      },
    ]);

    const content = mcpElicitationFormContent(schema, {
      choice: {
        kind: 'singleChoice',
        answer: { kind: 'custom', value: 'My custom response' },
      },
    });

    expect(content).toEqual({
      choice: 'other',
      choice__other: 'My custom response',
    });
  });

  it('does not collapse companion __other if the base property is required and has no matching other choice', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          title: 'Selection',
          oneOf: [
            { const: 'first', title: 'First option' },
            { const: 'second', title: 'Second option' },
          ],
        },
        choice__other: {
          type: 'string',
          title: 'Additional details',
        },
      },
      required: ['choice'],
    });

    const questions = mcpElicitationFormQuestions(schema);
    // Both properties must remain separate so the required 'choice' field is not dropped on custom input
    expect(questions).toHaveLength(2);
    expect(questions?.map((q) => q.id)).toEqual(['choice', 'choice__other']);
  });

  it('preserves ordinary Custom options when the provider has a separate Other input', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        q0: { type: 'string', oneOf: [
          { const: 'Standard', title: 'Standard' },
          { const: 'Custom', title: 'Custom' },
        ] },
        q0__other: { type: 'string', title: 'Other (type your own)' },
      },
    });
    expect(mcpElicitationFormQuestions(schema)).toMatchObject([
      { id: 'q0', allowCustom: true, choices: [{ id: 'Standard' }, { id: 'Custom' }] },
    ]);
    expect(mcpElicitationFormContent(schema, {
      q0: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'Custom' } },
    })).toEqual({ q0: 'Custom' });
    expect(mcpElicitationFormContent(schema, {
      q0: { kind: 'singleChoice', answer: { kind: 'custom', value: 'An independent answer' } },
    })).toEqual({ q0__other: 'An independent answer' });
  });

  it('does not infer a sentinel when the companion title matches more than one choice', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        choice: { type: 'string', oneOf: [
          { const: 'first', title: 'Other' },
          { const: 'second', title: 'Other' },
        ] },
        choice__other: { type: 'string', title: 'Other' },
      },
      required: ['choice'],
    });
    expect(mcpElicitationFormQuestions(schema)?.map((question) => question.id)).toEqual(['choice', 'choice__other']);
  });

  it('preserves plan summaries exceeding 512 code points when property has its own title', () => {
    const longPlan = `### Plan Steps\n\n${'- Step description in detail with reasoning.\n'.repeat(15)}`;
    expect(Array.from(longPlan).length).toBeGreaterThan(512);

    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          title: 'Decision',
          oneOf: [
            { const: 'approve', title: 'Approve' },
            { const: 'refine', title: 'Refine' },
          ],
        },
      },
      required: ['decision'],
    });

    const request = mcpElicitationFormRequest(schema, longPlan);
    const questions = request.kind === 'questions' ? request.questions : [];
    expect(questions).toHaveLength(1);
    expect(questions![0].prompt).toContain(longPlan.trim());
    expect(questions![0].prompt).toContain('Decision');
  });

  it('bounds long prompts to MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1 (4,096 code points)', () => {
    const hugePlan = 'Very detailed plan text line.\n'.repeat(300); // ~9,000 characters
    expect(Array.from(hugePlan).length).toBeGreaterThan(4_096);

    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          oneOf: [
            { const: 'approve', title: 'Approve' },
            { const: 'refine', title: 'Refine' },
          ],
        },
      },
      required: ['decision'],
    });

    const request = mcpElicitationFormRequest(schema, hugePlan);
    const questions = request.kind === 'questions' ? request.questions : [];
    expect(questions).toHaveLength(1);
    expect(Array.from(questions![0].prompt).length).toBeLessThanOrEqual(4_096);
    expect(questions![0].prompt).toContain('... [truncated]');
  });

  it('returns null for empty-property confirmation schemas', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {},
    });
    expect(mcpElicitationFormQuestions(schema)).toBeNull();
    expect(mcpElicitationFormRequest(schema, 'Confirm?')).toEqual({
      kind: 'confirmation', title: 'Confirmation', message: 'Confirm?',
    });
  });

  it('keeps a required companion field independently answerable for regular choices', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        choice: { type: 'string', enum: ['first', 'other'] },
        choice__other: { type: 'string', title: 'Other' },
      },
      required: ['choice', 'choice__other'],
    });
    expect(mcpElicitationFormQuestions(schema)?.map((question) => question.id)).toEqual(['choice', 'choice__other']);
    expect(mcpElicitationFormContent(schema, {
      choice: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'first' } },
      choice__other: { kind: 'text', value: 'Required details' },
    })).toEqual({ choice: 'first', choice__other: 'Required details' });
  });

  it('translates ACP nullable schema fields while preserving strict MCP validation', () => {
    const schema = parseAcpElicitationFormSchema({
      type: 'object',
      required: null,
      properties: {
        decision: { type: 'string', minLength: null, maxLength: null, enum: null, oneOf: [
          { const: 'approve', title: 'Approve', description: 'Execute the plan' },
          { const: 'refine', title: 'Refine' },
        ] },
        tags: { type: 'array', minItems: null, maxItems: null, items: { type: 'string', enum: ['cli', 'ui'] } },
      },
    });
    expect(mcpElicitationFormQuestions(schema)).toMatchObject([
      { id: 'decision', type: 'singleChoice', required: false, choices: [
        { id: 'approve', description: 'Execute the plan' }, { id: 'refine' },
      ] },
      { id: 'tags', type: 'multipleChoice', choices: [{ id: 'cli' }, { id: 'ui' }] },
    ]);
    expect(() => parseMcpElicitationFormSchema({ type: 'object', properties: {}, required: null })).toThrow();
  });

  it('retains the actual question when the shared context exceeds the prompt budget', () => {
    const schema = parseMcpElicitationFormSchema({ type: 'object', properties: {
      decision: { type: 'string', title: 'Approve deployment to production?', enum: ['approve', 'refine'] },
      notes: { type: 'string', title: 'Additional instructions' },
    } });
    const request = mcpElicitationFormRequest(schema, 'Plan detail. '.repeat(1_000));
    expect(request.kind).toBe('questions');
    if (request.kind !== 'questions') throw new Error('Expected questions');
    expect(request.questions[0].prompt).toContain('Approve deployment to production?');
    expect(request.questions[0].prompt).toContain('Plan detail.');
    expect(request.questions[0].prompt).toContain('... [truncated]');
    expect(Array.from(request.questions[0].prompt).length).toBeLessThanOrEqual(4_096);
    expect(request.questions[1].prompt).toBe('Additional instructions');
    expect(InteractionTransientAuthorRequestV1Schema.safeParse(request).success).toBe(true);
  });

  it('bounds confirmation context and retains regular boolean, text, and choice answers', () => {
    const confirmation = mcpElicitationFormRequest(parseMcpElicitationFormSchema({ type: 'object', properties: {} }), 'Details. '.repeat(1_000));
    expect(confirmation.kind).toBe('confirmation');
    if (confirmation.kind !== 'confirmation') throw new Error('Expected confirmation');
    expect(Array.from(confirmation.message).length).toBeLessThanOrEqual(4_096);
    expect(confirmation.message).toContain('... [truncated]');
    expect(InteractionTransientAuthorRequestV1Schema.safeParse(confirmation).success).toBe(true);
    const schema = parseMcpElicitationFormSchema({ type: 'object', properties: {
      enabled: { type: 'boolean' }, notes: { type: 'string', default: 'Existing notes' }, choice: { type: 'string', enum: ['a', 'b'] },
    } });
    expect(mcpElicitationFormContent(schema, {
      enabled: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'false' } },
      notes: { kind: 'text', value: 'New notes' },
      choice: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'b' } },
    })).toEqual({ enabled: false, notes: 'New notes', choice: 'b' });
  });
});
