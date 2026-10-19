import * as React from 'react';
import { isPluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import {
  Banner, Button, EmptyState, ErrorState, Form, Item, ItemGroup, LoadingState, Select, Stack,
  usePluginHostApi, usePluginTranslation, useSurfaceContext,
} from '@happier-dev/plugin-ui';
import { TriageTaskWriteResultV1Schema, type TriageTaskWriteResultV1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1,
  TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 } from '../../actions/tasksProtocol.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriageMountedConfiguredSourceV1 } from '../configuration/useTriageConfiguredSources.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { resolveTriageSourceDescriptorV1, resolveTriageSourceTaskOperationV1 } from './sourceSurface.js';

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
  disabled: boolean;
  onApplied(): Promise<void>;
  onClose(): void;
}>): React.ReactElement {
  const context = useSurfaceContext();
  const text = usePluginTranslation();
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
        disabled={props.disabled || !canChoose} options={choices}
        onChange={(value) => { if (canChoose && !props.disabled && typeof value === 'string') setWhere(value); }} />
    } />
    {props.sourcesUnavailableReason !== null ? <ErrorState kind="unavailable" layout="line"
      title={text('plugins.triage.tasks.sourcesUnavailable', 'Task sources are unavailable')}
      description={props.sourcesUnavailableReason} />
      : !props.sourcesLoaded ? <LoadingState layout="line" title={text('plugins.triage.surface.sources.loading', 'Reading your sources…')} />
      : !canChoose ? <EmptyState layout="line" title={text('plugins.triage.tasks.noCreateSource', 'Add a source that supports creating tasks in Sources.')} />
      : chosen === undefined ? <Banner tone="info" title={text('plugins.triage.tasks.chooseSource', 'Choose where this task belongs.')} />
      : <Form value={draft} onChange={setDraft} disabled={props.disabled || chosen.disabled || unsupportedBody || write.result?.kind === 'uncertain' || write.result?.kind === 'applied'} busy={write.busy}
        onCancel={props.onClose}
        hints={{ submitLabel: text('plugins.triage.tasks.create', 'Create task'), fields: [
          { path: 'title', title: text('plugins.triage.tasks.taskTitle', 'Title'), widget: 'text', required: true },
          ...(fields.includes('body') ? [{ path: 'body', title: text('plugins.triage.tasks.body', 'Notes'), widget: 'textarea' as const }] : []),
          ...(fields.includes('scopeId') ? [{ path: 'scopeId', title: text('plugins.triage.tasks.scope', 'Repository or project'), widget: 'text' as const }] : []),
        ] }}
        onSubmit={async (value) => {
          const title = typeof value.title === 'string' ? value.title.trim() : '';
          if (title.length === 0 || chosen.disabled || !sourcesReady || props.disabled || unsupportedBody) return;
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

/** Lives inside the existing detail frame. Full provider-native body/comments remain source-owned. */
export function TriageEditTaskFields(props: Readonly<{
  row: TriageListRowV1; disabled: boolean; onApplied(): Promise<void>;
}>): React.ReactElement | null {
  const context = useSurfaceContext();
  const text = usePluginTranslation();
  const selected = readTriageSelectedObservationV1(props.row);
  const kind = resolveTriageSourceDescriptorV1(context.targetedContributions, props.row.entryRef.source)
    ?.kinds.find((kind) => kind.id === props.row.entryRef.kindId);
  const snapshot = selected?.observation.snapshot;
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, unknown>>({ title: snapshot?.title ?? '' });
  const write = useTriageTaskCommit(props.onApplied);
  if (kind?.task !== true || selected === null || snapshot === undefined) return null;
  const capabilities = snapshot.taskCapabilities ?? kind.taskCapabilities;
  const canEdit = snapshot.projectionTruncated !== true && capabilities?.editFields?.includes('title') === true
    && resolveTriageSourceTaskOperationV1(context.targetedContributions, props.row.entryRef.source, 'edit') !== undefined;
  const transitions = resolveTriageSourceTaskOperationV1(context.targetedContributions, props.row.entryRef.source, 'transition') === undefined
    ? [] : capabilities?.transitions ?? [];
  const address = { v: 1, entryRef: props.row.entryRef, sourceInstanceId: selected.sourceInstanceId, lastKnownLocator: selected.observation.locator };
  const disabled = props.disabled || write.busy || write.result?.kind === 'uncertain';
  return <Stack gap="small">
    {/* A source without the edit role never gets a greyed "Edit task": a control that cannot succeed is not drawn. */}
    {!canEdit && !editing ? null : !editing ? <Button title={text('plugins.triage.tasks.edit', 'Edit task')} variant="plain" disabled={disabled}
      onPress={() => { setDraft({ title: snapshot.title }); setEditing(true); }} /> : <Form
      value={draft} onChange={setDraft} disabled={disabled || !canEdit} busy={write.busy}
      hints={{ submitLabel: text('plugins.triage.tasks.save', 'Save changes'), fields: [
        { path: 'title', title: text('plugins.triage.tasks.taskTitle', 'Title'), widget: 'text', required: true },
      ] }} onCancel={() => setEditing(false)} onSubmit={async (value) => {
        const title = typeof value.title === 'string' ? value.title.trim() : '';
        if (!canEdit || disabled || !title || title === snapshot.title) return;
        await write.commit(TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1, { ...address, fields: { title } });
      }} />}
    {transitions.length === 0 ? null : <Select label={text('plugins.triage.tasks.transition', 'Change status')} presentation="field"
      disabled={disabled} value={null} options={transitions.map((transition) => ({ value: transition.id, label: transition.label }))}
      onChange={(value) => { if (!disabled && typeof value === 'string' && transitions.some((transition) => transition.id === value))
        void write.commit(TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, { ...address, transitionId: value }); }} />}
    <TaskWriteNotice result={write.result} />
  </Stack>;
}
