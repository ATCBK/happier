// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1, TriageSourceDescriptorV1Schema,
  type TriageTaskCapabilitiesV1, type TriageTaskFieldV1, type TriageTaskFieldsV1, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import { testkitEntryRef, testkitObservation } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { TriageCreateTaskActionInputV1Schema, TriageEditTaskActionInputV1Schema } from '../../actions/tasksProtocol.js';
import { TriageListEntriesInputV1Schema } from '../../actions/listEntriesProtocol.js';
import type { TriageMountedConfiguredSourceV1 } from '../configuration/useTriageConfiguredSources.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { useTriageListWindow } from '../window/useTriageListWindow.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { TriageCreateTaskFields, TriageEditTaskScope, TriageTaskRowStatusControl, useTriageTaskCommit } from './taskFields.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

function targetedTaskSource(source: TriageEntryRefV1['source'], kindId: string, role: 'create' | 'edit', readOnly = false,
  fields: readonly TriageTaskFieldV1[] = ['title', 'body'],
  transitions: NonNullable<TriageTaskCapabilitiesV1['transitions']> = []): PluginUiTargetedContributionsV1 {
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
          taskCapabilities: { [role === 'create' ? 'createFields' : 'editFields']: fields,
            ...(transitions.length === 0 ? {} : { transitions }) } }] }),
      operations: readOnly ? [] : [role, 'get', ...(transitions.length === 0 ? [] : ['transition'])].map(operationRole => ({ point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol },
        contributor, role: operationRole, action: { pluginId: source.pluginId, localId: operationRole } })), surfaces: [],
    }] }] }],
  };
}

it.each([false, true])('submits a create through the Account aggregate without a Machine once sources are ready (Account data: %s)', async (accountData) => {
  let setReadiness!: React.Dispatch<React.SetStateAction<{ loaded: boolean; unavailableReason: string | null }>>;
  let setSources!: React.Dispatch<React.SetStateAction<readonly TriageMountedConfiguredSourceV1[]>>;
  const sourceFixture = createTriageSourceV1Fixture();
  const source = { ...sourceFixture, configuredInstance: { ...sourceFixture.configuredInstance,
    binding: accountData ? { purpose: sourceFixture.descriptor.purpose, source: 'accountData' as const } : sourceFixture.configuredInstance.binding } };
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
          sourcesUnavailableReason={readiness.unavailableReason}
          draft={{ title: 'Fix reconnect handling' }}
          onApplied={async () => undefined} onClose={() => undefined} />;
      }),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, 'issue', 'create'),
        machineConnectionPending: true, machineExecutionReady: false }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { executeAction: ({ action, input }) => {
        expect(action).toBe('tasks/create-v1');
        saved.push(TriageCreateTaskActionInputV1Schema.parse(input));
        return { kind: 'refused', reason: 'unavailable' };
      } },
    }));
  });
  const fixture = mounted.at(-1)!;
  const place = () => fixture.getByRole('button', { name: 'Engineering' });
  // Where comes first (lab `tasks-create`): no place can be chosen while the sources are still being read.
  await expect(place()).rejects.toBeDefined();
  expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(document.querySelector('[role="form"]')).toBeNull();
  await act(async () => { setReadiness({ loaded: true, unavailableReason: null }); });
  expect(document.querySelector('[role="progressbar"]')).toBeNull();
  await expect(place()).rejects.toBeDefined();
  expect(document.body.textContent).toContain('Add a source that supports creating tasks');
  await act(async () => { setSources([{ sourceInstanceId: source.configuredInstance.instance.sourceInstanceId,
    configured: source.configuredInstance, displayLabel: 'Engineering' }]); });
  expect((await place()).state?.disabled).not.toBe(true);
  await act(async () => { await fixture.press(await place()); });
  expect(document.querySelector('[role="form"]')).not.toBeNull();
  // The chosen place stays named above its form and leads back to the list without losing the draft.
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Change' })); });
  expect(document.querySelector('[role="form"]')).toBeNull();
  await act(async () => { await fixture.press(await place()); });
  expect(document.querySelector('[role="form"]')).not.toBeNull();
  expect((await fixture.getByRole('button', { name: 'Create task' })).state?.disabled).not.toBe(true);
  await act(async () => { setReadiness({ loaded: true, unavailableReason: 'The Account is unavailable.' }); });
  expect(document.body.textContent).toContain('The Account is unavailable.');
  expect(document.querySelector('[role="form"]')).toBeNull();
  expect(saved).toEqual([]);
  await act(async () => { setReadiness({ loaded: true, unavailableReason: null }); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(saved).toHaveLength(1);
  expect(saved[0]?.fields).toEqual({ title: 'Fix reconnect handling' });
  expect(saved[0]?.sourceInstanceId).toBe(source.configuredInstance.instance.sourceInstanceId);
});

it('opens the created task before a mounted aggregate reread settles and preserves the applied write when that read fails', async () => {
  const source = createTriageSourceV1Fixture();
  const scope = createTriageEphemeralSharedScopeFixture();
  const saved: ReturnType<typeof TriageCreateTaskActionInputV1Schema.parse>[] = [];
  let readStarted!: () => void;
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  let rejectRead!: (error: Error) => void;
  const heldRead = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  let window!: ReturnType<typeof useTriageListWindow>;
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'created-task', mountNonce: 'held-read' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        window = useTriageListWindow();
        const [created, setCreated] = React.useState<TriageEntryRefV1 | null>(null);
        return created === null ? <TriageCreateTaskFields sources={[{
          sourceInstanceId: source.configuredInstance.instance.sourceInstanceId,
          configured: source.configuredInstance, displayLabel: 'Engineering',
        }]} sourcesLoaded sourcesUnavailableReason={null} draft={{ title: 'Saved Account task' }}
          onApplied={() => window.refresh('manual')} onClose={() => undefined}
          onCreated={result => setCreated(result.entryRef)} />
          : <Text value={created.entryId} />;
      }),
      surfaceContext: createSurfaceContextFixture({
        targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, 'issue', 'create'),
        machineConnectionPending: true, machineExecutionReady: false,
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope }),
      // The SDK host request is the genuine boundary. Commit, form and mounted
      // refresh/coalescing owners are real; only the aggregate transport is held.
      handlers: { executeAction: ({ action, input }) => {
        if (action === 'tasks/create-v1') {
          saved.push(TriageCreateTaskActionInputV1Schema.parse(input));
          return { kind: 'applied', observation: source.getResult };
        }
        expect(action).toBe('entries/list-v1');
        TriageListEntriesInputV1Schema.parse(input);
        readStarted();
        return heldRead;
      } },
    });
  });
  mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Engineering' })); });
  let submission: Promise<void> | undefined;
  try {
    await act(async () => {
      submission = fixture.press(await fixture.getByRole('button', { name: 'Create task' }));
      await reading;
    });
    expect(saved).toHaveLength(1);
    expect(window.snapshot.pending).not.toBe('idle');
    expect(document.querySelector('[role="form"]')).toBeNull();
    expect(document.body.textContent).toContain(source.getResult.localRef.entryId);
  } finally {
    await act(async () => {
      rejectRead(new Error('Another source could not finish its aggregate read'));
      await submission;
    });
  }
  expect(window.snapshot.error).toBeDefined();
  expect(document.querySelector('[role="form"]')).toBeNull();
  expect(document.body.textContent).toContain(source.getResult.localRef.entryId);
  expect(saved).toHaveLength(1);
});

async function mountEditor(options: Readonly<{ readOnly?: boolean; uncertain?: boolean; truncated?: boolean; readFailed?: boolean;
  fields?: readonly TriageTaskFieldV1[]; values?: TriageTaskFieldsV1; transitions?: NonNullable<TriageTaskCapabilitiesV1['transitions']>;
  nativeLabel?: string; accountData?: boolean }> = {}) {
  const sourceFixture = createTriageSourceV1Fixture();
  const source = { ...sourceFixture, configuredInstance: { ...sourceFixture.configuredInstance,
    binding: options.accountData ? { purpose: sourceFixture.descriptor.purpose, source: 'accountData' as const } : sourceFixture.configuredInstance.binding } };
  const entryRef = testkitEntryRef();
  const base = testkitObservation();
  if (base.outcome.kind !== 'present') throw new Error('Expected a present fixture');
  const observation = { ...base, outcome: { ...base.outcome, snapshot: { ...base.outcome.snapshot,
    ...(options.truncated ? { projectionTruncated: true as const } : {}),
    ...(options.nativeLabel === undefined ? {} : { state: { presentation: 'active' as const, nativeLabel: options.nativeLabel } }) } } };
  const row = foldTriageListWindow({ observations: [{ ...observation, entryRef }], lanes: [],
    configuredSourcesStatus: 'complete', activeSourceInstanceIds: [observation.sourceInstanceId],
    lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 1_000 }).rows[0]!;
  const targeted = targetedTaskSource(entryRef.source, entryRef.kindId, 'edit', options.readOnly, options.fields, options.transitions);
  const saved: ReturnType<typeof TriageEditTaskActionInputV1Schema.parse>[] = [];
  const transitioned: unknown[] = [];
  let rereads = 0;
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-edit', mountNonce: `edit-${mounted.length}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageEditTaskScope row={row} instance={source.configuredInstance} disabled={false} onApplied={async () => { rereads++; }}>
        {(task) => <>{task.controls}{task.form}</>}
      </TriageEditTaskScope>),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: targeted }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      // Host Action transport is the genuine boundary; field drafts and capability decisions stay real.
      handlers: { executeAction: ({ action, input }) => {
        if (typeof action === 'string') {
          if (action === 'tasks/transition-v1') transitioned.push(input);
          else {
            expect(action).toBe('tasks/edit-v1');
            saved.push(TriageEditTaskActionInputV1Schema.parse(input));
          }
          return options.uncertain ? { kind: 'uncertain' } : { kind: 'applied', observation: {
            ...source.getResult, kind: 'present', localRef: { kindId: entryRef.kindId, collisionScope: entryRef.collisionScope, entryId: entryRef.entryId },
            locator: row.content!.outcome.locator, snapshot: row.content!.outcome.snapshot,
            viewer: { involvement: [] },
          } };
        }
        expect(action.localId).toBe('get');
        if (options.readFailed) throw new Error('Source unavailable');
        return { kind: 'present', localRef: { kindId: entryRef.kindId, collisionScope: entryRef.collisionScope, entryId: entryRef.entryId },
          locator: row.content!.outcome.locator, snapshot: row.content!.outcome.snapshot, viewer: { involvement: [] },
          taskFields: options.values ?? { title: row.content!.outcome.snapshot.title, body: 'Full body\n\nOriginal Markdown.  \n' } };
      } },
    });
  });
  mounted.push(fixture);
  return { fixture, saved, transitioned, rereads: () => rereads };
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

it.each([true, false])('refuses an editor when the admitted source cannot supply its current fields (Machine pending: %s)', async (pending) => {
  const { fixture, saved } = await mountEditor({ readFailed: true });
  const source = createTriageSourceV1Fixture();
  const entry = testkitEntryRef();
  await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({
    targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, entry.kindId, 'edit'),
    machineConnectionPending: pending, machineExecutionReady: false,
  })); });
  const edit = await fixture.getByRole('button', { name: 'Edit task' });
  expect(edit.state?.disabled).not.toBe(true);
  await act(async () => { await fixture.press(edit); });
  expect(document.querySelector('[aria-label="Notes"]')).toBeNull();
  expect(saved).toEqual([]);
});

it('edits an Account task while no Machine is reachable', async () => {
  const { fixture, saved, rereads } = await mountEditor({ accountData: true });
  const source = createTriageSourceV1Fixture();
  const entry = testkitEntryRef();
  await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({
    targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, entry.kindId, 'edit'),
    machineConnectionPending: true, machineExecutionReady: false,
  })); });
  expect((await fixture.getByRole('button', { name: 'Edit task' })).state?.disabled).not.toBe(true);
  expect(saved).toEqual([]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit task' })); });
  const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]');
  expect(input?.value).toContain('Original Markdown.');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Account notes');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save changes' })); });
  expect(saved.map(input => input.fields)).toEqual([{ body: 'Account notes' }]);
  expect(rereads()).toBe(1);
});

it('edits the full body independently of truncated display facts and sends only the changed field', async () => {
  const { fixture, saved } = await mountEditor({ truncated: true });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit task' })); });
  const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]');
  expect(input?.value).toBe('Full body\n\nOriginal Markdown.  \n');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Updated body\n\nKeep whitespace.  \n');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(saved).toEqual([]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save changes' })); });
  expect(saved[0]?.fields).toEqual({ body: 'Updated body\n\nKeep whitespace.  \n' });
});

it('does not open an edit form with fabricated values when the full read fails', async () => {
  const { fixture, saved } = await mountEditor({ readFailed: true });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit task' })); });
  expect(document.querySelector('[role="form"]')).toBeNull();
  expect(saved).toEqual([]);
});

it('supports body-only sources and does not offer a field whose current value is unavailable', async () => {
  const { fixture, saved } = await mountEditor({ fields: ['body', 'labelIds'], values: { body: 'Current notes' } });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit task' })); });
  expect(document.querySelector('input[aria-label="Title"]')).toBeNull();
  expect(document.querySelector('textarea[aria-label="Labels"]')).toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]')?.value).toBe('Current notes');
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save changes' })); });
  expect(saved).toEqual([]);
});

it('offers every declared complete field without rewriting untouched structured values', async () => {
  const parent = testkitEntryRef();
  const values: TriageTaskFieldsV1 = { title: 'Exact title', body: 'Exact notes\n', labelIds: [' keep whitespace '], assigneeIds: [],
    scopeId: 'scope', projectId: null, priority: 'priority-1', dueDate: null, estimate: null, parent, blockedBy: [parent] };
  const fields = Object.keys(values) as TriageTaskFieldV1[];
  const { fixture, saved } = await mountEditor({ fields, values });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit task' })); });
  for (const title of ['Title', 'Notes', 'Labels', 'Assignees', 'Repository or project', 'Project', 'Priority', 'Due date', 'Estimate', 'Parent task', 'Blocked by']) {
    expect(document.querySelector(`[aria-label="${title}"]`), title).not.toBeNull();
  }
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Title"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Updated title');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save changes' })); });
  expect(saved[0]?.fields).toEqual({ title: 'Updated title' });
  expect(document.querySelector('[role="form"]')).toBeNull();
});

it('edits labels as a list of names, like assignees, not as a JSON document', async () => {
  const { fixture, saved } = await mountEditor({ fields: ['labelIds'], values: { labelIds: ['bug', 'needs review'] } });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit task' })); });
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Labels"]');
  expect(input?.value).toBe('bug, needs review');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'bug, ui');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save changes' })); });
  expect(saved[0]?.fields).toEqual({ labelIds: ['bug', 'ui'] });
});

it('offers the source transitions without a Machine and commits the chosen one through the Account aggregate', async () => {
  const transitions = [
    { id: 'close', label: 'Closed', state: { presentation: 'resolved', nativeLabel: 'Closed', completionReason: 'completed' } },
    { id: 'reopen', label: 'Open', state: { presentation: 'active', nativeLabel: 'Open' } },
  ] satisfies NonNullable<TriageTaskCapabilitiesV1['transitions']>;
  const { fixture, saved, transitioned } = await mountEditor({ transitions });
  const source = createTriageSourceV1Fixture();
  const entry = testkitEntryRef();
  await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({
    targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, entry.kindId, 'edit', false, ['title', 'body'], transitions),
    machineConnectionPending: true, machineExecutionReady: false,
  })); });
  // An operation, not a field: no unlabelled "Choose…" select waiting for a value.
  expect(document.querySelector('[aria-label="Change status"][role="combobox"]')).toBeNull();
  // The fixture task is Open: the control says so, and its name keeps the operation.
  const trigger = await fixture.getByRole('button', { name: 'Change status, Open' });
  await act(async () => { await fixture.press(trigger); });
  const closed = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes('Closed'));
  expect(closed).toBeDefined();
  await act(async () => { closed!.click(); });
  expect(transitioned).toHaveLength(1);
  expect(transitioned[0]).toMatchObject({ transitionId: 'close' });
  expect(saved).toEqual([]);
});

it('names the status control by the task\'s current status in the source\'s own word', async () => {
  const { fixture } = await mountEditor({ nativeLabel: 'In Review', transitions: [
    { id: 'done', label: 'Done', state: { presentation: 'resolved', nativeLabel: 'Done', completionReason: 'completed' } },
  ] });
  const trigger = await fixture.getByRole('button', { name: 'Change status, In Review' });
  expect(trigger).toBeDefined();
  await expect(fixture.getByText('In Review')).resolves.toBeDefined();
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
    await expect(commit('tasks/edit-v1', {})).resolves.toMatchObject({ kind: 'uncertain' });
    // A second activation can still hold the preceding render's callback.
    await commit('tasks/edit-v1', {});
  });
  expect(write!.result).toEqual({ kind: 'uncertain' });
  expect(write!.busy).toBe(false);
  await act(async () => { await write!.commit('tasks/edit-v1', {}); });
  expect(calls).toBe(1);
});

async function mountRowStatus(task: React.ComponentProps<typeof TriageTaskRowStatusControl>['task'], transitions: NonNullable<TriageTaskCapabilitiesV1['transitions']>) {
  const entryRef = testkitEntryRef();
  const observation = testkitObservation();
  const row = foldTriageListWindow({ observations: [{ ...observation, entryRef }], lanes: [],
    configuredSourcesStatus: 'complete', activeSourceInstanceIds: [observation.sourceInstanceId],
    lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 1_000 }).rows[0]!;
  const selected = readTriageSelectedObservationV1(row)!;
  const transitioned: unknown[] = [];
  let rereads = 0;
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-row', mountNonce: `row-${mounted.length}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageTaskRowStatusControl task={task} onApplied={async () => { rereads++; }}
        address={{ entryRef, sourceInstanceId: selected.sourceInstanceId, lastKnownLocator: selected.observation.locator }} />),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: targetedTaskSource(entryRef.source, entryRef.kindId, 'edit', false, ['title'], transitions) }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      // Host Action transport is the genuine boundary.
      handlers: { executeAction: ({ input }) => { transitioned.push(input); return { kind: 'refused', reason: 'unavailable' }; } },
    });
  });
  mounted.push(fixture);
  return { fixture, transitioned, entryRef, rereads: () => rereads };
}

const ROW_TRANSITIONS = [
  { id: 'start', label: 'In Progress', state: { presentation: 'active', stage: 'started', nativeLabel: 'In Progress' } },
  { id: 'done', label: 'Done', state: { presentation: 'resolved', nativeLabel: 'Done', completionReason: 'completed' } },
] as const satisfies NonNullable<TriageTaskCapabilitiesV1['transitions']>;

it('completes a task from its row glyph in one write when the source declares the completing transition', async () => {
  const { fixture, transitioned, entryRef } = await mountRowStatus({ category: 'unstarted', statusLabel: 'Todo', relations: null,
    completingTransitionId: 'done', transitions: [{ id: 'start', label: 'In Progress', category: 'started' }, { id: 'done', label: 'Done', category: 'completed' }] }, ROW_TRANSITIONS);
  const glyph = await fixture.getByRole('button', { name: 'Mark as done, Todo' });
  await act(async () => { await fixture.press(glyph); });
  // One press, one write of the declared completing transition; no menu in between.
  expect(document.querySelector('[role="menuitem"]')).toBeNull();
  expect(transitioned).toHaveLength(1);
  expect(transitioned[0]).toMatchObject({ entryRef, transitionId: 'done' });
});

it('opens the source workflow from the row glyph when no single completing transition exists', async () => {
  const { fixture, transitioned } = await mountRowStatus({ category: 'started', statusLabel: 'In Review', relations: null,
    transitions: [{ id: 'start', label: 'In Progress', category: 'started' }, { id: 'done', label: 'Done', category: 'completed' }] }, ROW_TRANSITIONS);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Change status, In Review' })); });
  expect(transitioned).toEqual([]);
  const done = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes('Done'));
  await act(async () => { done!.click(); });
  expect(transitioned).toHaveLength(1);
  expect(transitioned[0]).toMatchObject({ transitionId: 'done' });
});
