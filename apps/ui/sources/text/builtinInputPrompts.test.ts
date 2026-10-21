import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USAGE_QUERY_INPUT_FIELDS } from '@happier-dev/protocol/inputs/usageQuery';
import {
  getPreferredLanguage,
  preloadTranslationsForSettings,
  setPreferredLanguageFromSettings,
  t,
  type TranslationKeyNoParams,
} from './i18n';
import { localizeBuiltinInputHints } from './builtinInputPrompts';
import { readBuiltinWidgetDescriptorV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';

const initialLanguage = getPreferredLanguage();
beforeAll(async () => { await preloadTranslationsForSettings('es'); });
beforeEach(() => { setPreferredLanguageFromSettings('es'); });
afterEach(() => { setPreferredLanguageFromSettings(initialLanguage); });

describe('host input declarations read in the viewer’s language', () => {
  it('localizes the shared chart own inputs without changing their Style identities', () => {
    const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_rhythm' })!;
    const fields = localizeBuiltinInputHints(descriptor.inputs!).fields;
    expect(fields.find(field => field.path === 'colourBy')!.title).toBe(t('usage.board.charts.inputColourBy'));
    expect(fields.find(field => field.path === 'style')!.options!.find(option => option.value === 'sky')!.label).toBe(t('usage.board.charts.inputSky'));
    expect(fields.find(field => field.path === 'style')!.options!.map(option => option.value)).toEqual(['heatmap', 'weekdayHour', 'sky', 'weekTide', 'daylight']);
  });
  it('localizes the current Usage inputs’ titles, choices and placeholders (F4 D-11)', () => {
    const fields = localizeBuiltinInputHints({
      fields: [...USAGE_QUERY_INPUT_FIELDS],
    }).fields;
    const byPath = Object.fromEntries(
      fields.map((field) => [field.path, field]),
    );
    const titleKeys = {
      period: 'usage.board.page.periodLabel',
      agents: 'usage.board.page.filterAgents',
      machines: 'usage.board.page.filterMachines',
      projects: 'usage.board.page.filterProjects',
      sources: 'usage.board.page.filterSources',
      session: 'widgetAdd.inputLabels.session',
      costBasis: 'usage.costMode',
      metric: 'widgetAdd.inputLabels.metric',
      breakdown: 'widgetAdd.inputLabels.groupBy',
    } satisfies Record<string, TranslationKeyNoParams>;
    const optionKeys = {
      Automatic: 'usage.board.page.costBasisAuto',
      Reported: 'usage.board.page.costBasisReported',
      Estimated: 'usage.board.page.costBasisEstimated',
      'API equivalent': 'widgetAdd.inputLabels.apiEquivalent',
      Tokens: 'usage.tokens',
      Cost: 'usage.cost',
      Sessions: 'usage.board.charts.metric_sessions',
      'Busy time': 'usage.board.charts.metric_busy',
      'Accepted steers': 'usage.board.charts.metric_steering',
      'Peak parallel': 'usage.board.charts.metric_peakParallel',
    } satisfies Record<string, TranslationKeyNoParams>;
    // Exercise the real locale reader; legitimate cognates need not differ from English.
    expect(getPreferredLanguage()).toBe('es');
    expect(t('usage.board.page.filterProjects')).not.toBe('Projects');
    expect(t('usage.board.page.filterProjects')).not.toBe('usage.board.page.filterProjects');
    for (const field of fields) {
      const titleKey = titleKeys[field.path as keyof typeof titleKeys];
      expect(titleKey, field.path).toBeDefined();
      expect(field.title, field.path).toBe(t(titleKey));
      const source = USAGE_QUERY_INPUT_FIELDS.find((candidate) => candidate.path === field.path)!;
      for (const [index, option] of (field.options ?? []).entries()) {
        const original = source.options![index]!;
        const key = optionKeys[original.label as keyof typeof optionKeys];
        expect(key, `${field.path}:${String(option.value)}`).toBeDefined();
        expect(option.label).toBe(t(key));
        expect(option.value).toEqual(original.value);
      }
      expect(field.prompt).toBe(source.prompt);
    }
    for (const path of ['agents', 'machines', 'projects', 'sources']) {
      expect(byPath[path]!.placeholder).toBe(t('usage.board.page.filterAllOf', {
        what: byPath[path]!.title.toLocaleLowerCase(),
      }));
    }
    // Values are never touched: only what people read changes.
    expect(byPath.metric!.options!.map((option) => option.value)).toEqual([
      'tokens',
      'cost',
      'sessions', 'busy', 'steering', 'peakParallel',
    ]);
  });
  it('localizes an explicit host question without inventing one for a declaration that has none', () => {
    const fields = localizeBuiltinInputHints({ fields: [
      { path: 'project', title: 'Project', widget: 'text', prompt: 'Which projects?' },
      { path: 'machine', title: 'Machine', widget: 'text' },
    ] }).fields;
    expect(fields[0]!.prompt).toBe(t('widgetAdd.prompts.projects'));
    expect(fields[0]!.prompt).not.toBe('Which projects?');
    expect(fields[0]!.prompt).not.toBe('widgetAdd.prompts.projects');
    expect(fields[1]!.prompt).toBeUndefined();
  });
  it('leaves a plugin-authored title it does not know as written', () => {
    expect(
      localizeBuiltinInputHints({
        fields: [{ path: 'repo', title: 'Repository slug', widget: 'text' }],
      }).fields[0]!.title,
    ).toBe('Repository slug');
  });
});
