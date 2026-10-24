import { describe, expect, it } from 'vitest';

import {
  AgentModelOptionOverrideRuleReadSchema,
  AgentModelOptionOverrideRuleSchema,
  ProviderModelDescriptorV1Schema,
  resolveModelStructuredOutputSupport,
  resolveModelDisplayName,
  budgetInlineCompletionContext,
} from './descriptor.js';

describe('inline completion context budget', () => {
  it('keeps nearest complete Unicode characters within the declared byte-token budget', () => {
    const model = ProviderModelDescriptorV1Schema.parse({ id: 'base', name: 'Base', contextWindowTokens: 16,
      inlineCompletion: { operationId: 'fim', tokenAccounting: 'utf8-bytes', outputTokens: 4, promptOverheadTokens: 2 } });
    expect(budgetInlineCompletionContext(model, { prefix: 'distant🦊abc', suffix: 'def🦊distant' })).toEqual({ prefix: 'abc', suffix: 'def🦊' });
    expect(budgetInlineCompletionContext(model, { prefix: 'x', suffix: 'abcdefghijk' })).toEqual({ prefix: 'x', suffix: 'abcdefghi' });
    expect(budgetInlineCompletionContext({ id: 'unknown', name: 'Unknown' }, { prefix: 'secret', suffix: '' })).toBeNull();
  });
  it('budgets escaped chat context and refuses unknown output allowance and over-limit requests', () => {
    const model = ProviderModelDescriptorV1Schema.parse({ id: 'chat', name: 'Chat', contextWindowTokens: 16,
      inlineCompletion: { operationId: 'chat', tokenAccounting: 'utf8-bytes', outputTokens: 4, promptOverheadTokens: 2, maxOutputTokens: 4 } });
    const context = budgetInlineCompletionContext(model, { prefix: '\\"\n\t', suffix: '\\"\n\t' })!;
    const serializedBytes = new TextEncoder().encode(context.prefix).length + new TextEncoder().encode(context.suffix).length;
    expect(serializedBytes).toBeLessThanOrEqual(10);
    expect(budgetInlineCompletionContext(model, { prefix: 'valid', suffix: '' }, 5)).toBeNull();
    expect(budgetInlineCompletionContext({ ...model, inlineCompletion: { ...model.inlineCompletion!, outputTokens: undefined } }, { prefix: 'valid', suffix: '' })).toBeNull();
  });
});

describe('catalog model display names', () => {
  const catalog = [{ id: 'vendor-model', name: 'Vendor Model', aliases: ['vendor-model-snapshot'] }];

  it('reuses exact catalog names and declared snapshot aliases without changing ids or guessing unknown snapshots', () => {
    expect(resolveModelDisplayName({ id: 'vendor-model-snapshot', name: 'vendor-model-snapshot' }, catalog)).toBe('Vendor Model');
    expect(resolveModelDisplayName({ id: 'vendor-model' }, catalog)).toBe('Vendor Model');
    expect(resolveModelDisplayName({ id: 'vendor-model-20990101' }, catalog)).toBe('vendor-model-20990101');
    expect(resolveModelDisplayName({ id: 'vendor-model-snapshot', name: 'My deployment' }, catalog)).toBe('My deployment');
    expect(resolveModelDisplayName({ id: 'vendor-model-snapshot' }, [
      ...catalog, { id: 'other-model', name: 'Another model', aliases: ['vendor-model-snapshot'] },
    ])).toBe('vendor-model-snapshot');
  });
});

describe('structured model capability', () => {
  it('preserves an explicit unsupported JSON capability from a model catalog', () => {
    const model = { id: 'catalog-model', name: 'Catalog model', capabilities: { structuredOutput: 'unsupported' } };
    expect(ProviderModelDescriptorV1Schema.safeParse(model)).toMatchObject({ success: true, data: model });
  });
  it('never grants manual models support or overrides negative model evidence', () => {
    expect(resolveModelStructuredOutputSupport({ catalogModel: false, agentFormats: ['json'] })).toBe('unknown');
    expect(resolveModelStructuredOutputSupport({ catalogModel: true, agentFormats: ['json'], model: { capabilities: { structuredOutput: 'unsupported' } } })).toBe('unsupported');
    expect(resolveModelStructuredOutputSupport({ catalogModel: true, agentFormats: ['json'], model: { capabilities: { structuredOutput: 'unknown' } } })).toBe('unknown');
    expect(resolveModelStructuredOutputSupport({ catalogModel: true, agentFormats: ['json'] })).toBe('supported');
    expect(resolveModelStructuredOutputSupport({ catalogModel: true })).toBe('unknown');
  });
});

/**
 * `AgentModelOptionOverrideRuleSchema` is the canonical producer contract for the override rule,
 * and three downstream schemas derive their shape from it. Its bounds were only ever exercised
 * indirectly, from other packages, so loosening one here would have failed nothing. These tests
 * pin each bound at the owner.
 */
describe('AgentModelOptionOverrideRuleSchema', () => {
  const VALID = { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' };

  it('accepts the shape a producing agent is meant to author', () => {
    expect(AgentModelOptionOverrideRuleSchema.parse(VALID)).toEqual(VALID);
    expect(AgentModelOptionOverrideRuleSchema.parse({ optionIds: ['reasoning_effort'] }))
      .toEqual({ optionIds: ['reasoning_effort'] });
  });

  it('requires at least one option id and rejects a non-array', () => {
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: [] }).success).toBe(false);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: 'reasoning_effort' }).success).toBe(false);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ forcedValue: 'xhigh' }).success).toBe(false);
  });

  it('caps optionIds at 32 members', () => {
    const ids = (count: number) => Array.from({ length: count }, (_unused, index) => `option_${index}`);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ids(32) }).success).toBe(true);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ids(33) }).success).toBe(false);
  });

  it('caps each option id at 128 characters and rejects a blank one', () => {
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ['a'.repeat(128)] }).success).toBe(true);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ['a'.repeat(129)] }).success).toBe(false);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ['reasoning_effort', ''] }).success).toBe(false);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ['   '] }).success).toBe(false);
  });

  it('caps forcedValue at 256 characters and rejects a blank one', () => {
    const rule = (forcedValue: string) => ({ optionIds: ['reasoning_effort'], forcedValue });
    expect(AgentModelOptionOverrideRuleSchema.safeParse(rule('x'.repeat(256))).success).toBe(true);
    expect(AgentModelOptionOverrideRuleSchema.safeParse(rule('x'.repeat(257))).success).toBe(false);
    expect(AgentModelOptionOverrideRuleSchema.safeParse(rule('')).success).toBe(false);
  });

  it('is strict on the write side so a producer cannot author an undeclared field', () => {
    expect(AgentModelOptionOverrideRuleSchema.safeParse({
      optionIds: ['reasoning_effort'],
      futureProducerField: 1,
    }).success).toBe(false);
  });
});

/**
 * The read schema is the single owner of the unknown-key policy for an ALREADY-persisted rule.
 * It must share every bound with the strict producer contract — otherwise a reader could accept a
 * rule the strict owner-metadata envelope would refuse to persist — and diverge on exactly one
 * axis: an unrecognized nested key is stripped rather than rejected.
 */
describe('AgentModelOptionOverrideRuleReadSchema', () => {
  const CANDIDATE_RULES: readonly unknown[] = [
    { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' },
    { optionIds: ['reasoning_effort'] },
    { optionIds: Array.from({ length: 33 }, (_unused, index) => `option_${index}`) },
    { optionIds: ['a'.repeat(129)] },
    { optionIds: ['reasoning_effort', ''] },
    { optionIds: [] },
    { optionIds: ['reasoning_effort'], forcedValue: 'x'.repeat(257) },
    { optionIds: ['reasoning_effort'], forcedValue: '' },
    { optionIds: 'reasoning_effort' },
    {},
    null,
  ];

  it('agrees with the strict producer contract on every bound', () => {
    for (const candidate of CANDIDATE_RULES) {
      const strict = AgentModelOptionOverrideRuleSchema.safeParse(candidate);
      const read = AgentModelOptionOverrideRuleReadSchema.safeParse(candidate);
      expect(read.success, `acceptance disagreed for ${JSON.stringify(candidate)}`).toBe(strict.success);
      if (strict.success && read.success) expect(read.data).toEqual(strict.data);
    }
  });

  it('strips an unrecognized producer field instead of rejecting the whole rule', () => {
    const parsed = AgentModelOptionOverrideRuleReadSchema.safeParse({
      optionIds: ['reasoning_effort'],
      forcedValue: 'xhigh',
      futureProducerField: 1,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data)
      .toEqual({ optionIds: ['reasoning_effort'], forcedValue: 'xhigh' });
  });
});
