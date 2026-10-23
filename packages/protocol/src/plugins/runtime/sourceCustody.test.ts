import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector/promises';
import { cloneStrictPluginJsonValue, rehydrateCanonicalProtocolComposableSchema } from '../actions/protocolComposableSchema.js';

import {
  pluginSourceCustodyV1Equal,
  PluginSourceCustodyV1Schema,
  PluginSourceCustodyV1ProtocolSchema,
  normalizePluginSourceCustodyV1,
  ManagedPluginSourceCustodyV1ProtocolSchema,
  BundledFirstPartyPluginSourceCustodyV1ProtocolSchema,
  DevelopmentPluginSourceCustodyV1ProtocolSchema,
} from './sourceCustody';

describe('PluginSourceCustodyV1', () => {
  it('admits a trusted host declaration by package identity without a content witness', () => {
    const source = { kind: 'bundled_first_party', packagedRuntime: {
      kind: 'source_declaration', packageName: '@acme/portable-actions',
    } } as const;
    const admitted = normalizePluginSourceCustodyV1(source);
    expect(admitted).toEqual(source);
    expect(pluginSourceCustodyV1Equal(admitted, normalizePluginSourceCustodyV1(source))).toBe(true);
    expect(pluginSourceCustodyV1Equal(admitted, normalizePluginSourceCustodyV1({
      ...source, packagedRuntime: { ...source.packagedRuntime, packageName: '@acme/other-actions' },
    }))).toBe(false);
    expect(PluginSourceCustodyV1Schema.safeParse({ ...source,
      packagedRuntime: { ...source.packagedRuntime, authority: 'unrestricted' },
    }).success).toBe(false);
    expect(() => normalizePluginSourceCustodyV1({
      kind: 'bundled_first_party', packagedRuntime: { kind: 'app_bundle', bundleId: 'retired-content-custody' },
    })).toThrow();
  });
  it('retains exact Account-release custody without manufacturing a Machine generation', () => {
    const custody = { kind: 'account_release', pluginId: 'acme.account', version: '1.0.0', archiveDigestSha256: `sha256:${'a'.repeat(64)}` };
    const admitted = PluginSourceCustodyV1Schema.parse(custody);
    expect(admitted).toEqual(custody);
    expect(pluginSourceCustodyV1Equal(admitted, PluginSourceCustodyV1Schema.parse({ ...custody, version: '1.0.1' }))).toBe(false);
    expect(PluginSourceCustodyV1Schema.safeParse({ ...custody, machineId: 'machine' }).success).toBe(false);
  });
  // Owns V8's coverage session, so keep it out of ordinary coverage runs.
  it.skipIf(process.env.HAPPIER_SOURCE_CUSTODY_PERF !== '1')('does not construct validation errors while admitting valid development custody', async () => {
    // Measure real V8 execution, not a replacement of the schema or Error class.
    const session = new Session();
    session.connect();
    try {
      await session.post('Profiler.enable');
      await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
      expect(PluginSourceCustodyV1ProtocolSchema.safeParse({ kind: 'development', registeredRootId: 'root-a' }).success).toBe(true);
      const coverage = await session.post('Profiler.takePreciseCoverage');
      const constructorCalls = coverage.result.filter(script => script.url.includes('/plugins/actions/protocolComposableSchema'))
        .flatMap(script => script.functions)
        .filter(fn => fn.functionName === 'ProtocolValidationError')
        .reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0);
      expect(constructorCalls).toBe(0);
      expect(PluginSourceCustodyV1ProtocolSchema.safeParse({ kind: 'development', registeredRootId: 7 }).success).toBe(false);
      const refusedCoverage = await session.post('Profiler.takePreciseCoverage');
      const refusedConstructorCalls = refusedCoverage.result.filter(script => script.url.includes('/plugins/actions/protocolComposableSchema'))
        .flatMap(script => script.functions).filter(fn => fn.functionName === 'ProtocolValidationError')
        .reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0);
      expect(refusedConstructorCalls).toBeGreaterThan(0);
    } finally {
      await session.post('Profiler.stopPreciseCoverage');
      session.disconnect();
    }
  });
  it('preserves portable union admission and failure diagnostics for every custody arm', () => {
    const portable = rehydrateCanonicalProtocolComposableSchema(PluginSourceCustodyV1ProtocolSchema.jsonSchema);
    expect(portable).not.toBeNull();
    for (const value of [
      { kind: 'account_release', pluginId: 'acme.plugin', version: '1.0.0', archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
      { kind: 'bundled_first_party', packagedRuntime: { kind: 'app_bundle', bundleId: 'app-content' } },
      { kind: 'bundled_first_party', packagedRuntime: { kind: 'source_declaration', packageName: '@happier-dev/plugins-triage' } },
      { kind: 'managed', immutableGenerationId: 'generation-a', installSource: 'archive' },
      { kind: 'bundled_first_party', packagedRuntime: { kind: 'pinned_runner_snapshot', snapshotId: 'snapshot-a' } },
      { kind: 'development', registeredRootId: 'root-a' },
      { kind: 'development', registeredRootId: 'root-a', extra: true },
      { kind: 'development', registeredRootId: 7 },
      { kind: 'unknown' },
      null,
    ]) {
      const actual = PluginSourceCustodyV1ProtocolSchema.safeParse(value);
      const expected = portable!.safeParse(value);
      expect(actual.success).toBe(expected.success);
      if (actual.success && expected.success) expect(actual.data).toEqual(expected.data);
      if (!actual.success && !expected.success) expect(actual.error.issues).toEqual(expected.error.issues);
    }
  });

  it.skipIf(process.env.HAPPIER_SOURCE_CUSTODY_PERF !== '1')('measures custody admission against eager arm probing in the same process', () => {
    // Original union algorithm, using the real unchanged member parsers. This
    // opt-in control is not another production validator or a time budget.
    const eagerAdmission = (value: unknown) => {
      const input = cloneStrictPluginJsonValue(value, 'value');
      for (const schema of [ManagedPluginSourceCustodyV1ProtocolSchema,
        BundledFirstPartyPluginSourceCustodyV1ProtocolSchema, DevelopmentPluginSourceCustodyV1ProtocolSchema]) {
        const parsed = schema.safeParse(input);
        if (parsed.success) {
          const data = parsed.data === input ? input : cloneStrictPluginJsonValue(parsed.data, 'value');
          return Object.freeze({ success: true, data }).success;
        }
      }
      return false;
    };
    const values = [
      { kind: 'managed', immutableGenerationId: 'generation-a', installSource: 'archive' },
      { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'version-a' } },
      { kind: 'bundled_first_party', packagedRuntime: { kind: 'pinned_runner_snapshot', snapshotId: 'snapshot-a' } },
      { kind: 'development', registeredRootId: 'root-a' },
    ];
    const measurements = values.map(value => {
      const ownerAdmission = (input: unknown) => PluginSourceCustodyV1ProtocolSchema.safeParse(input).success;
      for (let index = 0; index < 100; index += 1) {
        expect(eagerAdmission(value)).toBe(true);
        expect(ownerAdmission(value)).toBe(true);
      }
      const measure = (admit: (value: unknown) => boolean) => {
        const started = performance.now();
        for (let index = 0; index < 1000; index += 1) {
          if (!admit(value)) throw new Error('Benchmark input was not admitted');
        }
        return performance.now() - started;
      };
      const eagerSamples: number[] = [];
      const ownerSamples: number[] = [];
      for (let sample = 0; sample < 5; sample += 1) {
        if (sample % 2 === 0) {
          eagerSamples.push(measure(eagerAdmission));
          ownerSamples.push(measure(ownerAdmission));
        } else {
          ownerSamples.push(measure(ownerAdmission));
          eagerSamples.push(measure(eagerAdmission));
        }
      }
      const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[2]!;
      return { kind: value.kind, packagedKind: value.packagedRuntime?.kind,
        eagerMs: median(eagerSamples), ownerMs: median(ownerSamples), eagerSamples, ownerSamples };
    });
    console.info(JSON.stringify({ sourceCustodyAdmission: measurements }));
  });
  it.each([
    { kind: 'managed', immutableGenerationId: 'generation-a', installSource: 'npm' },
    {
      kind: 'bundled_first_party',
      packagedRuntime: { kind: 'cli_version_root', versionRootId: 'versions/0.3.0' },
    },
    {
      kind: 'bundled_first_party',
      packagedRuntime: { kind: 'pinned_runner_snapshot', snapshotId: 'snapshot-a' },
    },
    { kind: 'development', registeredRootId: 'root-a' },
  ] as const)('normalizes strict $kind custody', (custody) => {
    expect(normalizePluginSourceCustodyV1(custody)).toEqual(custody);
    expect(PluginSourceCustodyV1Schema.parse(custody)).toEqual(custody);
    expect(PluginSourceCustodyV1ProtocolSchema.parse(custody)).toEqual(custody);
  });

  it('rejects managed generation fields on bundled and development custody', () => {
    expect(() => normalizePluginSourceCustodyV1({
      kind: 'bundled_first_party',
      packagedRuntime: { kind: 'cli_version_root', versionRootId: 'versions/0.3.0' },
      immutableGenerationId: 'forbidden',
    })).toThrow();
    expect(() => normalizePluginSourceCustodyV1({
      kind: 'development',
      registeredRootId: 'root-a',
      immutableGenerationId: 'forbidden',
    })).toThrow();
  });

  it('never admits process-local occurrence identity into durable custody', () => {
    const invalid = {
      kind: 'development',
      registeredRootId: 'root-a',
      occurrenceId: 'process-local-occurrence',
    } as const;
    expect(() => normalizePluginSourceCustodyV1(invalid)).toThrow();
    expect(PluginSourceCustodyV1ProtocolSchema.safeParse(invalid).success).toBe(false);
  });

  it('keeps the Zod and composable schemas equivalent while normalization trims identities', () => {
    const padded = {
      kind: 'development',
      registeredRootId: '  root-a  ',
    } as const;
    expect(PluginSourceCustodyV1Schema.parse(padded)).toEqual(padded);
    expect(PluginSourceCustodyV1ProtocolSchema.parse(padded)).toEqual(padded);
    expect(normalizePluginSourceCustodyV1(padded)).toEqual({
      kind: 'development',
      registeredRootId: 'root-a',
    });

    const blank = { kind: 'development', registeredRootId: '   ' } as const;
    expect(PluginSourceCustodyV1Schema.safeParse(blank).success).toBe(false);
    expect(PluginSourceCustodyV1ProtocolSchema.safeParse(blank).success).toBe(false);
  });

  it('compares normalized custody structurally by source arm', () => {
    const managed = normalizePluginSourceCustodyV1({
      kind: 'managed',
      immutableGenerationId: 'generation-a',
      installSource: 'archive',
    });
    expect(pluginSourceCustodyV1Equal(managed, { ...managed })).toBe(true);
    expect(pluginSourceCustodyV1Equal(managed, {
      ...managed,
      immutableGenerationId: 'generation-b',
    })).toBe(false);
    expect(pluginSourceCustodyV1Equal(
      normalizePluginSourceCustodyV1({
        kind: 'bundled_first_party',
        packagedRuntime: { kind: 'cli_version_root', versionRootId: 'version-a' },
      }),
      normalizePluginSourceCustodyV1({
        kind: 'bundled_first_party',
        packagedRuntime: { kind: 'pinned_runner_snapshot', snapshotId: 'version-a' },
      }),
    )).toBe(false);
  });
});
