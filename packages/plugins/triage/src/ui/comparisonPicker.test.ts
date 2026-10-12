import { describe, expect, it } from 'vitest';
import { TRIAGE_PLUGIN as triagePlugin } from '../manifest.js';
import { invokeInputTypePicker, type ResolvedInputTypeV1 } from '@happier-dev/protocol/inputs/runtime';

const source = { kind: 'pullRequest', locator: { providerId: 'github', repository: 'example/repository', number: 17,
  sourceAction: { action: { pluginId: 'happier.scm.forge.github', localId: 'triage/comparison' }, input: { number: 17 } } } };

describe('Triage comparison input return', () => {
  it('returns admitted source evidence through the existing picker without changing it, and preserves cancellation', async () => {
    const definition = triagePlugin.manifest.contributes?.inputTypes?.find(type => type.id === 'pull-request-comparison');
    expect(definition).toBeDefined();
    if (!definition) throw new Error('Missing comparison picker');
    const type: ResolvedInputTypeV1 = { identity: { pluginId: triagePlugin.manifest.id, localId: definition.id }, occurrenceId: 'triage-current', definition };
    const pick = (answer: unknown) => invokeInputTypePicker({ field: { path: 'comparison', title: 'Pull request', widget: 'select', inputType: type.identity },
      signal: new AbortController().signal, host: { resolveType: async () => type, resolveOptions: async () => [], openPicker: async () => answer } });
    expect(await pick({ kind: 'completed', input: source })).toEqual({ status: 'selected', value: source });
    expect(await pick({ kind: 'cancelled' })).toEqual({ status: 'cancelled' });
    expect(await pick({ kind: 'completed', input: { kind: 'workingTree' } })).toMatchObject({ status: 'error' });
  });
});
