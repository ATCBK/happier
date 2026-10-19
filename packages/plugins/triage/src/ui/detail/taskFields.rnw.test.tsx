// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1, TriageSourceDescriptorV1Schema } from '@happier-dev/triage-protocol/v1';
import { testkitEntryRef, testkitObservation } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { TriageEditTaskActionInputV1Schema } from '../../actions/tasksProtocol.js';
import { TriageEditTaskFields, useTriageTaskCommit } from './taskFields.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

async function mountEditor(options: Readonly<{ readOnly?: boolean; uncertain?: boolean }> = {}) {
  const source = createTriageSourceV1Fixture();
  const entryRef = testkitEntryRef();
  const observation = testkitObservation();
  const row = foldTriageListWindow({ observations: [{ ...observation, entryRef }], lanes: [],
    configuredSourcesStatus: 'complete', activeSourceInstanceIds: [observation.sourceInstanceId],
    lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 1_000 }).rows[0]!;
  const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
  const contributor = { pluginId: entryRef.source.pluginId, contributionId: entryRef.source.localId,
    occurrenceId: 'source-one', sourceCustody: { kind: 'development' as const, registeredRootId: 'task-source' } };
  const targeted: PluginUiTargetedContributionsV1 = {
    target: { pluginId: 'happier.triage', occurrenceId: 'triage-one',
      sourceCustody: { kind: 'development', registeredRootId: 'triage-source' } },
    points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol, contributions: [{
      contributor, protocol,
      descriptor: TriageSourceDescriptorV1Schema.parse({ ...source.descriptor, kinds: [{ id: entryRef.kindId, task: true, workflowSubject: 'issue', displayName: 'Issue',
        taskCapabilities: { editFields: ['title'] } }] }),
      operations: options.readOnly ? [] : [{ point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol },
        contributor, role: 'edit', action: { pluginId: entryRef.source.pluginId, localId: 'edit' } }], surfaces: [],
    }] }] }],
  };
  const saved: ReturnType<typeof TriageEditTaskActionInputV1Schema.parse>[] = [];
  let rereads = 0;
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-edit', mountNonce: `edit-${mounted.length}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageEditTaskFields row={row} disabled={false} onApplied={async () => { rereads++; }} />),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: targeted }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      // Host Action transport is the genuine boundary; field drafts and capability decisions stay real.
      handlers: { executeAction: ({ action, input }) => {
        expect(action).toBe('tasks/edit-v1');
        saved.push(TriageEditTaskActionInputV1Schema.parse(input));
        return options.uncertain ? { kind: 'uncertain' } : { kind: 'applied', observation: {
          ...source.getResult, kind: 'present', localRef: { kindId: entryRef.kindId, collisionScope: entryRef.collisionScope, entryId: entryRef.entryId },
          locator: row.content!.outcome.locator, snapshot: { ...row.content!.outcome.snapshot, title: saved.at(-1)!.fields.title },
          viewer: { involvement: [] },
        } };
      } },
    });
  });
  mounted.push(fixture);
  return { fixture, saved, rereads: () => rereads };
}

it('keeps typing local, commits one edit, and does not replay an uncertain edit', async () => {
  const { fixture, saved, rereads } = await mountEditor({ uncertain: true });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit task' })); });
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Title"]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Fix reconnect handling');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(saved).toEqual([]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save changes' })); });
  expect(saved).toHaveLength(1);
  expect(saved[0]?.fields).toEqual({ title: 'Fix reconnect handling' });
  expect(rereads()).toBe(1);
  await act(async () => { await expect(fixture.press(await fixture.getByRole('button', { name: 'Save changes' }))).rejects.toMatchObject({ code: 'stale_surface' }); });
  expect(saved).toHaveLength(1);
});

it('refuses editing when the admitted source has no edit role', async () => {
  const { fixture, saved } = await mountEditor({ readOnly: true });
  await act(async () => { await expect(fixture.press(await fixture.getByRole('button', { name: 'Edit task' }))).rejects.toMatchObject({ code: 'stale_surface' }); });
  expect(document.querySelector('input[aria-label="Title"]')).toBeNull();
  expect(saved).toEqual([]);
});

it('does not report an unsettled commit when its authoritative reread fails', async () => {
  let write: ReturnType<typeof useTriageTaskCommit> | undefined;
  let calls = 0;
  await act(async () => {
    mounted.push(await createPluginUiTestkit({ identity: { instanceId: 'reread', mountNonce: 'reread' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        write = useTriageTaskCommit(async () => { throw new Error('Read transport unavailable'); });
        return null;
      }), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: () => { calls++; return { kind: 'uncertain' }; } },
    }));
  });
  await act(async () => {
    const commit = write!.commit;
    await expect(commit('tasks/edit-v1', {})).resolves.toBeUndefined();
    // A second activation can still hold the preceding render's callback.
    await commit('tasks/edit-v1', {});
  });
  expect(write!.result).toEqual({ kind: 'uncertain' });
  expect(write!.busy).toBe(false);
  await act(async () => { await write!.commit('tasks/edit-v1', {}); });
  expect(calls).toBe(1);
});
