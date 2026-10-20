import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';

import {
  RunClock,
  RunGlyph,
} from '@/components/projects/projectSetup/ProjectRunMarks';
import { presentProjectRun } from '@/components/projects/projectSetup/projectScriptPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { actionOperationAddress } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';

import { readActionOperationOutputAttachment } from './actionOperationDetailPresentation';
import { openActionOperationDetail } from './openActionOperationDetail';
import { ProjectCommandOutputFrame } from './ProjectCommandOutputFrame';
import { ProjectCommandOutputPane } from './ProjectCommandOutputPane';
import { useActionOperationStopControl } from './useActionOperationStopControl';

export type ProjectCommandOutputPageProps = CustomModalInjectedProps &
  Readonly<{
    serverId: string;
    operationId: string;
    /** The script's name ("test", "Setup"): the page title. */
    name: string;
    /** What runs, as declared; omitted when the caller has no declaration for it. */
    command: string | null;
  }>;

/**
 * A project command's output as its own page on a phone (lab `s-scripts` OUTPUTp): the script, how its
 * run is going or went and where, what runs, and the same retained terminal the wide row discloses.
 * The operation stays live while the page is open; Stop is the page's only action while it runs.
 */
export const ProjectCommandOutputPage = React.memo(
  function ProjectCommandOutputPage(props: ProjectCommandOutputPageProps) {
    const { theme } = useUnistyles();
    const operation = useActionOperation(
      actionOperationAddress(props.serverId, props.operationId),
    );
    const attachment = operation
      ? readActionOperationOutputAttachment(operation.snapshot)
      : null;
    const target = useServerScopedMachine(
      attachment?.serverId ?? props.serverId,
      attachment?.machineId ?? '',
    );
    const machineName =
      (target ? getMachineSentenceName(target) : null) ??
      attachment?.machineId ??
      null;
    const presentation = presentProjectRun(operation ?? null, machineName, '');
    const stop = useActionOperationStopControl(operation);
    const [outputHeight, setOutputHeight] = React.useState<number | null>(null);
    const { setChrome } = props;

    React.useEffect(() => {
      setChrome?.({
        kind: 'card',
        title: props.name,
        testID: 'project-command-output-page',
        phonePresentation: 'fullscreen',
        scrollHost: 'body',
        bodyScroll: 'none',
      });
      return () => setChrome?.(null);
    }, [props.name, setChrome]);

    const stopping = stop.pending || stop.stopRequested;
    const status = stopping ? t('projects.scripts.run.stopping') : presentation.text;
    // A live run names its machine in its own words ("Running on hz-build-1"); a settled one adds it quietly.
    const ranOn = !presentation.live && !stopping && machineName
      ? t('projects.scripts.agentOn', { machine: machineName }) : null;
    const statusColor =
      presentation.tone === 'danger'
        ? theme.colors.status.error
        : presentation.tone === 'attention'
          ? theme.colors.state.attention.foreground
          : theme.colors.text.primary;
    const canStop =
      presentation.live && operation?.snapshot.cancellation === 'supported';
    const onOutputLayout = React.useCallback((event: LayoutChangeEvent) => {
      const next = Math.floor(event.nativeEvent.layout.height);
      setOutputHeight((previous) => (previous === next ? previous : next));
    }, []);

    if (!operation) {
      return (
        <View style={[styles.page, styles.empty]} testID="project-command-output-page.body">
          <SurfaceStateCard size="line" kind="unavailable" title={t('inbox.actionOperations.unavailableTitle')}
            reason={t('inbox.actionOperations.unavailableDescription')} testID="project-command-output-page.unavailable" />
        </View>
      );
    }
    return (
      <View style={styles.page} testID="project-command-output-page.body">
        <View
          style={styles.statusRow}
          testID="project-command-output-page.status"
          accessibilityLiveRegion="polite"
        >
          <RunGlyph glyph={presentation.glyph} />
          <Text
            style={[styles.status, { color: statusColor }]}
            numberOfLines={2}
          >
            {status}
            {ranOn ? (
              <Text style={{ color: theme.colors.text.secondary }}>{` · ${ranOn}`}</Text>
            ) : null}
          </Text>
          {presentation.live && presentation.startedAt ? (
            <RunClock startedAt={presentation.startedAt} />
          ) : null}
        </View>
        {props.command ? (
          <Text
            testID="project-command-output-page.command"
            numberOfLines={2}
            style={[styles.command, { color: theme.colors.text.secondary }]}
          >
            {props.command}
          </Text>
        ) : null}
        <View style={styles.output} onLayout={onOutputLayout}>
          {/* Before a terminal exists the status line already says what the run is doing (queued,
              copying, preparing); only a settled run with nothing to read says so here. */}
          {operation && outputHeight && attachment?.terminalId ? (
            <ProjectCommandOutputFrame>
              <ProjectCommandOutputPane
                operation={operation}
                title={props.name}
                height={outputHeight}
                onOpenDetail={() =>
                  openActionOperationDetail({
                    serverId: props.serverId,
                    operationId: props.operationId,
                  })
                }
              />
            </ProjectCommandOutputFrame>
          ) : operation && !presentation.live ? (
            <View style={styles.empty}>
              <SurfaceStateCard size="line" kind="empty" title={t('projects.scripts.output.empty')}
                testID="project-command-output-page.noOutput" />
            </View>
          ) : null}
        </View>
        {canStop ? (
          <View style={styles.footer}>
            <RoundButton
              display="secondary"
              testID="project-command-output-page.stop"
              title={
                stopping
                  ? t('projects.scripts.run.stopping')
                  : t('projects.scripts.stopScript', { name: props.name })
              }
              loading={stop.pending}
              disabled={stopping}
              onPress={stop.requestStop}
            />
          </View>
        ) : null}
      </View>
    );
  },
);

/** Opens a project command's output page (phone); the operation detail stays one press away inside it. */
export function openProjectCommandOutputPage(
  props: Omit<ProjectCommandOutputPageProps, keyof CustomModalInjectedProps>,
): void {
  Modal.show({
    component: ProjectCommandOutputPage,
    props,
    closeOnBackdrop: true,
    accessibilityLabel: props.name,
  });
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    minHeight: 0,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s16,
    gap: theme.space.s8,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
    minHeight: 32,
  },
  status: {
    flex: 1,
    minWidth: 0,
    ...Typography.default(),
    ...happierPageTextMetrics('rowTitle'),
  },
  command: {
    ...Typography.mono(),
    ...happierPageTextMetrics('meta'),
    paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
  },
  output: {
    flex: 1,
    minHeight: 0,
    paddingTop: theme.space.s4,
  },
  empty: {
    paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
  },
  footer: {
    paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx,
  },
}));
