import { describe, expect, it } from 'vitest';

import {
  MAX_PLUGIN_SEARCH_ITEM_COMMAND_UTF8_BYTES_V1,
  PluginSearchProviderContributionV1Schema,
  PluginSearchQueryV1Schema,
  PluginSearchResultV1Schema,
} from './searchProviders.js';
import { PluginComposerReferenceProviderContributionV1Schema } from './composerReferenceProviders.js';
import { PluginContributesV2Schema } from './v2.js';
import { getPluginContributionCatalogEntryV2 } from './catalog.js';
import {
  compilePluginJsonSchema,
  rehydrateCanonicalProtocolComposableSchema,
} from '../actions/jsonSchemaValidation.js';
import { normalizePluginUiSemanticCommandV1 } from '../ui/semanticCommands.js';

const searchAction = Object.freeze({
  id: 'search',
  title: 'Search entries',
  scopes: ['global'],
  surfaces: ['ui'],
  placementBindings: [],
  dangerLevel: 'safe',
  execution: { target: 'daemon' },
  inputSchema: PluginSearchQueryV1Schema.jsonSchema,
  resultSchema: PluginSearchResultV1Schema.jsonSchema,
});

function contributes(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    actions: [searchAction],
    searchProviders: [{ id: 'entries', action: 'search' }],
    ...overrides,
  };
}

describe('searchProviders contribution family', () => {
  it('admits a descriptor referencing a safe, global, UI-origin read Action', () => {
    const parsed = PluginContributesV2Schema.safeParse(contributes());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.searchProviders).toEqual([{ id: 'entries', action: 'search' }]);
  });

  it('keeps the descriptor minimal', () => {
    expect(PluginSearchProviderContributionV1Schema.safeParse({
      id: 'entries',
      action: 'search',
      keyword: 'pr',
    }).success).toBe(false);
  });

  it('refuses a descriptor whose Action is not declared by the same plugin', () => {
    const parsed = PluginContributesV2Schema.safeParse(contributes({
      searchProviders: [{ id: 'entries', action: 'missing' }],
    }));
    expect(parsed.success).toBe(false);
  });

  it('refuses a non-safe query Action', () => {
    const parsed = PluginContributesV2Schema.safeParse(contributes({
      actions: [{
        ...searchAction,
        dangerLevel: 'writesLocal',
        confirmation: { title: 'Are you sure?' },
      }],
    }));
    expect(parsed.success).toBe(false);
  });

  it('refuses a query Action without the global scope', () => {
    const parsed = PluginContributesV2Schema.safeParse(contributes({
      actions: [{ ...searchAction, scopes: ['session'] }],
    }));
    expect(parsed.success).toBe(false);
  });

  it('refuses a query Action without the UI origin', () => {
    const parsed = PluginContributesV2Schema.safeParse(contributes({
      actions: [{ ...searchAction, surfaces: ['plugin'], placementBindings: undefined }],
    }));
    expect(parsed.success).toBe(false);
  });

  it('refuses a query Action carrying an ordinary command placement', () => {
    const parsed = PluginContributesV2Schema.safeParse(contributes({
      actions: [{ ...searchAction, placementBindings: ['commandPalette'] }],
    }));
    expect(parsed.success).toBe(false);
  });

  /**
   * Admission is eligibility, not schema comparison. The declared Action's own
   * dispatch validates its declared input, and the universal boundary parses
   * the returned result through the canonical schema below — so the manifest
   * owner never normalizes two JSON Schemas and compares them for equivalence.
   */
  it('does not admit or refuse a provider by comparing declared JSON Schemas', () => {
    expect(PluginContributesV2Schema.safeParse(contributes({
      actions: [{
        ...searchAction,
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          additionalProperties: false,
        },
      }],
    })).success).toBe(true);
    expect(PluginContributesV2Schema.safeParse(contributes({
      actions: [{ ...searchAction, resultSchema: undefined }],
    })).success).toBe(true);
  });

  it('refuses duplicate provider ids', () => {
    const parsed = PluginContributesV2Schema.safeParse(contributes({
      searchProviders: [{ id: 'entries', action: 'search' }, { id: 'entries', action: 'search' }],
    }));
    expect(parsed.success).toBe(false);
  });

  it('projects the family through the canonical contribution catalog', () => {
    const entry = getPluginContributionCatalogEntryV2('searchProviders');
    expect(entry?.projectionFamily).toBe('pluginUi');
    expect(entry?.allowedRuntimeRegistration).toBeNull();
    expect(entry?.references).toEqual([{ field: 'action', targetFamily: 'actions' }]);
    expect(entry?.extractReferences({ id: 'entries', action: 'search' })).toEqual([
      { targetFamily: 'actions', reference: 'search', path: ['action'] },
    ]);
  });
});

describe('plugin search query and result schemas', () => {
  it('rehydrates the full nested command grammar and preserves normalization through the cold boundary', () => {
    const cold = rehydrateCanonicalProtocolComposableSchema(PluginSearchResultV1Schema.jsonSchema);
    if (!cold) throw new Error('Search result must rehydrate');
    const validate = compilePluginJsonSchema(PluginSearchResultV1Schema.jsonSchema);
    const result = (command: unknown) => ({ items: [{ id: 'entry', title: 'Entry', command }], truncated: false });
    for (const command of [
      {},
      { kind: 'navigate', destination: 'entry' },
      { kind: 'executeAction', action: 'open', href: '/escape' },
      { kind: 'openSurface', destination: 'entry', subPath: '//../escape' },
      { kind: 'openSurface', destination: 'entry', subPath: 'a/./b' },
      { kind: 'openSurface', destination: 'entry', subPath: 'a\nb' },
      { kind: 'openSurface', destination: 'entry', instanceKey: ` ${'é'.repeat(129)} ` },
      { kind: 'openSurface', destination: 'entry', instanceKey: ` ${'é'.repeat(128)} ` },
      { kind: 'openSurface', destination: 'entry', instanceKey: ' \t ' },
      { kind: 'openSurface', destination: 'entry', instanceKey: `${' '.repeat(MAX_PLUGIN_SEARCH_ITEM_COMMAND_UTF8_BYTES_V1)}key` },
    ]) {
      expect(PluginSearchResultV1Schema.safeParse(result(command)).success).toBe(false);
      expect(cold.safeParse(result(command)).success).toBe(false);
      expect(validate(result(command))).toBe(false);
    }
    const command = {
      kind: 'openSurface', destination: 'entry', subPath: '//a///b/',
      instanceKey: 'entry-instance',
    };
    const expected = result(command);
    expect(PluginSearchResultV1Schema.parse(result(command))).toEqual(expected);
    expect(cold.parse(result(command))).toEqual(expected);
    const validationInput = result(command);
    expect(validate(validationInput)).toBe(true);
    // JSON Schema compilation is admission-only, not an in-place normalizer.
    expect(validationInput).toEqual(result(command));
    expect(normalizePluginUiSemanticCommandV1({ pluginId: 'acme.search', command })).toEqual({
      ...command,
      destination: { pluginId: 'acme.search', localId: 'entry' },
      subPath: 'a/b',
      instanceKey: 'entry-instance',
    });
  });

  it('is one composable owner an author declares and the host parses', () => {
    expect(PluginSearchQueryV1Schema.jsonSchema.type).toBe('object');
    expect(PluginSearchResultV1Schema.jsonSchema.type).toBe('object');
    expect(Object.keys(PluginSearchResultV1Schema.jsonSchema.properties ?? {}))
      .toEqual(['items', 'truncated', 'failure']);
  });

  it('carries closed typed search failures through author, cold declaration and host validators', () => {
    const cold = rehydrateCanonicalProtocolComposableSchema(PluginSearchResultV1Schema.jsonSchema);
    if (!cold) throw new Error('Search result must rehydrate');
    const validate = compilePluginJsonSchema(PluginSearchResultV1Schema.jsonSchema);
    for (const code of ['root_not_found', 'unavailable', 'auth_required']) {
      const result = { items: [], truncated: false, failure: { code } };
      expect(PluginSearchResultV1Schema.safeParse(result).success).toBe(true);
      expect(cold.safeParse(result).success).toBe(true);
      expect(validate(result)).toBe(true);
    }
    for (const failure of [{ code: 'invented' }, { code: 'root_not_found', path: '/private' }]) {
      const result = { items: [], truncated: false, failure };
      expect(PluginSearchResultV1Schema.safeParse(result).success).toBe(false);
      expect(validate(result)).toBe(false);
    }
  });

  it('accepts caller-selected query and page sizes while keeping inputs strict', () => {
    expect(PluginSearchQueryV1Schema.safeParse({ query: 'pr', limit: 8 }).success).toBe(true);
    expect(PluginSearchQueryV1Schema.safeParse({ query: '', limit: 8 }).success).toBe(false);
    expect(PluginSearchQueryV1Schema.safeParse({
      query: 'a'.repeat(1024),
      limit: 8,
    }).success).toBe(true);
    expect(PluginSearchQueryV1Schema.safeParse({
      query: 'pr',
      limit: 100,
    }).success).toBe(true);
    expect(PluginSearchQueryV1Schema.safeParse({ query: 'pr', limit: 0 }).success).toBe(false);
    expect(PluginSearchQueryV1Schema.safeParse({ query: 'pr', limit: 8, scope: 'all' }).success).toBe(false);
  });

  it('admits long multibyte queries and display labels through the cold Action boundary', () => {
    const query = '😀'.repeat(300);
    const validateQuery = compilePluginJsonSchema(PluginSearchQueryV1Schema.jsonSchema);
    expect(validateQuery({ query, limit: 100 })).toBe(true);
    const result = { items: Array.from({ length: 100 }, (_, index) => ({
      id: `${query}-${index}`,
      title: query,
      subtitle: query,
      command: { kind: 'executeAction', action: 'open-entry' },
    })), truncated: true };
    expect(PluginSearchResultV1Schema.safeParse(result).success).toBe(true);
    expect(compilePluginJsonSchema(PluginSearchResultV1Schema.jsonSchema)(result)).toBe(true);
  });

  it('carries bounded host-renderable rows and the incumbent semantic command', () => {
    const parsed = PluginSearchResultV1Schema.safeParse({
      items: [{
        id: 'entry-1',
        title: 'Fix the crash',
        subtitle: 'happier/happier · open',
        icon: 'action',
        command: { kind: 'openSurface', destination: 'triage', input: { v: 1 }, subPath: '' },
      }],
      truncated: true,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.items[0]?.command).toEqual({
      kind: 'openSurface',
      destination: 'triage',
      input: { v: 1 },
      subPath: '',
    });
  });

  /**
   * The row's activation target is the incumbent semantic command, so the
   * result parser must refuse anything that union refuses. A row whose
   * `command` is `null`, `{}`, a missing discriminator or an unknown key is a
   * value no activation owner can ever run; admitting it here would push a
   * shape failure past the boundary that is supposed to catch it.
   */
  it('refuses a row whose command is not a semantic command', () => {
    const row = { id: 'entry-1', title: 'Fix the crash' };
    const parseCommand = (command: unknown) => PluginSearchResultV1Schema.safeParse({
      items: [{ ...row, command }],
      truncated: false,
    }).success;
    expect(parseCommand(null)).toBe(false);
    expect(parseCommand({})).toBe(false);
    expect(parseCommand('open-entry')).toBe(false);
    expect(parseCommand({ kind: 'executeAction' })).toBe(false);
    expect(parseCommand({ kind: 'openSurface' })).toBe(false);
    expect(parseCommand({ kind: 'navigate', destination: 'triage' })).toBe(false);
    expect(parseCommand({ kind: 'executeAction', action: 'open-entry', href: '/x' })).toBe(false);
    expect(parseCommand({ kind: 'openSurface', destination: 'triage', subPath: '../escape' })).toBe(false);
    // A qualified destination is a plugin id plus a local id, not a bare word.
    expect(parseCommand({
      kind: 'openSurface',
      destination: { pluginId: 'triage', localId: 'entry-details' },
    })).toBe(false);
  });

  it('accepts both members of the incumbent semantic command union', () => {
    const row = { id: 'entry-1', title: 'Fix the crash' };
    const parsed = PluginSearchResultV1Schema.safeParse({
      items: [
        { ...row, command: { kind: 'executeAction', action: 'open-entry', input: { id: 7 } } },
        {
          ...row,
          id: 'entry-2',
          command: {
            kind: 'openSurface',
            destination: { pluginId: 'happier.triage', localId: 'entry-details' },
            instanceKey: 'entry-2',
          },
        },
      ],
      truncated: false,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.items.map((item) => item.command)).toEqual([
      { kind: 'executeAction', action: 'open-entry', input: { id: 7 } },
      {
        kind: 'openSurface',
        destination: { pluginId: 'happier.triage', localId: 'entry-details' },
        instanceKey: 'entry-2',
      },
    ]);
  });

  it('refuses arbitrary activation payloads and scores', () => {
    const item = {
      id: 'entry-1',
      title: 'Fix the crash',
      command: { kind: 'executeAction', action: 'open-entry' },
    };
    expect(PluginSearchResultV1Schema.safeParse({
      items: [{ ...item, url: 'https://example.invalid' }],
      truncated: false,
    }).success).toBe(false);
    expect(PluginSearchResultV1Schema.safeParse({
      items: [{ ...item, score: 0.5 }],
      truncated: false,
    }).success).toBe(false);
    expect(PluginSearchResultV1Schema.safeParse({ items: [item] }).success).toBe(false);
    expect(PluginSearchResultV1Schema.safeParse({
      items: [{
        ...item,
        command: {
          kind: 'openSurface',
          destination: 'triage',
          input: { padding: 'x'.repeat(MAX_PLUGIN_SEARCH_ITEM_COMMAND_UTF8_BYTES_V1) },
        },
      }],
      truncated: false,
    }).success).toBe(false);
    expect(PluginSearchResultV1Schema.safeParse({
      items: [{ ...item, icon: 'not-a-token' }],
      truncated: false,
    }).success).toBe(false);
  });
});

describe('searchProviders is not composerReferences', () => {
  it('keeps the two families separate rather than overloading either', () => {
    // Composer references answer "what context should this message carry":
    // they declare trigger characters and resolve to model-facing text.
    const composerReference = { id: 'entries', title: 'Entries', icon: 'action', triggers: ['@'] };
    expect(PluginComposerReferenceProviderContributionV1Schema.safeParse(composerReference).success).toBe(true);
    // Search providers answer "which entities match what I typed": they carry
    // no trigger and no presentation of their own, only an Action reference.
    expect(PluginSearchProviderContributionV1Schema.safeParse(composerReference).success).toBe(false);
    expect(PluginComposerReferenceProviderContributionV1Schema.safeParse({
      id: 'entries',
      action: 'search',
    }).success).toBe(false);
  });

  it('admits both families side by side on one plugin', () => {
    const parsed = PluginContributesV2Schema.safeParse(contributes({
      composerReferences: [{ id: 'reference', title: 'Entries', icon: 'action', triggers: ['@'] }],
    }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.composerReferences).toHaveLength(1);
    expect(parsed.success && parsed.data.searchProviders).toHaveLength(1);
  });
});
