import { expect, it } from 'vitest';

import { joinInstalledCatalogRuntimeIntrospection } from '@/plugins/projection/introspection/catalogSnapshot';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { readCurrentDaemonPluginCatalogSnapshot } from './currentCatalog';

it('projects a live catalog without multiplying whole-registry policy work by the number of entries', async () => {
  const fixture = await createAdmittedPluginRuntimeFixture();
  try {
    const read = () => readCurrentDaemonPluginCatalogSnapshot({
      reloadController: fixture.controller,
      happyHomeDir: fixture.happyHomeDir,
    });
    const initial = await read();
    expect(initial.plugins.length).toBeGreaterThan(1);
    const registry = fixture.registry;
    const projectOnce = () => joinInstalledCatalogRuntimeIntrospection(initial.plugins, {
      generation: registry.generation,
      targetActivationFacts: registry.targetActivationFacts,
      pluginDiagnosticsByPluginId: registry.pluginDiagnosticsByPluginId,
      pluginFinalPolicyCurrentRuntimesById: registry.pluginFinalPolicyCurrentRuntimesById,
    });
    await read();
    projectOnce();
    const cpuMs = (start: NodeJS.CpuUsage) => {
      const usage = process.cpuUsage(start);
      return (usage.user + usage.system) / 1_000;
    };
    // Compare the actual read to the same real projection with each live map
    // acquired once. CPU time avoids worker scheduling delay; repeated batches
    // amortize GC. The generous ratio detects entry-count multiplication, not
    // small platform-dependent differences or an absolute latency promise.
    const reads: number[] = [];
    const projections: number[] = [];
    for (let batch = 0; batch < 5; batch++) {
      let start = process.cpuUsage();
      for (let index = 0; index < 10; index++) await read();
      reads.push(cpuMs(start));
      start = process.cpuUsage();
      for (let index = 0; index < 10; index++) projectOnce();
      projections.push(cpuMs(start));
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[2]!;
    console.info('catalog CPU benchmark', JSON.stringify({
      plugins: initial.plugins.length,
      readMs: median(reads) / 10,
      onceProjectedMs: median(projections) / 10,
      ratio: median(reads) / median(projections),
    }));
    expect(median(reads) / median(projections)).toBeLessThan(2);
    // A subsequent read still derives facts from the live owner: retention
    // across calls must not advertise a fenced plugin as applied.
    const applied = initial.plugins.find(entry => entry.appliedGeneration !== null);
    expect(applied).toBeDefined();
    await registry.recordPluginActivationFailure?.(applied!.pluginId, 'performance fixture retirement');
    const retired = await read();
    expect(retired.plugins.find(entry => entry.pluginId === applied!.pluginId)?.appliedGeneration).toBeNull();
  } finally {
    await fixture.dispose();
  }
}, 180_000);
