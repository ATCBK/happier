import type { AgentModelOption } from '../../models/descriptor.js';
import {
  PROVIDER_REASONING_EFFORT_LEVELS_V1,
  buildProviderReasoningModelOptions,
  formatProviderReasoningEffortLevelLabel,
  type ProviderReasoningEffortLevelV1,
} from './reasoningEffort.js';

type AnthropicModelOption = AgentModelOption;

export const ANTHROPIC_EFFORT_LEVELS = PROVIDER_REASONING_EFFORT_LEVELS_V1;
export type AnthropicEffortLevel = ProviderReasoningEffortLevelV1;

export function normalizeAnthropicModelDisplayName(nameRaw: unknown, fallback: string): string {
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  const prefixed = /^claude\s+(.+)$/iu.exec(name);
  return prefixed?.[1]?.trim() || name || fallback.trim();
}

export const formatAnthropicEffortLevelLabel = formatProviderReasoningEffortLevelLabel;

export function buildAnthropicModelOptions(input: Readonly<{
  supportedLevels: readonly AnthropicEffortLevel[];
  defaultEffort?: AnthropicEffortLevel | null;
}>): readonly AnthropicModelOption[] {
  const options = [...buildProviderReasoningModelOptions(input)];

  if (input.supportedLevels.includes('xhigh')) {
    options.push({
      id: 'ultracode',
      name: 'Ultracode',
      description: 'Maximum coding effort. Forces XHigh Thinking effort while enabled.',
      type: 'boolean',
      currentValue: 'false',
      overridesWhenOn: { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' },
    });
  }
  return options;
}

