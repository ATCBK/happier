import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { assertTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import { TriageScanResultV1Schema, TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { runTriageScanPass } from '../../triage/src/projection/scanPass.js';
import { LINEAR_PLUGIN } from './manifest.js';
import { host, instance, issue, page } from './fixtures.test-support.js';

describe('public Linear source composition', () => {
  it('exposes the canonical create role as the registered outward-write Action', async () => {
    let created = false;
    const h = host(({ operationName }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearTeam') return { team: issue.team };
      if (operationName === 'LinearCreate') { created = true; return { issueCreate: { success: true, issue: { id: issue.id } } }; }
      return { issue: { ...issue, title: created ? 'Composed task' : issue.title } };
    });
    const kit = await createPluginTestkit({ manifest: LINEAR_PLUGIN.manifest, module: LINEAR_PLUGIN, services: h.context.services });
    try {
      const contribution = LINEAR_PLUGIN.manifest.contributes.targetedPluginContributions[0]!;
      const result = TriageTaskWriteResultV1Schema.parse(await kit.invokeAction(contribution.operations.create!,
        { v: 1, instance, kindId: 'issue', fields: { title: 'Composed task' } }));
      expect(result).toMatchObject({ kind: 'applied', observation: { snapshot: { title: 'Composed task' } } });
      expect(LINEAR_PLUGIN.manifest.contributes.actions.find((action) => action.id === contribution.operations.create)?.dangerLevel).toBe('writesRemote');
    } finally { await kit.dispose(); }
  });
  it('reaches provider HTTP through the declared role and registered Action, then qualifies the row in the real aggregate', async () => {
    assertTriageSourceContributionV1(LINEAR_PLUGIN.manifest);
    const h = host(({ operationName, variables }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } }
      : { issues: page([{ ...issue, id: variables.after ? 'issue-2' : issue.id }], !variables.after, variables.after ? null : 'next') });
    const kit = await createPluginTestkit({ manifest: LINEAR_PLUGIN.manifest, module: LINEAR_PLUGIN, services: h.context.services });
    try {
      const contribution = LINEAR_PLUGIN.manifest.contributes.targetedPluginContributions[0]!;
      const result = await runTriageScanPass({
        lanes: [{ sourceInstanceId: instance.instance.sourceInstanceId, source: instance.instance.source,
          declaredKindIds: ['issue'], configured: instance,
          scan: async (input, options) => TriageScanResultV1Schema.parse(await kit.invokeAction(contribution.operations.scan!, input, { signal: options?.signal })),
        }], pageLimit: 1, observationBudget: 2, nowMs: () => 1000,
      });
      expect(result.lanes[0]?.health).toEqual({ kind: 'walkFinished' });
      expect(result.lanes[0]?.exhausted).toBe(true);
      expect(result.observations.map((observation) => observation.entryRef.entryId)).toEqual(['issue-1', 'issue-2']);
      expect(h.request).toHaveBeenCalled();
    } finally { await kit.dispose(); }
  });
});
