import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import type { AgentModelOption } from '../../models/descriptor.js';

export const PROVIDER_REASONING_EFFORT_LEVELS_V1 = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ProviderReasoningEffortLevelV1Schema = lazyZodSchema(() => z.enum(PROVIDER_REASONING_EFFORT_LEVELS_V1));
export type ProviderReasoningEffortLevelV1 = z.infer<typeof ProviderReasoningEffortLevelV1Schema>;
export const ProviderReasoningEffortLevelsV1Schema = lazyZodSchema(() => z.array(ProviderReasoningEffortLevelV1Schema).check(
  z.minLength(1), z.maxLength(PROVIDER_REASONING_EFFORT_LEVELS_V1.length),
  z.superRefine((levels, ctx) => {
    if (new Set(levels).size !== levels.length) {
      ctx.addIssue({ code: 'custom', message: 'Reasoning effort levels must be unique' });
    }
  }),
));

export function formatProviderReasoningEffortLevelLabel(level: ProviderReasoningEffortLevelV1): string {
  switch (level) {
    case 'low': return 'Low';
    case 'medium': return 'Medium';
    case 'high': return 'High';
    case 'xhigh': return 'XHigh';
    case 'max': return 'Max';
  }
}

/** One effort-select projection for endpoint evidence, static facts and user declarations. */
export function buildProviderReasoningModelOptions(input: Readonly<{
  supportedLevels: readonly ProviderReasoningEffortLevelV1[];
  defaultEffort?: ProviderReasoningEffortLevelV1 | null;
}>): readonly AgentModelOption[] {
  const supported = new Set(input.supportedLevels);
  const levels = PROVIDER_REASONING_EFFORT_LEVELS_V1.filter(level => supported.has(level));
  if (levels.length === 0) return [];
  const currentValue = input.defaultEffort && supported.has(input.defaultEffort)
    ? input.defaultEffort : supported.has('high') ? 'high' : levels[levels.length - 1]!;
  return [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue,
    options: levels.map(level => ({ value: level, name: formatProviderReasoningEffortLevelLabel(level) })) }];
}
