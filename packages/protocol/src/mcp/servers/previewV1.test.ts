import { describe, expect, it } from 'vitest';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { SpawnCapabilitiesPreviewOutputV1Schema } from '../../actions/specs/sessionCapabilities.js';

import {
  DaemonMcpServersPreviewRequestSchema, DaemonMcpServersPreviewResponseSchema,
  ManagedMcpPreviewEntryV1Schema, ManagedSessionMcpAvailabilityV1Schema,
  ManagedSessionMcpReasonCodeV1Schema, ManagedSessionMcpPortabilityV1Schema,
} from './previewV1.js';

describe('DaemonMcpServersPreview schemas', () => {
  it('accepts a preview request with a session selection override', () => {
    const parsed = DaemonMcpServersPreviewRequestSchema.parse({
      machineId: 'machine-1',
      directory: '/repo',
      agentId: 'codex',
      selection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-a'],
        forceExcludeServerIds: ['server-b'],
      },
    });

    expect(parsed.agentId).toBe('codex');
    expect(parsed.selection?.forceIncludeServerIds).toEqual(['server-a']);
  });

  it('accepts a successful preview response with built-in, managed, and detected entries', () => {
    const parsed = DaemonMcpServersPreviewResponseSchema.parse({
      ok: true,
      builtIn: [
        {
          key: 'built-in:happier',
          name: 'happier',
          transport: 'stdio',
          authMode: 'none',
          selected: true,
          selectable: false,
          availability: 'active',
          sourceKind: 'builtIn',
          scopeKind: 'builtIn',
        },
      ],
      managed: [
        {
          key: 'managed:server-a',
          serverId: 'server-a',
          name: 'playwright',
          transport: 'stdio',
          authMode: 'none',
          selected: true,
          selectable: true,
          availability: 'active',
          sourceKind: 'managed',
          scopeKind: 'machine',
          reasonCode: 'active_by_default',
          portability: 'portable',
          defaultSelected: true,
        },
      ],
      detected: [
        {
          key: 'detected:codex:context7',
          name: 'context7',
          transport: 'stdio',
          authMode: 'unknown',
          selected: true,
          selectable: false,
          availability: 'readOnly',
          sourceKind: 'detected',
          scopeKind: 'providerUser',
          provider: 'codex',
          envKeyCount: 0,
          headerKeyCount: 0,
          enabled: true,
          sourcePath: '/Users/test/.codex/config.toml',
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error('expected preview success');
    }
    expect(parsed.builtIn[0]?.name).toBe('happier');
    expect(parsed.managed[0]?.reasonCode).toBe('active_by_default');
    expect(parsed.detected[0]?.provider).toBe('codex');
  });

  it('projects finite managed preview values without changing custom admission errors', () => {
    const values = [
      [ManagedSessionMcpAvailabilityV1Schema, ['active', 'available', 'unavailable']],
      [ManagedSessionMcpReasonCodeV1Schema, ['active_by_default', 'forced_included', 'forced_excluded',
        'managed_servers_disabled', 'binding_disabled', 'available_portable', 'not_portable']],
      [ManagedSessionMcpPortabilityV1Schema, ['portable', 'machine_scoped']],
    ] as const;
    for (const [schema, accepted] of values) {
      for (const value of accepted) expect(schema.parse(value)).toBe(value);
      for (const invalid of ['not_a_value', null]) {
        const result = schema.safeParse(invalid);
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues.map(({ code, path, message }) => ({ code, path, message })))
          .toEqual([{ code: 'custom', path: [], message: 'Invalid input' }]);
      }
      expect(zodSchemaToJsonSchemaObject(schema, { target: 'draft-7' }))
        .toMatchObject({ type: 'string', enum: accepted });
    }

    const invalidManaged = ManagedMcpPreviewEntryV1Schema.safeParse({
      key: 'managed:server-a', serverId: 'server-a', name: 'playwright', transport: 'stdio', authMode: 'none',
      selected: true, selectable: true, availability: 'active', sourceKind: 'managed', scopeKind: 'machine',
      reasonCode: 'not_a_value', portability: 'not_a_value', defaultSelected: true,
    });
    expect(invalidManaged.success).toBe(false);
    if (!invalidManaged.success) expect(invalidManaged.error.issues.map(({ code, path, message }) => ({ code, path, message })))
      .toEqual([
        { code: 'custom', path: ['reasonCode'], message: 'Invalid input' },
        { code: 'custom', path: ['portability'], message: 'Invalid input' },
      ]);
    expect(zodSchemaToJsonSchemaObject(SpawnCapabilitiesPreviewOutputV1Schema, { target: 'draft-7' }))
      .toMatchObject({ anyOf: expect.any(Array) });
  });
});
