import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';

import { PluginHostedWebBridgeEnvelopeV1Schema } from '../../ui/hostedWebBridge.js';
import {
  PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
  PluginUiLaunchInputV1Schema,
} from '../../ui/semanticCommands.js';
import { PluginUiJsonValueV1Schema } from './json.js';
import { PluginJsonValueV2Schema } from '../jsonSchema.js';
import { CurrentUiContextSnapshotV1Schema } from '../../ui/currentUiContext.js';
import { zodSchemaToJsonSchemaObject } from '../../../actions/actionInputJsonSchema.js';

function nestedArray(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

function hostedBridgeEnvelope(payload: unknown): unknown {
  return {
    version: 1,
    identity: { instanceId: 'preview-web', mountNonce: 'nonce-1' },
    sequence: 1,
    kind: 'ready',
    payload,
  };
}

describe('PluginUiJsonValueV1Schema', () => {
  it('projects the existing serialized JSON vocabulary for current-context Actions without changing strict admission', () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    let getterRead = false;
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => { getterRead = true; return 'not JSON data'; },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const invalid of [accessor, cycle, new Date(), Number.NaN]) {
      const result = PluginUiJsonValueV1Schema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]).toMatchObject({
        code: 'custom', path: [], message: 'Plugin UI descriptor values must be JSON-serializable.',
      });
      const nested = CurrentUiContextSnapshotV1Schema.safeParse({
        navigation: { area: 'session', screen: 'review' }, commands: [], detail: invalid,
      });
      expect(nested.success).toBe(false);
      if (!nested.success) expect(nested.error.issues[0]).toMatchObject({
        code: 'custom', path: ['detail'], message: 'Plugin UI descriptor values must be JSON-serializable.',
      });
    }
    expect(getterRead).toBe(false);

    const target = { target: 'draft-7' } as const;
    const advertisedUiValue = new Ajv({ strict: false }).compile(
      zodSchemaToJsonSchemaObject(PluginUiJsonValueV1Schema, target),
    );
    const advertisedJsonValue = new Ajv({ strict: false }).compile(
      zodSchemaToJsonSchemaObject(PluginJsonValueV2Schema, target),
    );
    for (const value of [null, true, 7, 'text', [null, { nested: [true] }], { label: 'selection' }]) {
      expect(advertisedUiValue(value)).toBe(advertisedJsonValue(value));
      expect(advertisedUiValue(value)).toBe(true);
    }
    const actionOutput = zodSchemaToJsonSchemaObject(CurrentUiContextSnapshotV1Schema, target);
    expect(actionOutput).toMatchObject({
      type: 'object',
      properties: { navigation: { type: 'object' }, detail: expect.any(Object) },
    });
    expect(JSON.parse(JSON.stringify(actionOutput))).toEqual(actionOutput);
    expect(new Ajv({ strict: false }).compile(actionOutput)({
      navigation: { area: 'session', screen: 'review' },
      detail: { nested: [null, true, 7, 'selection'] },
      commands: [],
    })).toBe(true);
  });
  it('handles deeply nested ordinary JSON without a public traversal quota', () => {
    const deep = nestedArray(12_000);
    let result: { success: boolean } | undefined;
    let launchInputResult: { success: boolean } | undefined;

    expect(() => {
      result = PluginUiJsonValueV1Schema.safeParse(deep);
    }).not.toThrow();
    expect(result?.success).toBe(true);

    expect(() => {
      launchInputResult = PluginUiLaunchInputV1Schema.safeParse(deep);
    }).not.toThrow();
    expect(launchInputResult?.success).toBe(false);
  });

  it('does not use generic string or collection ceilings for ordinary JSON', () => {
    expect(PluginUiJsonValueV1Schema.safeParse('x'.repeat(192 * 1024 + 1)).success).toBe(true);
    expect(PluginUiJsonValueV1Schema.safeParse(
      Array.from({ length: 8_193 }, () => null),
    ).success).toBe(true);
  });

  it('uses the launch-input UTF-8 byte ceiling exactly', () => {
    const jsonStringOverhead = new TextEncoder().encode(JSON.stringify('')).byteLength;
    const utf8ThreeByteCharacter = '€';
    const utf8ThreeByteLength = new TextEncoder().encode(utf8ThreeByteCharacter).byteLength;
    const atByteLimit = utf8ThreeByteCharacter.repeat(
      (PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 - jsonStringOverhead) / utf8ThreeByteLength,
    );
    const overByteLimit = `${atByteLimit}a`;

    expect(PluginUiLaunchInputV1Schema.safeParse(atByteLimit).success).toBe(true);
    expect(PluginUiLaunchInputV1Schema.safeParse(overByteLimit).success).toBe(false);
  });

  it('rejects accessors, cycles, and non-plain objects without throwing', () => {
    let accessorRead = false;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return 'must not be read';
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class NonPlainValue {
      readonly value = 'must not be accepted';
    }

    for (const value of [
      accessor,
      cyclic,
      new NonPlainValue(),
      new Date(),
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      let result: { success: boolean } | undefined;
      expect(() => {
        result = PluginUiJsonValueV1Schema.safeParse(value);
      }).not.toThrow();
      expect(result?.success).toBe(false);
      expect(PluginUiLaunchInputV1Schema.safeParse(value).success).toBe(false);
    }
    expect(accessorRead).toBe(false);
  });

  it('keeps ordinary JSON values valid', () => {
    const value = {
      nested: [null, true, 7, 'selection'],
      metadata: Object.assign(Object.create(null) as Record<string, unknown>, { id: 'preview' }),
    };

    const parsed = PluginUiJsonValueV1Schema.safeParse(value);
    expect(parsed).toMatchObject({ success: true });
    if (parsed.success) expect(parsed.data).toBe(value);
  });

  it('keeps hosted-web bridge parsing stack-safe for deep postMessage data', () => {
    const deepEnvelope = hostedBridgeEnvelope(nestedArray(12_000));
    let result: { success: boolean } | undefined;

    expect(() => {
      result = PluginHostedWebBridgeEnvelopeV1Schema.safeParse(deepEnvelope);
    }).not.toThrow();
    expect(result?.success).toBe(true);
  });
});
