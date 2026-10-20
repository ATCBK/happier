import * as React from 'react';
import { isPluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import {
  Banner, Button, EmptyState, ErrorState, Form, Item, ItemGroup, LoadingState, Select, Stack,
  usePluginHostApi, usePluginHostReadiness, usePluginTranslation, useSurfaceContext,
  type ActionFormFieldHint,
} from '@happier-dev/plugin-ui';
import { TriageGetResultV1Schema, TriageTaskFieldsV1Schema, TriageTaskWriteResultV1Schema,
  type TriageConfiguredSourceInstanceV1, type TriageTaskFieldV1, type TriageTaskWriteResultV1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1,
  TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 } from '../../actions/tasksProtocol.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriageMountedConfiguredSourceV1 } from '../configuration/useTriageConfiguredSources.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { readTriageSourceGetOperationV1, resolveTriageSourceDescriptorV1, resolveTriageSourceTaskOperationV1 } from './sourceSurface.js';

/** List age and other sources' health do not decide whether this source can execute. */
function useTriageTaskExecutionUnavailable(): boolean {
  const readiness = usePluginHostReadiness();
  const context = useSurfaceContext();
  return readiness.pending || context.machineExecutionReady === false;
}

/** A single explicit form commit; provider authorization and settlement stay in tasks/* and the source. */
export function useTriageTaskCommit(onApplied: () => Promise<void>) {
  const host = usePluginHostApi();
  const [result, setResult] = React.useState<TriageTaskWriteResultV1 | null>(null);
  const [busy, setBusy] = React.useState(false);
  const pending = React.useRef(false);
  const uncertain = React.useRef(false);
  const active = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => active.current?.abort(), []);
  const commit = async (action: typeof TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1 | typeof TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1 | typeof TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, input: JsonValue) => {
    if (pending.current || uncertain.current) return;
    pending.current = true;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    let next: TriageTaskWriteResultV1;
    try { next = TriageTaskWriteResultV1Schema.parse(await host.executeAction(action, input, { signal: controller.signal })); }
    catch (error) {
      next = isPluginError(error) && (error.code === 'denied' || error.code === 'cancelled')
        ? { kind: 'refused', reason: error.code } : { kind: 'uncertain' };
    }
    if (controller.signal.aborted) { pending.current = false; return; }
    // An activation can retain the preceding render's callback. Refuse replay synchronously,
    // before that render has committed the disabled state.
    uncertain.current = next.kind === 'uncertain';
    setResult(next);
    // A failed reread must never turn a confirmed write into a retryable write failure.
    try { if (next.kind === 'applied' || next.kind === 'uncertain') await onApplied(); }
    catch {
      host.diagnostic({ code: 'triage_task_reread_unavailable', severity: 'warning',
        message: 'The task write settled, but its authoritative reread was unavailable.' });
    }
    finally { pending.current = false; setBusy(false); }
    return next;
  };
  return { result, busy, commit };
}

function TaskWriteNotice({ result }: Readonly<{ result: TriageTaskWriteResultV1 | null }>) {
  const text = usePluginTranslation();
  if (result === null) return null;
  return <Banner tone={result.kind === 'applied' ? 'info' : 'warning'}
    title={text(`plugins.triage.tasks.write.${result.kind}`, result.kind === 'applied' ? 'Saved at the source'
      : result.kind === 'uncertain' ? 'The source may have saved this. Check it before creating or saving again.'
        : result.kind === 'refused' ? 'This change is not available for this task.' : 'The source could not save this change.')} />;
}

export function TriageCreateTaskFields(props: Readonly<{
  sources: readonly TriageMountedConfiguredSourceV1[];
  sourcesLoaded: boolean;
  sourcesUnavailableReason: string | null;
  draft?: Readonly<{ title?: string; body?: string }>;
  onApplied(): Promise<void>;
  onClose(): void;
}>): React.ReactElement {
  const context = useSurfaceContext();
  const text = usePluginTranslation();
  const disabled = useTriageTaskExecutionUnavailable();
  const [where, setWhere] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Record<string, unknown>>({ title: '', ...props.draft });
  const write = useTriageTaskCommit(props.onApplied);
  const choices = props.sources.flatMap((source) => {
    const descriptor = resolveTriageSourceDescriptorV1(context.targetedContributions, source.configured.instance.source);
    const operation = resolveTriageSourceTaskOperationV1(context.targetedContributions, source.configured.instance.source, 'create');
    return (descriptor?.kinds ?? []).filter((kind) => kind.task === true).map((kind) => ({
      value: JSON.stringify([source.sourceInstanceId, kind.id]), source, kind,
      label: `${source.displayLabel} · ${kind.displayName ?? kind.id}`,
      disabled: operation === undefined || !kind.taskCapabilities?.createFields?.includes('title'),
      ...(operation === undefined || !kind.taskCapabilities?.createFields?.includes('title')
        ? { unavailableReason: text('plugins.triage.tasks.write.refused', 'This change is not available for this task.') } : {}),
    }));
  });
  const chosen = choices.find((choice) => choice.value === where);
  const sourcesReady = props.sourcesLoaded && props.sourcesUnavailableReason === null;
  const canChoose = sourcesReady && choices.some((choice) => !choice.disabled);
  const fields = chosen?.kind.taskCapabilities?.createFields ?? [];
  const unsupportedBody = typeof draft.body === 'string' && draft.body.length > 0 && !fields.includes('body');
  return <ItemGroup title={text('plugins.triage.tasks.create', 'Create task')}>
    <Item title={text('plugins.triage.tasks.where', 'Where?')} accessoryWraps accessory={
      <Select label={text('plugins.triage.tasks.where', 'Where?')} presentation="field" value={where}
        disabled={disabled || !canChoose} options={choices}
        onChange={(value) => { if (canChoose && !disabled && typeof value === 'string') setWhere(value); }} />
    } />
    {props.sourcesUnavailableReason !== null ? <ErrorState kind="unavailable" layout="line"
      title={text('plugins.triage.tasks.sourcesUnavailable', 'Task sources are unavailable')}
      description={props.sourcesUnavailableReason} />
      : !props.sourcesLoaded ? <LoadingState layout="line" title={text('plugins.triage.surface.sources.loading', 'Reading your sources…')} />
      : !canChoose ? <EmptyState layout="line" title={text('plugins.triage.tasks.noCreateSource', 'Add a source that supports creating tasks in Sources.')} />
      : chosen === undefined ? <Banner tone="info" title={text('plugins.triage.tasks.chooseSource', 'Choose where this task belongs.')} />
      : <Form value={draft} onChange={setDraft} disabled={disabled || chosen.disabled || unsupportedBody || write.result?.kind === 'uncertain' || write.result?.kind === 'applied'} busy={write.busy}
        onCancel={props.onClose}
        hints={{ submitLabel: text('plugins.triage.tasks.create', 'Create task'), fields: [
          { path: 'title', title: text('plugins.triage.tasks.taskTitle', 'Title'), widget: 'text', required: true },
          ...(fields.includes('body') ? [{ path: 'body', title: text('plugins.triage.tasks.body', 'Notes'), widget: 'textarea' as const }] : []),
          ...(fields.includes('scopeId') ? [{ path: 'scopeId', title: text('plugins.triage.tasks.scope', 'Repository or project'), widget: 'text' as const }] : []),
        ] }}
        onSubmit={async (value) => {
          const title = typeof value.title === 'string' ? value.title.trim() : '';
          if (title.length === 0 || chosen.disabled || !sourcesReady || disabled || unsupportedBody) return;
          await write.commit(TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1, { v: 1,
            source: chosen.source.configured.instance.source, sourceInstanceId: chosen.source.sourceInstanceId,
            kindId: chosen.kind.id, fields: { title,
              ...(fields.includes('body') && typeof value.body === 'string' ? { body: value.body } : {}),
              ...(fields.includes('scopeId') && typeof value.scopeId === 'string' && value.scopeId.length > 0 ? { scopeId: value.scopeId } : {}),
            } });
        }} />}
    <TaskWriteNotice result={write.result} />
    {chosen === undefined || !unsupportedBody ? null : <TaskWriteNotice result={{ kind: 'refused', reason: 'unsupportedField' }} />}
    {chosen !== undefined && canChoose ? null : <Button title={text('plugins.triage.surface.close', 'Close')} variant="plain" onPress={props.onClose} />}
  </ItemGroup>;
}

const TASK_EDIT_HINTS = {
  title: { title: 'Title', widget: 'text', required: true },
  body: { title: 'Notes', widget: 'textarea' },
  assigneeIds: { title: 'Assignees', widget: 'text_list' },
  labelIds: { title: 'Labels', widget: 'json' },
  scopeId: { title: 'Repository or project', widget: 'text' },
  projectId: { title: 'Project', widget: 'json' },
  priority: { title: 'Priority', widget: 'json' },
  dueDate: { title: 'Due date', widget: 'json' },
  estimate: { title: 'Estimate', widget: 'json' },
  parent: { title: 'Parent task', widget: 'json' },
  blockedBy: { title: 'Blocked by', widget: 'json' },
} as const satisfies Record<TriageTaskFieldV1, Omit<ActionFormFieldHint, 'path'>>;

/** Exact editable values belong to the source read, never to the bounded display projection. */
export function TriageEditTaskFields(props: Readonly<{
  row: TriageListRowV1; instance?: TriageConfiguredSourceInstanceV1; disabled: boolean; onApplied(): Promise<void>;
}>): React.ReactElement | null {
  const context = useSurfaceContext();
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const executionUnavailable = useTriageTaskExecutionUnavailable();
  const selected = readTriageSelectedObservationV1(props.row);
  const kind = resolveTriageSourceDescriptorV1(context.targetedContributions, props.row.entryRef.source)
    ?.kinds.find((kind) => kind.id === props.row.entryRef.kindId);
  const snapshot = selected?.observation.snapshot;
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, unknown>>({});
  const [opening, setOpening] = React.useState<Record<string, unknown>>({});
  const [editable, setEditable] = React.useState<readonly TriageTaskFieldV1[]>([]);
  const [issues, setIssues] = React.useState<Record<string, string>>({});
  const [readFailed, setReadFailed] = React.useState(false);
  const [reading, setReading] = React.useState(false);
  const read = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => read.current?.abort(), []);
  const write = useTriageTaskCommit(props.onApplied);
  if (kind?.task !== true || selected === null || snapshot === undefined) return null;
  const capabilities = snapshot.taskCapabilities ?? kind.taskCapabilities;
  const get = readTriageSourceGetOperationV1(context, props.row.entryRef.source);
  const canEdit = (capabilities?.editFields?.length ?? 0) > 0 && get !== undefined
    && resolveTriageSourceTaskOperationV1(context.targetedContributions, props.row.entryRef.source, 'edit') !== undefined;
  const transitions = resolveTriageSourceTaskOperationV1(context.targetedContributions, props.row.entryRef.source, 'transition') === undefined
    ? [] : capabilities?.transitions ?? [];
  const address = { v: 1, entryRef: props.row.entryRef, sourceInstanceId: selected.sourceInstanceId, lastKnownLocator: selected.observation.locator };
  const disabled = props.disabled || executionUnavailable || props.instance === undefined || reading || write.busy || write.result?.kind === 'uncertain';
  const openEditor = async () => {
    if (disabled || !canEdit || !get || !props.instance || read.current) return;
    const controller = new AbortController();
    read.current = controller;
    setReading(true);
    setReadFailed(false);
    const entry = props.row.entryRef;
    const localRef = { kindId: entry.kindId, collisionScope: entry.collisionScope, entryId: entry.entryId };
    try {
      const result = TriageGetResultV1Schema.parse(await host.executeAction(get.action, {
        v: 1, instance: props.instance, localRef, lastKnownLocator: selected.observation.locator,
      }, { signal: controller.signal }));
      if (controller.signal.aborted) return;
      if (result.kind !== 'present' || !pluginJsonValuesEqual(result.localRef, localRef) || result.taskFields === undefined) {
        setReadFailed(true);
        return;
      }
      const fields = result.snapshot.taskCapabilities?.editFields ?? capabilities?.editFields ?? [];
      const taskFields = result.taskFields;
      // A missing value means unavailable, never empty. Sources publish only complete
      // values here; unrelated snapshot/relationship truncation has no edit authority.
      const complete = fields.filter(field => Object.hasOwn(taskFields, field));
      const values = Object.fromEntries(complete.map(field => [field, taskFields[field]]));
      setEditable(complete);
      setIssues({});
      setOpening(values);
      setDraft(values);
      setReadFailed(complete.length !== fields.length || complete.length === 0);
      setEditing(complete.length > 0);
    } catch { if (!controller.signal.aborted) setReadFailed(true); }
    finally { read.current = null; if (!controller.signal.aborted) setReading(false); }
  };
  return <Stack gap="small">
    {/* A source without the edit role never gets a greyed "Edit task": a control that cannot succeed is not drawn. */}
    {!canEdit && !editing ? null : !editing ? <Button title={text('plugins.triage.tasks.edit', 'Edit task')} variant="plain" disabled={disabled}
      busy={reading} onPress={openEditor} /> : <Form
      value={draft} onChange={value => { setDraft(value); setIssues({}); }} issues={issues}
      disabled={disabled || !canEdit} busy={write.busy}
      hints={{ submitLabel: text('plugins.triage.tasks.save', 'Save changes'), fields: editable.map(field => ({
        ...TASK_EDIT_HINTS[field], path: field, title: text(`plugins.triage.tasks.fields.${field}`, TASK_EDIT_HINTS[field].title),
      })) }} onCancel={() => setEditing(false)} onSubmit={async (value) => {
        if (!canEdit || disabled) return;
        const changed = Object.fromEntries(editable.filter(field => !pluginJsonValuesEqual(value[field], opening[field]))
          .map(field => [field, value[field]]));
        const fields = TriageTaskFieldsV1Schema.safeParse(changed);
        if (!fields.success) {
          setIssues(Object.fromEntries(fields.error.issues.map(issue => [String(issue.path[0]),
            text('plugins.triage.tasks.invalidField', 'Check this value before saving.')])));
          return;
        }
        if (Object.keys(fields.data).length === 0) return;
        const result = await write.commit(TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1, { ...address, fields: fields.data });
        if (result?.kind === 'applied') setEditing(false);
      }} />}
    {readFailed ? <Banner tone="warning" title={text('plugins.triage.tasks.editValuesUnavailable',
      'Some current task values could not be loaded. Only fully loaded fields can be edited.')} /> : null}
    {transitions.length === 0 ? null : <Select label={text('plugins.triage.tasks.transition', 'Change status')} presentation="field"
      disabled={disabled} value={null} options={transitions.map((transition) => ({ value: transition.id, label: transition.label }))}
      onChange={(value) => { if (!disabled && typeof value === 'string' && transitions.some((transition) => transition.id === value))
        void write.commit(TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, { ...address, transitionId: value }); }} />}
    <TaskWriteNotice result={write.result} />
  </Stack>;
}
