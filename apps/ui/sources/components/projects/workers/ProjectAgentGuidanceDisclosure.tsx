import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveProjectExecutionChoiceV1, type ProjectExecutionChoiceResolutionV1, type WorkerDestinationV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

import {
  readProjectSetupAgentGuidance,
  type ProjectSetupAgentGuidance,
} from '@/components/projects/projectSetup/projectSetupAuthoring';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { t } from '@/text';
import { describeMachineDestinationWorkerFacts } from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';

const RUN_COMMAND = 'happier project script run <name> [--on <machine>]';
const EXEC_COMMAND = 'happier project compute exec -- <argv>';

/**
 * The read-only facts as agents receive them, in reading order (lab `s-agent` GUIDE): which scripts
 * may leave the checkout, how to run one, and whether explicit ad-hoc commands are allowed. Advisory
 * facts only: nothing here is approval or an accepted placement.
 */
export function describeProjectAgentGuidance(
  guidance: ProjectSetupAgentGuidance,
  project: string,
): string {
  const scripts = guidance.scripts ?? [];
  const portable = scripts
    .filter((script) => script.execution === 'portable')
    .map((script) => script.name);
  const primary = scripts
    .filter((script) => script.execution !== 'portable')
    .map((script) => script.name);
  const width =
    Math.max(portable.join(', ').length, primary.join(', ').length) + 2;
  const line = (names: readonly string[], note: string) =>
    `${names.join(', ').padEnd(width)}${note}`;
  const destinationLabel = (destination: WorkerDestinationV1) => destination.kind === 'machine'
    ? destination.machineId
    : t(destination.selection === 'ask' ? 'projectWorkers.poolAsk' : 'projectWorkers.poolAutomatic', { pool: destination.poolId });
  const resolutionLabel = (resolution: ProjectExecutionChoiceResolutionV1) => {
    if (resolution.status === 'resolved') return resolution.choice.kind === 'primary'
      ? t('projectWorkers.primary') : destinationLabel(resolution.choice.destination);
    switch (resolution.reason) {
      case 'ad_hoc_disabled': return t('projectWorkers.guideAdHocOff');
      case 'preferences_unavailable': return t('projectWorkers.policyUnavailable');
      case 'destination_missing': return t('projectWorkers.destinationMissing');
      case 'primary_only': return t('projectWorkers.primaryOnly');
      case 'override_requires_review': return t('projectWorkers.changed');
    }
  };
  const targetLines: string[] = [];
  const destination = guidance.destination;
  if (destination && 'configured' in destination && destination.configured && destination.observation) {
    targetLines.push(`${t('projectWorkers.destination')}: ${destinationLabel(destination.configured)}`);
    const observation = destination.observation;
    if ('eligible' in observation) {
      const facts = describeMachineDestinationWorkerFacts(observation.eligible
        ? { eligible: true, worker: observation }
        : { eligible: false, reason: 'worker_refused', worker: observation });
      if (facts) targetLines.push(facts);
      if (!observation.eligible) {
        if (observation.explanation === 'not_accepting') targetLines.push(t('projectWorkers.notAcceptingDetail'));
        if (observation.explanation === 'worker_copy_missing') targetLines.push(t('projectWorkers.setUpCopy', {
          machine: observation.workerCopy?.targetMachineId ?? destinationLabel(destination.configured),
        }));
        else targetLines.push(t('common.retry'));
      }
    } else if ('kind' in observation) {
      targetLines.push(observation.kind === 'resolved'
        ? `${t('projectWorkers.destination')}: ${observation.machineId}`
        : t(observation.reason === 'empty' || observation.reason === 'no_available_machine'
          ? 'projectWorkers.empty' : 'projectWorkers.statusUnavailable'));
      if (observation.kind === 'unavailable') targetLines.push(t('projectWorkers.emptyDetail'));
    } else {
      targetLines.push(t('projectWorkers.statusUnavailable'), t('common.retry'));
    }
  }
  const preferences = guidance.workerPreferences;
  if ('status' in preferences && preferences.status === 'ready') {
    const fallback = preferences.preference.unavailable;
    targetLines.push(`${t('projectWorkers.whenUnavailable')}: ${t(fallback === 'primary'
      ? 'projectWorkers.fallbackPrimary' : fallback === 'fail' ? 'projectWorkers.fallbackFail' : 'projectWorkers.fallbackAsk')}`);
  } else {
    targetLines.push(t('projectWorkers.policyUnavailable'));
    targetLines.push('status' in preferences && preferences.status === 'locked'
      ? t('projectWorkers.settingsLocked') : t('common.retry'));
  }
  // The workspace default is independent of declaration policy and named overrides.
  const overrides = 'status' in preferences && preferences.status === 'ready' ? preferences.preference.scriptOverrides : {};
  const isOverridden = (name: string) => Object.hasOwn(overrides, name);
  const workspaceDefault = 'status' in preferences && preferences.status === 'ready'
    ? resolveProjectExecutionChoiceV1({ execution: 'portable', preference: { status: 'ready', value: preferences.preference } })
    : null;
  const scriptTargetLines = [
    ...(workspaceDefault ? [t('projectWorkers.defaultSummary', { destination: resolutionLabel(workspaceDefault) })] : []),
    ...scripts.filter(script => isOverridden(script.name))
      .map(script => `${script.name}: ${resolutionLabel(script.resolution)}`),
  ];
  const adHoc = guidance.adHoc.resolution;
  return [
    `# ${t('projectWorkers.guideHeader', { project })}`,
    ...(portable.length > 0
      ? [line(portable, t('projectWorkers.guideWorker'))]
      : []),
    ...(primary.length > 0
      ? [line(primary, t('projectWorkers.guidePrimary'))]
      : []),
    ...(guidance.scripts === null ? [t('projectWorkers.guideUnavailable'), t('common.retry')]
      : scripts.length === 0 ? [t('projectWorkers.guideNoScripts')] : []),
    ...scriptTargetLines,
    ...targetLines,
    '',
    `${t('projectWorkers.guideRunOne')}  ${RUN_COMMAND}`,
    `  · ${t('projectWorkers.guideOutput')}`,
    `  · ${t('projectWorkers.guideQueue')}`,
    `  · ${t('projectWorkers.guideExit')}`,
    '',
    `${t('projectWorkers.guideOther')}  ${EXEC_COMMAND}`,
    `  · ${adHoc.status === 'resolved' ? t('projectWorkers.guideAdHocOn') : resolutionLabel(adHoc)}`,
    ...(adHoc.status === 'resolved'
      ? [`  · ${t('projectWorkers.defaultSummary', { destination: resolutionLabel(adHoc) })}`] : []),
  ].join('\n');
}

type GuidanceRead =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; text: string }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * "What agents are told" (R3b-07): a disclosure on Scripts › Agents that demand-reads the factual
 * owner (`readProjectSetupAgentGuidance`) only while open, and re-reads when the project file or the
 * checkout's worker preferences change (`factsKey`).
 */
export function ProjectAgentGuidanceDisclosure(
  props: Readonly<{
    testID: string;
    workspace: WorkspaceAddressV1;
    /** Identity of the facts it is generated from (definition basis + observed preference revision). */
    factsKey: string;
    showDivider?: boolean;
  }>,
) {
  const [expanded, setExpanded] = React.useState(false);
  const [read, setRead] = React.useState<Readonly<{
    key: string;
    value: GuidanceRead;
  }> | null>(null);
  const project =
    props.workspace.rootPath.split(/[\\/]/).filter(Boolean).pop() ??
    props.workspace.rootPath;
  const key = JSON.stringify([
    props.factsKey,
    props.workspace.serverId,
    props.workspace.workspaceId,
  ]);

  React.useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setRead((current) =>
      current?.key === key ? current : { key, value: { kind: 'loading' } },
    );
    void readProjectSetupAgentGuidance({
      workspace: props.workspace,
      page: 'scripts',
      signal: controller.signal,
    }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setRead({
          key,
          value:
            result.kind === 'ready'
              ? {
                  kind: 'ready',
                  text: describeProjectAgentGuidance(result.guidance, project),
                }
              : { kind: 'unavailable' },
        });
      },
      () => {
        if (!controller.signal.aborted)
          setRead({ key, value: { kind: 'unavailable' } });
      },
    );
    return () => controller.abort();
    // The workspace fields are part of `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, key, project]);

  const value = read?.key === key ? read.value : { kind: 'loading' as const };
  return (
    <ExpandableItem
      testID={props.testID}
      expanded={expanded}
      onExpandedChange={setExpanded}
      showDivider={props.showDivider}
      header={({ headerProps }) => (
        <Item
          {...(headerProps as Readonly<Record<string, unknown>>)}
          title={t('projectWorkers.guideTitle')}
          subtitle={t('projectWorkers.guideDetail')}
        />
      )}
    >
      {!expanded ? null : value.kind === 'ready' ? (
        <View testID={`${props.testID}.text`} style={styles.block}>
          <CodeBlockView code={value.text} showHeaderRow={false} wrap showCopyButton />
        </View>
      ) : (
        <SurfaceStateCard
          size="line"
          testID={`${props.testID}.state`}
          kind={value.kind === 'loading' ? 'loading' : 'unavailable'}
          title={
            value.kind === 'loading'
              ? t('common.loading')
              : t('projectWorkers.guideUnavailable')
          }
        />
      )}
    </ExpandableItem>
  );
}

const styles = StyleSheet.create(() => ({
  block: { marginHorizontal: 16, marginBottom: 12 },
}));
