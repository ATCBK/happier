import { describe, expect, it } from 'vitest';
import * as origins from './pluginMachineExecutionOriginV1.js';

import { compilePluginJsonSchema } from '../../plugins/actions/jsonSchemaValidation.js';
import {
  arePluginMachineMaterializationRefsEqual,
  arePluginMachineExecutionOriginsEqual,
  PluginMachineExecutionOriginV1JsonSchema,
  PluginMachineExecutionOriginV1Schema,
  PluginMachineExecutionRoutingV1Schema,
  PluginMachineExecutionRoutingV1JsonSchema,
  getPluginMachineExecutionRouting,
  arePluginMachineExecutionRoutingsEqual,
} from './pluginMachineExecutionOriginV1.js';

describe('PluginMachineExecutionOriginV1', () => {
  it('selects skill bytes by exact chosen source or agreeing current content without requiring executable placement', () => {
    const origin = (machineId: string) => ({ serverIdentityId: 'srv_account_one', sourceRef: {
      machineId, pluginId: 'acme.plugin', sourceCustody: { kind: 'development' as const, registeredRootId: machineId },
    } });
    const source = (machineId: string, contentKey = 'same', version = '1.0.0', available = true) => ({
      value: machineId, origin: origin(machineId), version, contentKey, available,
    });
    expect(origins.resolvePluginContentSuppliesV1({ supplies: [source('a')] })).toEqual({ kind: 'ready', supplies: ['a'] });
    const installed = { ...source('installed-local-path'), origin: { serverIdentityId: 'srv_account_one', materializationRef: {
      machineId: 'installed-local-path', pluginId: 'acme.plugin', materializationId: 'installed-occurrence',
    } } };
    expect(origins.resolvePluginContentSuppliesV1({ supplies: [installed], selectedOrigin: installed.origin }))
      .toEqual({ kind: 'ready', supplies: ['installed-local-path'] });
    expect(origins.resolvePluginContentSuppliesV1({ supplies: [installed], selectedOrigin: {
      ...installed.origin, materializationRef: { ...installed.origin.materializationRef, materializationId: 'retired-occurrence' },
    } })).toEqual({ kind: 'unavailable' });
    expect(origins.resolvePluginContentSuppliesV1({ supplies: [source('a'), source('b')] })).toEqual({ kind: 'ready', supplies: ['a', 'b'] });
    expect(origins.resolvePluginContentSuppliesV1({ supplies: [source('a'), source('b', 'different')] })).toEqual({ kind: 'conflict' });
    expect(origins.resolvePluginContentSuppliesV1({ supplies: [source('a'), source('b', 'same', '2.0.0')] })).toEqual({ kind: 'conflict' });
    expect(origins.resolvePluginContentSuppliesV1({ supplies: [source('a'), source('b', 'different')], selectedOrigin: origin('b') }))
      .toEqual({ kind: 'ready', supplies: ['b'] });
    expect(origins.resolvePluginContentSuppliesV1({ supplies: [source('a')], selectedOrigin: origin('b') })).toEqual({ kind: 'unavailable' });
    expect(origins.resolvePluginContentSuppliesV1({ supplies: [source('a'), source('b', 'same', '1.0.0', false)], selectedOrigin: origin('b') }))
      .toEqual({ kind: 'unavailable' });
    expect(origins.resolvePluginContentSuppliesV1({ supplies: [] })).toEqual({ kind: 'unavailable' });
  });
  it('projects closed routing from either custody kind while retaining exact origin identity', () => {
    const materialized = { serverIdentityId: 'srv_account_one', materializationRef: {
      machineId: 'machine-a', pluginId: 'acme.plugin', materializationId: 'mat-a',
    } };
    const source = { serverIdentityId: 'srv_account_one', sourceRef: {
      machineId: 'machine-a', pluginId: 'acme.plugin',
      sourceCustody: { kind: 'development' as const, registeredRootId: 'root-a' },
    } };
    const routing = getPluginMachineExecutionRouting(materialized);
    expect(routing).toEqual({ serverIdentityId: 'srv_account_one', machineId: 'machine-a', pluginId: 'acme.plugin' });
    expect(arePluginMachineExecutionRoutingsEqual(routing, getPluginMachineExecutionRouting(source))).toBe(true);
    expect(arePluginMachineExecutionOriginsEqual(materialized, source)).toBe(false);
    const validates = compilePluginJsonSchema(PluginMachineExecutionRoutingV1JsonSchema);
    for (const value of [routing, { ...routing, materializationId: 'mat-a' }, { ...routing, pluginId: 'INVALID' }, { ...routing, serverIdentityId: 'local' }]) {
      expect(validates(value)).toBe(PluginMachineExecutionRoutingV1Schema.safeParse(value).success);
    }
    expect(validates(routing)).toBe(true);
    expect(validates({ ...routing, materializationId: 'mat-a' })).toBe(false);
  });
  it('preserves exact source custody without manufacturing a materialization identity', () => {
    const origin = {
      serverIdentityId: 'srv_account_one',
      sourceRef: {
        machineId: 'machine-a',
        pluginId: 'acme.plugin',
        sourceCustody: { kind: 'development', registeredRootId: 'registered-source-a' },
      },
    } as const;
    expect(PluginMachineExecutionOriginV1Schema.safeParse(origin).success).toBe(true);
    expect(compilePluginJsonSchema(PluginMachineExecutionOriginV1JsonSchema)(origin)).toBe(true);
    expect(PluginMachineExecutionOriginV1Schema.safeParse({
      ...origin, sourceRef: { ...origin.sourceRef, materializationId: 'invented' },
    }).success).toBe(false);
    expect(arePluginMachineExecutionOriginsEqual(origin, origin)).toBe(true);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin,
      sourceRef: { ...origin.sourceRef, sourceCustody: { kind: 'development', registeredRootId: 'registered-source-b' } },
    })).toBe(false);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin,
      sourceRef: { ...origin.sourceRef, machineId: 'machine-b' },
    })).toBe(false);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin,
      sourceRef: { ...origin.sourceRef, pluginId: 'acme.other' },
    })).toBe(false);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin, serverIdentityId: 'srv_account_two',
    })).toBe(false);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      serverIdentityId: origin.serverIdentityId,
      materializationRef: { machineId: 'machine-a', pluginId: 'acme.plugin', materializationId: 'registered-source-a' },
    })).toBe(false);
  });
  it('projects its exact portable identity as a reusable plugin JSON Schema fragment', () => {
    const validates = compilePluginJsonSchema(PluginMachineExecutionOriginV1JsonSchema);
    const canonical = {
      serverIdentityId: 'srv_account_one',
      materializationRef: {
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
      },
    } as const;

    expect(validates(canonical)).toBe(true);
    expect(validates({ ...canonical, serverIdentityId: 'local-profile' })).toBe(false);
    expect(validates({ ...canonical, serverIdentityId: 'srv_account_one\n' })).toBe(false);
    expect(validates({
      ...canonical,
      materializationRef: { ...canonical.materializationRef, pluginId: 'ACME.PLUGIN' },
    })).toBe(false);
    expect(validates({
      ...canonical,
      materializationRef: { ...canonical.materializationRef, pluginId: 'acme.constructor' },
    })).toBe(false);
    expect(validates({
      ...canonical,
      materializationRef: { ...canonical.materializationRef, materializationId: 'mat-a\n' },
    })).toBe(false);
    expect(validates({ ...canonical, unexpected: true })).toBe(false);
  });

  it('composes canonical server identity with the exact Artifact materialization reference', () => {
    expect(PluginMachineExecutionOriginV1Schema.parse({
      serverIdentityId: 'srv_account_one',
      materializationRef: {
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
      },
    })).toEqual({
      serverIdentityId: 'srv_account_one',
      materializationRef: {
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
      },
    });
  });

  it('compares every server and materialization identity fact exactly', () => {
    const origin = Object.freeze({
      serverIdentityId: 'srv_account_one',
      materializationRef: Object.freeze({
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
      }),
    });

    expect(arePluginMachineExecutionOriginsEqual(origin, origin)).toBe(true);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin,
      serverIdentityId: 'srv_account_two',
    })).toBe(false);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin,
      materializationRef: { ...origin.materializationRef, pluginId: 'acme.other' },
    })).toBe(false);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin,
      materializationRef: { ...origin.materializationRef, machineId: 'machine-b' },
    })).toBe(false);
    expect(arePluginMachineExecutionOriginsEqual(origin, {
      ...origin,
      materializationRef: { ...origin.materializationRef, materializationId: 'mat-b' },
    })).toBe(false);

    expect(arePluginMachineMaterializationRefsEqual(
      origin.materializationRef,
      origin.materializationRef,
    )).toBe(true);
    expect(arePluginMachineMaterializationRefsEqual(origin.materializationRef, {
      ...origin.materializationRef,
      materializationId: 'mat-b',
    })).toBe(false);
  });

  it('rejects device-local server ids and widened materialization facts', () => {
    expect(PluginMachineExecutionOriginV1Schema.safeParse({
      serverIdentityId: 'local-profile',
      materializationRef: {
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
      },
    }).success).toBe(false);

    expect(PluginMachineExecutionOriginV1Schema.safeParse({
      serverIdentityId: 'srv_account_one',
      materializationRef: {
        machineId: 'machine-a',
        materializationId: 'mat-a',
        pluginId: 'acme.plugin',
        generation: 7,
      },
    }).success).toBe(false);
  });
});
