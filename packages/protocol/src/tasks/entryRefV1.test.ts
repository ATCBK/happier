import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import {
  TriageEntryRefV1Schema,
  TriageEntryRefV1JsonSchema,
} from './entryRefV1.js';
import { compilePluginJsonSchema } from '../plugins/actions/jsonSchemaValidation.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

const entry = {
  source: { pluginId: 'acme.tasks', localId: 'work-items' },
  kindId: 'task', collisionScope: 'https://example.test\u001forg-1', entryId: '42',
};

describe('the shared Task entry reference V1', () => {
  it('round-trips the exact source-qualified identity through executable and JSON schemas', () => {
    const parsed = TriageEntryRefV1Schema.parse(JSON.parse(JSON.stringify(entry)));
    expect(parsed).toEqual(entry);
    expect(compilePluginJsonSchema(TriageEntryRefV1JsonSchema)(parsed)).toBe(true);
  });

  it('embeds in a strict Protocol anchor through the existing neutral-schema adapter', () => {
    const anchor = z.strictObject({ kind: z.literal('task'), entry: asProtocolZod(TriageEntryRefV1Schema) });
    const value = { kind: 'task', entry };
    expect(anchor.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(anchor.safeParse({ ...value, entry: { ...entry, sourceInstanceId: 'instance-1' } }).success).toBe(false);
  });

  it('keeps both identity envelopes closed and refuses routing or mutable fields', () => {
    const validate = compilePluginJsonSchema(TriageEntryRefV1JsonSchema);
    for (const value of [
      { ...entry, sourceInstanceId: 'instance-1' },
      { ...entry, source: { ...entry.source, accountId: 'account-1' } },
      { ...entry, webUrl: 'https://example.test/task/42' },
      { ...entry, source: { ...entry.source, pluginId: ' acme.tasks ' } },
      { ...entry, entryId: '' },
    ]) {
      expect(TriageEntryRefV1Schema.safeParse(value).success).toBe(false);
      expect(validate(value)).toBe(false);
    }
  });

  it('preserves UTF-8 byte boundaries and confines the single delimiter to collisionScope', () => {
    const validate = compilePluginJsonSchema(TriageEntryRefV1JsonSchema);
    const atLimit = { ...entry, kindId: 'é'.repeat(64), entryId: '🚀'.repeat(32), collisionScope: `${'é'.repeat(95)}\u001fx` };
    expect(TriageEntryRefV1Schema.parse(atLimit)).toEqual(atLimit);
    expect(validate(atLimit)).toBe(true);
    for (const value of [
      { ...atLimit, kindId: `${atLimit.kindId}x` },
      { ...atLimit, entryId: `${atLimit.entryId}x` },
      { ...atLimit, collisionScope: `${atLimit.collisionScope}x` },
      { ...entry, collisionScope: 'a\u001fb\u001fc' },
      { ...entry, collisionScope: '\u001fb' },
      { ...entry, collisionScope: 'a\u001f' },
      { ...entry, entryId: 'a\u001fb' },
      { ...entry, collisionScope: 'a\nb' },
    ]) {
      expect(TriageEntryRefV1Schema.safeParse(value).success).toBe(false);
      expect(validate(value)).toBe(false);
    }
  });
});
