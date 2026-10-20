import * as React from 'react';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { defineUiSurface, ErrorState, LoadingState, Stack, Status, Text, usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import { sameTriageEntryReference, sameTriageSourceIdentity } from '../corpus/identity/components.js';
import { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from './source.js';

type Task = Extract<PluginActionResultById['tasks.internal.list'], { status: 'ok' }>['todos'][number];

/** Source-native body; the aggregate owns its frame, task edits and linked work. */
function InternalTaskDetail(context: RenderContext): React.ReactElement {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const input = React.useMemo(() => {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
    if (!parsed.success) return null;
    const entryRef = parsed.data.observation.entryRef;
    return sameTriageSourceIdentity(parsed.data.instance.instance.source, INTERNAL_TASK_SOURCE_V1)
      && sameTriageEntryReference(entryRef, { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1(entryRef.entryId) })
      ? parsed.data : null;
  }, [context.launchInput]);
  const taskId = input?.observation.entryRef.entryId ?? null;
  const observedAtMs = input?.observation.observedAtMs ?? null;
  const [read, setRead] = React.useState<Readonly<{ host: typeof host; taskId: string; task: Task | null; failed: boolean }> | null>(null);
  React.useEffect(() => {
    if (taskId === null) return;
    const controller = new AbortController();
    const fail = () => {
      if (controller.signal.aborted) return;
      setRead(previous => ({ host, taskId, failed: true,
        task: previous?.host === host && previous.taskId === taskId ? previous.task : null }));
    };
    void host.executeAction('tasks.internal.list', {}, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if (result.status !== 'ok') { fail(); return; }
      setRead({ host, taskId, task: result.todos.find(task => task.id === taskId) ?? null, failed: false });
    }).catch(fail);
    return () => controller.abort();
  }, [host, taskId, observedAtMs]);
  // The Host API is Account-bound. Retained notes never cross a replacement authority.
  const currentRead = read?.host === host && read.taskId === taskId ? read : null;
  if (taskId === null || (currentRead !== null && currentRead.task === null)) {
    return <ErrorState title={text('plugins.triage.internal.unavailable', 'This task could not be read')} />;
  }
  if (!currentRead?.task) return <LoadingState title={text('plugins.triage.internal.loading', 'Reading task…')} />;
  return <Stack gap="medium">
    {/* The last good read stays; a failed refresh over it is one quiet line, not an error card above the notes. */}
    {currentRead.failed ? <Status tone="warning" label={text('plugins.triage.internal.unavailable', 'This task could not be read')} /> : null}
    {currentRead.task.notes === undefined ? null : <Text variant="reading" value={currentRead.task.notes} />}
    {currentRead.task.labels?.length ? <Text variant="meta" tone="secondary" value={currentRead.task.labels.join(' · ')} /> : null}
    {currentRead.task.links?.map(link => <Text key={link.url} variant="meta" value={link.title ? `${link.title} · ${link.url}` : link.url} />)}
  </Stack>;
}

export const renderSurface: RenderSurface = defineUiSurface(InternalTaskDetail);
