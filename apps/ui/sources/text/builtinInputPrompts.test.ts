import { describe, expect, it, vi } from 'vitest';
import { USAGE_QUERY_INPUT_FIELDS } from '@happier-dev/protocol/inputs/usageQuery';

vi.mock('@/text/i18n', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

describe('host input declarations read in the viewer’s language', () => {
  it('localizes the Usage inputs’ titles and choices, not only their questions (F4 D-11)', async () => {
    const { localizeBuiltinInputHints } = await import('./builtinInputPrompts');
    const fields = localizeBuiltinInputHints({
      fields: [...USAGE_QUERY_INPUT_FIELDS],
    }).fields;
    const byPath = Object.fromEntries(
      fields.map((field) => [field.path, field]),
    );
    // Every title and every static choice label goes through the translation catalog.
    for (const field of fields) {
      expect(field.title, field.path).not.toBe(
        USAGE_QUERY_INPUT_FIELDS.find((source) => source.path === field.path)!
          .title,
      );
      for (const option of field.options ?? [])
        expect(option.label, `${field.path}:${String(option.value)}`).toMatch(
          /^[a-zA-Z]+\./,
        );
    }
    expect(byPath.projects!.prompt).toBe('widgetAdd.prompts.projects');
    for (const path of ['agents', 'machines', 'projects', 'sources']) {
      expect(byPath[path]!.placeholder).toContain('usage.board.page.filterAllOf');
    }
    // Values are never touched: only what people read changes.
    expect(byPath.metric!.options!.map((option) => option.value)).toEqual([
      'tokens',
      'cost',
    ]);
  });
  it('leaves a plugin-authored title it does not know as written', async () => {
    const { localizeBuiltinInputHints } = await import('./builtinInputPrompts');
    expect(
      localizeBuiltinInputHints({
        fields: [{ path: 'repo', title: 'Repository slug', widget: 'text' }],
      }).fields[0]!.title,
    ).toBe('Repository slug');
  });
});
