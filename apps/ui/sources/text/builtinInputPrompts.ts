import type { InputHints } from '@happier-dev/protocol/inputs/inputFields';
import { readUsageGroupByOptions } from '@happier-dev/protocol/inputs/usageQuery';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';

import { t, type TranslationKeyNoParams } from './i18n';

const BUILTIN_PROMPT_KEYS = {
  'Which project?': 'widgetAdd.prompts.project',
  'Which projects?': 'widgetAdd.prompts.projects',
  'Which session?': 'widgetAdd.prompts.session',
  'Which workspace?': 'widgetAdd.prompts.workspace',
  'Which checkout?': 'widgetAdd.prompts.checkout',
  'Which machine?': 'widgetAdd.prompts.machine',
} as const satisfies Record<string, TranslationKeyNoParams>;

/**
 * The host's own input words (the Usage query inputs, `@happier-dev/protocol/inputs/usageQuery`):
 * their titles and static choice labels, in the words the Usage page already uses where it names the
 * same thing.
 */
const BUILTIN_LABEL_KEYS = {
  Period: 'usage.board.page.periodLabel',
  Agents: 'usage.board.page.filterAgents',
  Machines: 'usage.board.page.filterMachines',
  Projects: 'usage.board.page.filterProjects',
  Sources: 'usage.board.page.filterSources',
  'Cost basis': 'usage.costMode',
  Tokens: 'usage.tokens',
  Cost: 'usage.cost',
  Automatic: 'usage.board.page.costBasisAuto',
  Default: 'common.default',
  Reported: 'usage.board.page.costBasisReported',
  Estimated: 'usage.board.page.costBasisEstimated',
  Session: 'widgetAdd.inputLabels.session',
  Metric: 'widgetAdd.inputLabels.metric',
  Breakdown: 'widgetAdd.inputLabels.breakdown',
  'Group by': 'widgetAdd.inputLabels.groupBy',
  'API equivalent': 'widgetAdd.inputLabels.apiEquivalent',
  Agent: 'widgetAdd.inputLabels.agent',
  Model: 'widgetAdd.inputLabels.model',
  Project: 'widgetAdd.inputLabels.project',
  Workspace: 'widgetAdd.inputLabels.workspace',
  'Backend mode': 'widgetAdd.inputLabels.backendMode',
  Source: 'widgetAdd.inputLabels.source',
  Machine: 'widgetAdd.inputLabels.machine',
  Volume: 'machines.widgets.inputs.volume',
  Range: 'machines.widgets.inputs.range',
  Scope: 'machines.widgets.inputs.scope',
  Style: 'machines.widgets.inputs.style',
  Metrics: 'machines.widgets.inputs.metrics',
  'Warn above': 'machines.widgets.inputs.warnAbove',
  CPU: 'machines.widgets.inputs.cpu',
  Memory: 'machines.widgets.inputs.memory',
  'Disk free': 'machines.widgets.inputs.diskFree',
  Network: 'machines.widgets.inputs.network',
  '1 hour': 'machines.widgets.inputs.oneHour',
  '24 hours': 'machines.widgets.inputs.oneDay',
  '7 days': 'machines.widgets.inputs.sevenDays',
  Sparklines: 'machines.widgets.inputs.sparklines',
  Bars: 'machines.widgets.inputs.bars',
  Numbers: 'machines.widgets.inputs.numbers',
  Rings: 'machines.widgets.inputs.rings',
  Disk: 'machines.widgets.inputs.disk',
} as const satisfies Record<string, TranslationKeyNoParams>;

function localized(
  keys: Readonly<Record<string, TranslationKeyNoParams>>,
  text: string,
): string {
  return Object.hasOwn(keys, text) ? t(keys[text]!) : text;
}

/** Dynamic host choices use the same vocabulary as their descriptor's static choices. */
export function localizeBuiltinInputLabel(text: string): string {
  return text.split(' · ').map(part => localized(BUILTIN_LABEL_KEYS, part)).join(' · ');
}

/** A stored own choice can be named before the admitted dynamic inventory arrives. */
export function describeBuiltinInputOptionValue(optionsSourceId: string | undefined, value: unknown): string | null {
  if (optionsSourceId !== 'usage.query.breakdown') return null;
  const option = readUsageGroupByOptions(value).find(option => pluginJsonValuesEqual(option.value, value));
  return option ? localizeBuiltinInputLabel(option.label) : null;
}

/**
 * Host declarations read in the viewer's language: their questions, titles and choice labels. Only
 * host declarations enter here; plugin-authored and saved inputs retain their own copy, and values are
 * never touched.
 */
export function localizeBuiltinInputHints(hints: InputHints): InputHints {
  return {
    ...hints,
    fields: hints.fields.map((field) => ({
      ...field,
      title: localized(BUILTIN_LABEL_KEYS, field.title),
      ...(field.placeholder !== undefined && field.placeholder === `All ${field.title.toLowerCase()}`
        ? { placeholder: t('usage.board.page.filterAllOf', { what: localized(BUILTIN_LABEL_KEYS, field.title).toLocaleLowerCase() }) }
        : {}),
      ...(field.prompt === undefined
        ? {}
        : { prompt: localized(BUILTIN_PROMPT_KEYS, field.prompt) }),
      ...(field.options === undefined
        ? {}
        : {
            options: field.options.map((option) => ({
              ...option,
              label: localized(BUILTIN_LABEL_KEYS, option.label),
            })),
          }),
    })),
  };
}
