import * as React from 'react';
import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from '../../accountExecution.js';
import { isPluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import {
  Banner, BrandMark, Button, EmptyState, ErrorState, Form, IconButton, Item, ItemGroup, LoadingState, Menu, Row, Stack, TaskStatusGlyph, Text,
  usePluginHostApi, usePluginHostReadiness, usePluginTranslation, useSurfaceContext,
  type ActionFormFieldHint,
} from '@happier-dev/plugin-ui';
import { TriageGetResultV1Schema, TriageTaskFieldsV1Schema, TriageTaskWriteResultV1Schema, triageTaskStatusCategoryV1,
  type TriageConfiguredSourceInstanceV1, type TriageEntryLocatorV1, type TriageEntryRefV1, type TriageSourceInstanceIdV1, type TriageTaskFieldV1,
  type TriageTaskWriteResultV1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1,
  TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 } from '../../actions/tasksProtocol.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriageListTaskFactsV1 } from '../list/sections.js';
import type { TriageMountedConfiguredSourceV1 } from '../configuration/useTriageConfiguredSources.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { readTriageSourceGetOperationV1, resolveTriageSourceDescriptorV1, resolveTriageSourceTaskOperationV1 } from './sourceSurface.js';

/** List age and other sources' health do not decide whether this source can execute. */
function useTriageTaskExecutionUnavailable(): boolean {
  const machineBound = Object.is(TRIAGE_DATA_ACTION_EXECUTION_V1.target, 'daemon');
  const readiness = usePluginHostReadiness(machineBound);
  return readiness.pending || readiness.ready === false;
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
    // The source settled the write. The shared window's aggregate-idle barrier
    // can still await other sources, so it must not hold this commit open.
    if (next.kind === 'applied' || next.kind === 'uncertain') {
      void Promise.resolve().then(onApplied).catch(() => {
        host.diagnostic({ code: 'triage_task_reread_unavailable', severity: 'warning',
          message: 'The task write settled, but its authoritative reread was unavailable.' });
      });
    }
    pending.current = false;
    setBusy(false);
    return next;
  };
  return { result, busy, commit };
}

function taskWriteMessage(text: ReturnType<typeof usePluginTranslation>, result: TriageTaskWriteResultV1): string {
  return text(`plugins.triage.tasks.write.${result.kind}`, result.kind === 'applied' ? 'Saved at the source'
    : result.kind === 'uncertain' ? 'The source may have saved this. Check it before creating or saving again.'
      : result.kind === 'refused' ? 'This change is not available for this task.' : 'The source could not save this change.');
}

function TaskWriteNotice({ result }: Readonly<{ result: TriageTaskWriteResultV1 | null }>) {
  const text = usePluginTranslation();
  if (result === null) return null;
  return <Banner tone={result.kind === 'applied' ? 'info' : 'warning'} title={taskWriteMessage(text, result)} />;
}

const TASK_CATEGORY_WORDS = { backlog: 'Backlog', unstarted: 'To do', started: 'In progress', completed: 'Done', canceled: 'Canceled' } as const;

/**
 * A task row's status glyph as its control (lab `tasks-list`, decision 3): when the selected connection declares the
 * one transition that completes the task, a press completes it in one write; otherwise the glyph opens the source's
 * own workflow in place. The write is the detail's (`tasks/transition-v1`, one commit, no replay of an uncertain
 * answer); while it runs the glyph is the spinner, and an outcome other than applied is said by the host notice.
 */
export function TriageTaskRowStatusControl(props: Readonly<{
  /** The selected connection's address the list row carries (its entry, connection and locator). */
  address: Readonly<{ entryRef: TriageEntryRefV1; sourceInstanceId: TriageSourceInstanceIdV1; lastKnownLocator: TriageEntryLocatorV1 }>;
  task: TriageListTaskFactsV1;
  onApplied(): Promise<void>;
}>): React.ReactElement | null {
  const context = useSurfaceContext();
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const unavailable = useTriageTaskExecutionUnavailable();
  const write = useTriageTaskCommit(props.onApplied);
  const [open, setOpen] = React.useState(false);
  const { task, address } = props;
  const declared = resolveTriageSourceTaskOperationV1(context.targetedContributions, address.entryRef.source, 'transition') !== undefined;
  const transitions = task.transitions ?? [];
  if (task.category === null || !declared || transitions.length === 0) {
    return task.category === null ? null : <TaskStatusGlyph category={task.category} />;
  }
  const category = task.category;
  const disabled = unavailable || write.busy || write.result?.kind === 'uncertain';
  const commit = async (transitionId: string) => {
    if (disabled) return;
    const result = await write.commit(TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, { v: 1, entryRef: address.entryRef,
      sourceInstanceId: address.sourceInstanceId, lastKnownLocator: address.lastKnownLocator, transitionId });
    if (result !== undefined && result.kind !== 'applied') {
      void host.notify(taskWriteMessage(text, result), { severity: 'warning' }).catch(() => undefined);
    }
  };
  const statusWord = task.statusLabel ?? text(`plugins.triage.tasks.${category}`, TASK_CATEGORY_WORDS[category]);
  const completing = category === 'completed' || category === 'canceled' ? undefined : task.completingTransitionId;
  if (completing !== undefined) {
    return <IconButton icon={<TaskStatusGlyph category={category} />} busy={write.busy} disabled={disabled}
      accessibilityLabel={`${text('plugins.triage.tasks.complete', 'Mark as done')}, ${statusWord}`}
      onPress={() => commit(completing)} />;
  }
  const transitionLabel = text('plugins.triage.tasks.transition', 'Change status');
  return <Menu open={open && !disabled} onOpenChange={(next) => setOpen(next && !disabled)} disabled={disabled}
    trigger={statusWord} triggerTaskStatus={category} triggerAccessibilityLabel={`${transitionLabel}, ${statusWord}`}
    items={transitions.map((transition) => ({ id: transition.id, label: transition.label }))}
    onSelect={(id) => { if (transitions.some((transition) => transition.id === id)) void commit(id); }} />;
}

export function TriageCreateTaskFields(props: Readonly<{
  sources: readonly TriageMountedConfiguredSourceV1[];
  sourcesLoaded: boolean;
  sourcesUnavailableReason: string | null;
  draft?: Readonly<{ title?: string; body?: string }>;
  onApplied(): Promise<void>;
  onClose(): void;
  /** The source created the task: the draft becomes that task's detail in place. */
  onCreated?(created: Readonly<{ entryRef: TriageEntryRefV1; sourceInstanceId: TriageSourceInstanceIdV1 }>): void;
}>): React.ReactElement {
  const context = useSurfaceContext();
  const text = usePluginTranslation();
  const machineUnavailable = useTriageTaskExecutionUnavailable();
  const [where, setWhere] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Record<string, unknown>>({ title: '', ...props.draft });
  const write = useTriageTaskCommit(props.onApplied);
  const choices = props.sources.flatMap((source) => {
    const descriptor = resolveTriageSourceDescriptorV1(context.targetedContributions, source.configured.instance.source);
    const operation = resolveTriageSourceTaskOperationV1(context.targetedContributions, source.configured.instance.source, 'create');
    return (descriptor?.kinds ?? []).filter((kind) => kind.task === true).map((kind) => {
      const supportsCreate = operation !== undefined && kind.taskCapabilities?.createFields?.includes('title') === true;
      return { value: JSON.stringify([source.sourceInstanceId, kind.id]), source, kind, supportsCreate,
        family: descriptor?.displayName ?? source.displayLabel, disabled: !supportsCreate || machineUnavailable };
    });
  });
  const chosen = choices.find((choice) => choice.value === where);
  const sourcesReady = props.sourcesLoaded && props.sourcesUnavailableReason === null;
  const canChoose = sourcesReady && choices.some((choice) => choice.supportsCreate);
  const fields = chosen?.kind.taskCapabilities?.createFields ?? [];
  const unsupportedBody = typeof draft.body === 'string' && draft.body.length > 0 && !fields.includes('body');
  const placeNote = (choice: (typeof choices)[number]) => choice.supportsCreate ? choice.kind.displayName ?? choice.kind.id
    : text('plugins.triage.tasks.where.cannotCreate', 'Tasks can\u2019t be created here');
  const mark = (choice: (typeof choices)[number]) =>
    <BrandMark pluginId={choice.source.configured.instance.source.pluginId} size="small" externallyLabelled />;
  // The draft stands in the detail's place under the pane's own "New task" title (lab `tasks-create`, decision 10):
  // first the places this task can go, one row each under its source's name; a place that cannot take tasks says so.
  // Choosing one opens its form under a single place row that leads back to the list (lab `tasks-form`), with one Create.
  if (chosen === undefined || !canChoose) {
    const families = [...new Set(choices.map((choice) => choice.family))];
    return <Stack gap="medium">
      <Text variant="body" tone="secondary" value={text('plugins.triage.tasks.where.purpose', 'Where does it belong? It\u2019s created there and stays there.')} />
      {props.sourcesUnavailableReason !== null ? <ErrorState kind="unavailable" layout="line"
        title={text('plugins.triage.tasks.sourcesUnavailable', 'Task sources are unavailable')}
        description={props.sourcesUnavailableReason} />
        : !props.sourcesLoaded ? <LoadingState layout="line" title={text('plugins.triage.surface.sources.loading', 'Reading your sources\u2026')} />
        : !canChoose ? <EmptyState layout="line" title={text('plugins.triage.tasks.noCreateSource', 'Add a source that supports creating tasks in Sources.')} />
        : families.map((family) => <ItemGroup key={family} title={family} surface="none">
          {choices.filter((choice) => choice.family === family).map((choice) => <Item key={choice.value}
            icon={mark(choice)} title={choice.source.displayLabel} accessibilityRole="button" disabled={choice.disabled}
            accessibilityLabel={choice.source.displayLabel} accessibilityHint={placeNote(choice)} subtitle={placeNote(choice)}
            onPress={() => { if (!choice.disabled) setWhere(choice.value); }} />)}
        </ItemGroup>)}
    </Stack>;
  }
  return <Stack gap="medium">
    <Item icon={mark(chosen)} title={chosen.source.displayLabel} subtitle={placeNote(chosen)} accessibilityLabel={chosen.source.displayLabel}
      accessoryOutsidePressable accessory={<Button title={text('plugins.triage.tasks.where.change', 'Change')} variant="plain" size="small"
        disabled={write.busy || write.result?.kind === 'uncertain' || write.result?.kind === 'applied'} onPress={() => setWhere(null)} />} />
    <Form value={draft} onChange={setDraft} disabled={chosen.disabled || unsupportedBody || write.result?.kind === 'uncertain' || write.result?.kind === 'applied'} busy={write.busy}
      onCancel={props.onClose}
      hints={{ submitLabel: text('plugins.triage.tasks.create', 'Create task'), fields: [
        { path: 'title', title: text('plugins.triage.tasks.taskTitle', 'Title'), widget: 'text', required: true },
        ...(fields.includes('body') ? [{ path: 'body', title: text('plugins.triage.tasks.body', 'Notes'), widget: 'textarea' as const }] : []),
        ...(fields.includes('scopeId') ? [{ path: 'scopeId', title: text('plugins.triage.tasks.scope', 'Repository or project'), widget: 'text' as const }] : []),
      ] }}
      onSubmit={async (value) => {
        const title = typeof value.title === 'string' ? value.title.trim() : '';
        if (title.length === 0 || chosen.disabled || !sourcesReady || unsupportedBody) return;
        const result = await write.commit(TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1, { v: 1,
          source: chosen.source.configured.instance.source, sourceInstanceId: chosen.source.sourceInstanceId,
          kindId: chosen.kind.id, fields: { title,
            ...(fields.includes('body') && typeof value.body === 'string' ? { body: value.body } : {}),
            ...(fields.includes('scopeId') && typeof value.scopeId === 'string' && value.scopeId.length > 0 ? { scopeId: value.scopeId } : {}),
          } });
        if (result?.kind === 'applied') props.onCreated?.({
          entryRef: { source: chosen.source.configured.instance.source, ...result.observation.localRef },
          sourceInstanceId: chosen.source.configured.instance.sourceInstanceId,
        });
      }} />
    <TaskWriteNotice result={write.result} />
    {!unsupportedBody ? null : <TaskWriteNotice result={{ kind: 'refused', reason: 'unsupportedField' }} />}
  </Stack>;
}

const TASK_EDIT_HINTS = {
  title: { title: 'Title', widget: 'text', required: true },
  body: { title: 'Notes', widget: 'textarea' },
  assigneeIds: { title: 'Assignees', widget: 'text_list' },
  // Labels are a list of names like assignees, never a JSON document.
  labelIds: { title: 'Labels', widget: 'text_list' },
  scopeId: { title: 'Repository or project', widget: 'text' },
  projectId: { title: 'Project', widget: 'json' },
  priority: { title: 'Priority', widget: 'json' },
  dueDate: { title: 'Due date', widget: 'json' },
  estimate: { title: 'Estimate', widget: 'json' },
  parent: { title: 'Parent task', widget: 'json' },
  blockedBy: { title: 'Blocked by', widget: 'json' },
} as const satisfies Record<TriageTaskFieldV1, Omit<ActionFormFieldHint, 'path'>>;

/** Where the detail places a task's controls and, while it is being edited, its form. */
export type TriageEditTaskPlacementV1 = Readonly<{
  /** The task's operations (Edit task, Change status) and their last outcome, under the entry's actions. */
  controls: React.ReactElement | null;
  /** The open editor. The detail shows it in place of the entry's story until it is saved or cancelled. */
  form: React.ReactElement | null;
}>;

/**
 * Exact editable values belong to the source read, never to the bounded display projection.
 *
 * One owner holds the editor's state; the detail decides where its two parts sit. Key it per entry instance so a
 * different entry never inherits another one's draft.
 */
export function TriageEditTaskScope(props: Readonly<{
  row: TriageListRowV1; instance?: TriageConfiguredSourceInstanceV1; disabled: boolean; onApplied(): Promise<void>;
  children(placement: TriageEditTaskPlacementV1): React.ReactElement;
}>): React.ReactElement {
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
  const [statusOpen, setStatusOpen] = React.useState(false);
  const read = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => read.current?.abort(), []);
  const write = useTriageTaskCommit(props.onApplied);
  if (kind?.task !== true || selected === null || snapshot === undefined) return props.children({ controls: null, form: null });
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
  // The status control says the task's current status in the source's own word ("In Review"); its menu is that
  // source's workflow. Its name keeps the operation for assistive technology.
  const currentStatus = snapshot.state.nativeLabel ?? null;
  const currentCategory = triageTaskStatusCategoryV1(snapshot.state);
  const transitionLabel = text('plugins.triage.tasks.transition', 'Change status');
  const transitionTrigger = currentStatus ?? transitionLabel;
  const transitionAccessibilityLabel = currentStatus === null ? transitionLabel : `${transitionLabel}, ${currentStatus}`;
  const valuesNotice = readFailed ? <Banner tone="warning" title={text('plugins.triage.tasks.editValuesUnavailable',
    'Some current task values could not be loaded. Only fully loaded fields can be edited.')} /> : null;
  // The task's operations sit together as one quiet row under the entry's actions: Edit task opens the editor,
  // Change status is a menu of the source's own transitions (an operation, not a field to fill). A source without
  // a role never gets that control: a greyed control that cannot succeed is not drawn.
  const operations = !canEdit && transitions.length === 0 ? null : <Row gap="small" wrap>
    {canEdit ? <Button title={text('plugins.triage.tasks.edit', 'Edit task')} variant="secondary" size="small" disabled={disabled}
      busy={reading} onPress={openEditor} /> : null}
    {transitions.length === 0 ? null : <Menu open={statusOpen && !disabled} onOpenChange={(open) => setStatusOpen(open && !disabled)}
      trigger={transitionTrigger} triggerAccessibilityLabel={transitionAccessibilityLabel} triggerAppearance="control" disabled={disabled}
      {...(currentCategory === null ? {} : { triggerTaskStatus: currentCategory })}
      items={transitions.map((transition) => ({ id: transition.id, label: transition.label }))}
      onSelect={(value) => { if (!disabled && transitions.some((transition) => transition.id === value))
        void write.commit(TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, { ...address, transitionId: value }); }} />}
  </Row>;
  const controls = editing || (operations === null && !readFailed && write.result === null) ? null : <Stack gap="small">
    {operations}
    {valuesNotice}
    <TaskWriteNotice result={write.result} />
  </Stack>;
  const form = !editing ? null : <ItemGroup title={text('plugins.triage.tasks.edit', 'Edit task')}>
    {valuesNotice}
    <Form
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
      }} />
    <TaskWriteNotice result={write.result} />
  </ItemGroup>;
  return props.children({ controls, form });
}
