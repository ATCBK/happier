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
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1, TriageSourceDescriptorV1Schema, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import { testkitEntryRef, testkitObservation } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { TriageCreateTaskActionInputV1Schema, TriageEditTaskActionInputV1Schema } from '../../actions/tasksProtocol.js';
import type { TriageMountedConfiguredSourceV1 } from '../configuration/useTriageConfiguredSources.js';
import { TriageCreateTaskFields, TriageEditTaskFields, useTriageTaskCommit } from './taskFields.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

function targetedTaskSource(source: TriageEntryRefV1['source'], kindId: string, role: 'create' | 'edit', readOnly = false): PluginUiTargetedContributionsV1 {
  const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
  const contributor = { pluginId: source.pluginId, contributionId: source.localId,
    occurrenceId: 'source-one', sourceCustody: { kind: 'development' as const, registeredRootId: 'task-source' } };
  return {
    target: { pluginId: 'happier.triage', occurrenceId: 'triage-one',
      sourceCustody: { kind: 'development', registeredRootId: 'triage-source' } },
    points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol, contributions: [{
      contributor, protocol,
      descriptor: TriageSourceDescriptorV1Schema.parse({ ...createTriageSourceV1Fixture().descriptor,
        kinds: [{ id: kindId, task: true, workflowSubject: 'issue', displayName: 'Issue',
          taskCapabilities: { [role === 'create' ? 'createFields' : 'editFields']: ['title'] } }] }),
      operations: readOnly ? [] : [{ point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol },
        contributor, role, action: { pluginId: source.pluginId, localId: role } }], surfaces: [],
    }] }] }],
  };
}

it('keeps task creation unavailable until sources are read and distinguishes settled emptiness from failure', async () => {
  let setReadiness!: React.Dispatch<React.SetStateAction<{ loaded: boolean; unavailableReason: string | null }>>;
  let setSources!: React.Dispatch<React.SetStateAction<readonly TriageMountedConfiguredSourceV1[]>>;
  const source = createTriageSourceV1Fixture();
  const saved: ReturnType<typeof TriageCreateTaskActionInputV1Schema.parse>[] = [];
  await act(async () => {
    mounted.push(await createPluginUiTestkit({ identity: { instanceId: 'task-create', mountNonce: 'readiness' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        const [readiness, update] = React.useState<{ loaded: boolean; unavailableReason: string | null }>({ loaded: false, unavailableReason: null });
        const [sources, updateSources] = React.useState<readonly TriageMountedConfiguredSourceV1[]>([]);
        setReadiness = update;
        setSources = updateSources;
        return <TriageCreateTaskFields sources={sources} sourcesLoaded={readiness.loaded}
          sourcesUnavailableReason={readiness.unavailableReason} disabled={false}
          draft={{ title: 'Fix reconnect handling' }}
          onApplied={async () => undefined} onClose={() => undefined} />;
      }),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, 'issue', 'create') }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { executeAction: ({ action, input }) => {
        expect(action).toBe('tasks/create-v1');
        saved.push(TriageCreateTaskActionInputV1Schema.parse(input));
        return { kind: 'refused', reason: 'unavailable' };
      } },
    }));
  });
  const picker = () => document.querySelector<HTMLElement>('[aria-label="Where?"]');
  expect(picker()?.getAttribute('aria-disabled')).toBe('true');
  expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(document.querySelector('[role="form"]')).toBeNull();
  await act(async () => { setReadiness({ loaded: true, unavailableReason: null }); });
  expect(document.querySelector('[role="progressbar"]')).toBeNull();
  expect(picker()?.getAttribute('aria-disabled')).toBe('true');
  expect(document.body.textContent).toContain('Add a source that supports creating tasks');
  await act(async () => { setSources([{ sourceInstanceId: source.configuredInstance.instance.sourceInstanceId,
    configured: source.configuredInstance, displayLabel: 'Engineering' }]); });
  expect(picker()?.getAttribute('aria-disabled')).not.toBe('true');
  await act(async () => { picker()?.click(); });
  const choice = document.querySelector<HTMLElement>('[role="menuitemradio"]');
  expect(choice).not.toBeNull();
  await act(async () => { choice?.click(); });
  expect(document.querySelector('[role="form"]')).not.toBeNull();
  await act(async () => { setReadiness({ loaded: true, unavailableReason: 'The Account is unavailable.' }); });
  expect(document.body.textContent).toContain('The Account is unavailable.');
  expect(document.querySelector('[role="form"]')).toBeNull();
  expect(document.body.textContent).toContain('Close');
  expect(saved).toEqual([]);
  await act(async () => { setReadiness({ loaded: true, unavailableReason: null }); });
  const fixture = mounted.at(-1)!;
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(saved).toHaveLength(1);
  expect(saved[0]?.fields).toEqual({ title: 'Fix reconnect handling' });
  expect(saved[0]?.sourceInstanceId).toBe(source.configuredInstance.instance.sourceInstanceId);
});

async function mountEditor(options: Readonly<{ readOnly?: boolean; uncertain?: boolean }> = {}) {
  const source = createTriageSourceV1Fixture();
  const entryRef = testkitEntryRef();
  const observation = testkitObservation();
  const row = foldTriageListWindow({ observations: [{ ...observation, entryRef }], lanes: [],
    configuredSourcesStatus: 'complete', activeSourceInstanceIds: [observation.sourceInstanceId],
    lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 1_000 }).rows[0]!;
  const targeted = targetedTaskSource(entryRef.source, entryRef.kindId, 'edit', options.readOnly);
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

it('offers no Edit task when the admitted source has no edit role', async () => {
  const { fixture, saved } = await mountEditor({ readOnly: true });
  // A control that can never succeed is not drawn (a greyed "Edit task" on every read-only source's entry).
  await expect(fixture.queryByRole('button', { name: 'Edit task' })).resolves.toBeUndefined();
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
