import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
  Button,
  Banner,
  EmptyState,
  ErrorState,
  Icon,
  Item,
  ItemGroup,
  LoadingState,
  TaskStatusGlyph,
  defineUiSurface,
  usePluginHostApi,
  usePluginTranslation,
  usePluginUiEphemeralSharedScope,
  useSurfaceContext,
  usePluginSurfaceActivity,
} from '@happier-dev/plugin-ui';

import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, type TriageMountedUiOperationV1, type TriageMountedUiResultV1 } from '../../actions/mountedUiProtocol.js';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, triageTaskStatusCategoryV1 } from '@happier-dev/triage-protocol/v1';
import { bindTriageMountedUiActions } from '../mountedActions.js';
import { useTriageCurrentUiContextPublication } from '../currentContextPublication.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1, TRIAGE_TASK_DETAIL_DESTINATION_V1 } from '../../composer/openEntryDetails.js';
import { TRIAGE_LIST_DEFAULT_LENS_V1, triageEntryRowKey } from '../../projection/listWindow.js';
import { readTriageSourceDescriptorV1 } from '../detail/sourceSurface.js';
import { readTriageRowBylinePlaceV1, readTriageRowDetailToneV1, readTriageRowMarkV1, readTriageTaskDueV1 } from '../list/rows.js';
import { openTriageLinkedEntry } from '../navigation/openLinkedEntry.js';
import { projectTriageEntryDisplay } from '../window/entryDisplay.js';
import { projectTriageListWindow } from '../window/mountedWindow.js';
import { useTriageListWindow } from '../window/useTriageListWindow.js';
import { useTriageListWindowViewDemand } from '../window/useTriageListWindowViewDemand.js';
import { planTriageListItemsV1 } from '../list/sections.js';
import { TRIAGE_ROUTE_DEFAULT_LENS_V1 } from '../navigation/location.js';

/**
 * How many of the newest entries the Home widget shows. Home is a glance, not the list: the page
 * holds everything else, one press away through each row and the section's Open.
 */
export const TRIAGE_LATEST_WIDGET_ROWS_V1 = 5;

const LATEST_LENS = Object.freeze({ ...TRIAGE_LIST_DEFAULT_LENS_V1, limit: TRIAGE_LATEST_WIDGET_ROWS_V1 });

/**
 * **New in PRs & Issues**, the Home widget (`shell-extensibility` §2.1, §3.5).
 *
 * It reads the same mounted window the page and the Composer picker share: one store, one
 * single-flight, one pacing interval. The window is retained by the host while nothing shows it,
 * so coming back to Home draws the last rows at once and revalidates them — stale first, then
 * fresh — with no timer anywhere. Mounting is the only demand it makes; Home builds it only while
 * it is focused and on screen.
 */
export function TriageLatestWidget({ tasksOnly = false }: Readonly<{ tasksOnly?: boolean }>): React.ReactElement {
  const text = usePluginTranslation();
  const hostApi = usePluginHostApi();
  const surfaceContext = useSurfaceContext();
  const sharedScope = usePluginUiEphemeralSharedScope();
  const window = useTriageListWindow();
  const activity = usePluginSurfaceActivity();
  const mountId = React.useId();
  useTriageListWindowViewDemand(true, window.refresh, window.readiness, window.readOwner);
  const snapshot = window.snapshot;
  const refresh = React.useCallback(() => window.refresh('manual'), [window.refresh]);
  const runMountedOperation = React.useCallback(async (operation: TriageMountedUiOperationV1, signal: AbortSignal): Promise<TriageMountedUiResultV1> => {
    if (signal.aborted || operation.kind !== 'refresh') return { status: 'unavailable' };
    await refresh();
    return { status: 'applied' };
  }, [refresh]);
  React.useLayoutEffect(() => sharedScope === null || !activity.active ? undefined : bindTriageMountedUiActions(
    sharedScope, mountId, runMountedOperation,
  ), [activity.active, mountId, runMountedOperation, sharedScope]);
  const currentUiContext = React.useMemo(() => ({ detail: {
    view: tasksOnly ? 'tasks-widget' : 'latest-widget',
    mountedAction: { action: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 }, mountId },
  } }), [mountId, tasksOnly]);
  useTriageCurrentUiContextPublication(hostApi, currentUiContext);

  const rows = React.useMemo(
    () => {
      if (snapshot.window === undefined) return undefined;
      const projected = projectTriageListWindow(tasksOnly ? TRIAGE_LIST_DEFAULT_LENS_V1 : LATEST_LENS, hostApi, sharedScope)?.rows;
      if (!tasksOnly || projected === undefined) return projected;
      const mine = planTriageListItemsV1({ rows: projected, pins: [], workflowSubjectOf: () => null,
        tasks: { audience: 'mine', hasSessions: () => false, isTask: (ref) => readTriageSourceDescriptorV1(surfaceContext, ref.source)
          ?.kinds.some((kind) => kind.id === ref.kindId && kind.task === true) === true } });
      const wanted = new Set(mine.slice(0, TRIAGE_LATEST_WIDGET_ROWS_V1).map((item) => item.key));
      return projected.filter((row) => wanted.has(triageEntryRowKey(row.entryRef)));
    },
    [hostApi, sharedScope, snapshot.window, surfaceContext.targetedContributions, tasksOnly],
  );
  const openPage = React.useCallback(() => {
    void hostApi.openSurface(tasksOnly ? TRIAGE_TASK_DETAIL_DESTINATION_V1 : TRIAGE_ENTRY_DETAIL_DESTINATION_V1,
      undefined, { subPath: tasksOnly ? 'tasks,mine' : '' }).catch(() => undefined);
  }, [hostApi, tasksOnly]);
  const taskCoverageNotice = !tasksOnly ? null : snapshot.freshness === 'stale'
    ? <Banner tone="warning" title={text('plugins.triage.surface.lastKnown', 'Showing the last known list')} />
    : snapshot.window?.coverage === 'partial'
      ? <Banner tone="info" title={text('plugins.triage.surface.empty.incomplete.title', 'This list is not complete yet')} /> : null;

  if (rows === undefined) {
    if (snapshot.error !== undefined) {
      return (
        <ErrorState
          testID="triage-latest-widget.error"
          titleKey="plugins.triage.widget.error"
          title="The latest entries could not be read"
          {...(snapshot.error.detail === undefined ? {} : { details: snapshot.error.detail })}
          {...(snapshot.error.retryable === false ? {} : {
            action: (
              <Button
                variant="secondary"
                titleKey="plugins.triage.widget.retry"
                title="Try again"
                onPress={() => { void refresh(); }}
              />
            ),
          })}
        />
      );
    }
    return (
      <LoadingState
        testID="triage-latest-widget.loading"
        titleKey="plugins.triage.widget.loading"
        title="Loading the latest entries"
        rows={3}
      />
    );
  }

  if (rows.length === 0) {
    if (tasksOnly) return <>{taskCoverageNotice}<EmptyState layout="line" title={text('plugins.triage.tasks.myTasks', 'My tasks')}
      description={text('plugins.triage.tasks.description', 'Your work, and the agents working with you.')}
      action={<Button title={text('plugins.triage.tasks.title', 'Tasks')} variant="plain" onPress={openPage} />} /></>;
    return snapshot.configuredSources.length === 0 ? (
      <EmptyState
        testID="triage-latest-widget.noSources"
        layout="line"
        titleKey="plugins.triage.widget.noSources"
        title="Connect a source to see new pull requests and issues here."
        action={<Button variant="secondary" titleKey="plugins.triage.widget.setUp" title="Set up" onPress={openPage} />}
      />
    ) : (
      <EmptyState
        testID="triage-latest-widget.empty"
        layout="line"
        titleKey="plugins.triage.widget.empty"
        title="Nothing new right now"
      />
    );
  }

  return (
    <>
    {taskCoverageNotice}
    <ItemGroup testID="triage-latest-widget.rows">
      {rows.map((row) => {
        const display = projectTriageEntryDisplay(row, text);
        // The page's row mark and detail tone (one owner): the entry's kind glyph, loud only when it
        // needs the reader.
        const workflowSubject = readTriageSourceDescriptorV1(surfaceContext, row.entryRef.source)
          ?.kinds.find((kind) => kind.id === row.entryRef.kindId)?.workflowSubject ?? null;
        const mark = readTriageRowMarkV1(display, workflowSubject);
        const detailTone = readTriageRowDetailToneV1(display);
        // My tasks (lab `tasks-widget`): the status category leads, line two is where and the key, and the one
        // loud fact is Overdue, then Due today, then Blocked (the page's precedence); why-it's-here reasons stay on
        // PRs & Issues.
        const snapshot = row.content?.outcome.snapshot;
        const category = tasksOnly && snapshot !== undefined ? triageTaskStatusCategoryV1(snapshot.state) : null;
        if (tasksOnly) {
          const blocked = (snapshot?.relations?.blockedBy?.length ?? 0) > 0;
          const due = readTriageTaskDueV1(snapshot?.dueDate, category, surfaceContext.locale, Date.now(), text);
          const loud = due !== null && due.tone !== null ? { detail: due.label, detailTone: due.tone }
            : blocked ? { detail: text('plugins.triage.tasks.progress.blocked', 'Blocked') } : null;
          return (
            <Item
              key={display.key}
              testID={`triage-latest-widget.row.${display.key}`}
              title={display.title}
              titleNumberOfLines={1}
              subtitle={readTriageRowBylinePlaceV1(display)}
              subtitleNumberOfLines={1}
              icon={category === null ? <Icon name={mark.name} size="small" tone={mark.tone} /> : <TaskStatusGlyph category={category} />}
              {...(loud === null ? {} : { ...loud, detailNumberOfLines: 1 })}
              density="compact"
              onPress={() => { void openTriageLinkedEntry(hostApi, row.entryRef, undefined,
                { ...TRIAGE_ROUTE_DEFAULT_LENS_V1, filters: { ...TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, tasks: 'mine' } }); }}
            />
          );
        }
        return (
          <Item
            key={display.key}
            testID={`triage-latest-widget.row.${display.key}`}
            title={display.title}
            titleNumberOfLines={1}
            subtitle={display.scopeLabel}
            subtitleNumberOfLines={1}
            icon={<Icon name={mark.name} size="small" tone={mark.tone} />}
            {...(display.detail === null ? {} : { detail: display.detail, detailNumberOfLines: 1 })}
            {...(detailTone === undefined ? {} : { detailTone })}
            density="compact"
            onPress={() => { void openTriageLinkedEntry(hostApi, row.entryRef, undefined,
              tasksOnly ? { ...TRIAGE_ROUTE_DEFAULT_LENS_V1, filters: { ...TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, tasks: 'mine' } } : undefined); }}
          />
        );
      })}
    </ItemGroup>
    </>
  );
}

export const renderSurface: RenderSurface = defineUiSurface(() => <TriageLatestWidget />);
