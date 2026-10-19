import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ProjectSetupReviewV1Schema, type ProjectSetupReviewV1 } from '@happier-dev/protocol/actions/projectSetupConsentFailure';
import { ProjectExecutionChoiceV1Schema } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { ApprovalRequest } from '@happier-dev/protocol';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  useMachinePoolListForServer,
  useServerScopedMachine,
} from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { listReviewedSetupCommands } from '@/components/projects/projectSetup/projectSetupEffectPresentation';
import { formatProjectInvocation } from '@/components/projects/projectSetup/projectScriptPresentation';
import { ProjectSetupReviewFacts } from '@/components/projects/projectSetup/ProjectSetupReview';

export type ProjectCommandApprovalPresentation =
  | Readonly<{
      kind: 'exec';
      workspace: WorkspaceAddressV1;
      serverId: string;
      sourceMachineId: string;
      command: string;
      cwd: string;
      destination: Destination;
    }>
  | Readonly<{
      kind: 'script';
      workspace: WorkspaceAddressV1;
      serverId: string;
      sourceMachineId: string;
      name: string;
      destination: Destination;
    }>
  | Readonly<{
      /** Target-produced setup review; presentation never grants consent or executes it. */
      kind: 'setup';
      workspace: WorkspaceAddressV1;
      serverId: string;
      sourceMachineId: string;
      destination: Destination;
      setupReview: ProjectSetupReviewV1 | null;
    }>
  | Readonly<{
      /** A declared service's current effect, disclosed by the starter before it launches (plan 22). */
      kind: 'service';
      serverId: string;
      sourceMachineId: string;
      command: string | null;
      destination: Destination;
    }>;
type Destination =
  | Readonly<{ kind: 'primary' }>
  | Readonly<{ kind: 'machine'; machineId: string }>
  | Readonly<{ kind: 'pool'; poolId: string }>;

/**
 * An agent's finite Project command waiting on the person's configurable Action approval (lab `s-agent`
 * ADHOC, plan 21 §6): the exact command, where it would run, what files it sees and as whom. It reads the
 * request's own strict Action input; it decides nothing and grants no setup consent.
 */
export function readProjectCommandApproval(
  approval: Pick<ApprovalRequest, 'actionId' | 'actionArgs'> & Partial<Pick<ApprovalRequest, 'preview'>>,
): ProjectCommandApprovalPresentation | null {
  if (approval.actionId === 'projects.compute.exec') {
    const input = PROJECT_ACTION_INPUT_SCHEMAS_V1[
      'projects.compute.exec'
    ].safeParse(approval.actionArgs);
    if (!input.success) return null;
    const { workspace, executable, argv, cwd, choice } = input.data;
    return {
      kind: 'exec',
      workspace,
      serverId: workspace.serverId,
      sourceMachineId: workspace.machineId,
      command: formatProjectInvocation({ tool: executable, args: argv }),
      cwd,
      destination: readDestination(choice),
    };
  }
  if (approval.actionId === 'projects.prepare') {
    const input = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.prepare'].safeParse(approval.actionArgs);
    // Teardown is not a setup ask; it keeps the generic Action reading.
    if (!input.success || input.data.phase !== 'setup') return null;
    const reviewed = ProjectSetupReviewV1Schema.safeParse(isRecord(approval.preview) ? approval.preview.setupReview : undefined);
    const setupReview = reviewed.success && (input.data.expectedEffectDigest === undefined
      || input.data.expectedEffectDigest === reviewed.data.reviewedEffectDigest) ? reviewed.data : null;
    return {
      kind: 'setup',
      workspace: input.data.workspace,
      serverId: input.data.workspace.serverId,
      sourceMachineId: input.data.workspace.machineId,
      destination: { kind: 'primary' },
      setupReview,
    };
  }
  if (approval.actionId === 'projects.script.run') {
    const input = PROJECT_ACTION_INPUT_SCHEMAS_V1[
      'projects.script.run'
    ].safeParse(approval.actionArgs);
    if (!input.success) return null;
    const { workspace, selection, choice } = input.data;
    const name =
      selection.kind === 'named'
        ? selection.name
        : `${selection.source.file}#${selection.source.target}`;
    return {
      kind: 'script',
      workspace,
      serverId: workspace.serverId,
      sourceMachineId: workspace.machineId,
      name,
      destination: readDestination(choice),
    };
  }
  return null;
}

/**
 * A declared service's reviewed effect (the starter's safe `reviewedEffect` DTO) as the same facts:
 * the exact command, where it runs, which files it sees. A worker copy names its concrete target.
 */
export function readProjectServiceEffectApproval(input: Readonly<{
  serverId: string;
  sourceMachineId: string;
  reviewedEffect: unknown;
}>): ProjectCommandApprovalPresentation {
  const effect = isRecord(input.reviewedEffect) ? input.reviewedEffect : {};
  const serviceEffect = isRecord(effect.serviceEffect) ? effect.serviceEffect : null;
  const command = listReviewedSetupCommands({ commands: [effect.command ?? serviceEffect?.command].filter(Boolean) })?.[0] ?? null;
  const target = isRecord(effect.target) && typeof effect.target.machineId === 'string' ? effect.target.machineId : null;
  const choice = ProjectExecutionChoiceV1Schema.safeParse(effect.choice);
  return {
    kind: 'service',
    serverId: input.serverId,
    sourceMachineId: input.sourceMachineId,
    command,
    destination: target && target !== input.sourceMachineId
      ? { kind: 'machine', machineId: target }
      : readDestination(choice.success ? choice.data : undefined),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readDestination(choice: ProjectExecutionChoiceV1 | undefined): Destination {
  if (!choice || choice.kind === 'primary') return { kind: 'primary' };
  return choice.destination.kind === 'machine'
    ? { kind: 'machine', machineId: choice.destination.machineId }
    : { kind: 'pool', poolId: choice.destination.poolId };
}

/** The card's question: one-off commands and named Scripts ask differently; a worker is named as such. */
export function describeProjectCommandApprovalTitle(
  presentation: ProjectCommandApprovalPresentation,
  sourceMachineName: string,
): string {
  if (presentation.kind === 'setup')
    return t('projects.authoring.sessionAsk', { machine: sourceMachineName });
  if (presentation.kind === 'script')
    return t('projects.scripts.adhocRunScriptTitle', { name: presentation.name });
  return presentation.destination.kind === 'primary'
    ? t('projects.scripts.adhocTitle')
    : t('projects.scripts.adhocTitleWorker');
}

/** The question and the decision labels of a Project approval, named by the machine, never its id. */
export function useProjectCommandApprovalTitle(
  presentation: ProjectCommandApprovalPresentation | null,
): string | null {
  const source = useServerScopedMachine(presentation?.serverId ?? null, presentation?.sourceMachineId ?? '');
  return presentation
    ? describeProjectCommandApprovalTitle(presentation, source ? getMachineSentenceName(source) : presentation.sourceMachineId)
    : null;
}

/** The two decisions a Project approval asks, in the words of the Scripts page (setup) or the command card. */
export function describeProjectCommandApprovalDecisions(
  presentation: ProjectCommandApprovalPresentation,
): Readonly<{ approve: string; reject: string }> {
  return presentation.kind === 'setup'
    ? { approve: t('projects.scripts.setup.run'), reject: t('projects.scripts.setup.notNow') }
    : { approve: t('projects.scripts.adhocRunOnce'), reject: t('projects.scripts.adhocDeny') };
}

export const ProjectCommandApprovalFacts = React.memo(
  function ProjectCommandApprovalFacts(
    props: Readonly<{
      presentation: ProjectCommandApprovalPresentation;
      testID: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const { presentation } = props;
    const destination = presentation.destination;
    const source = useServerScopedMachine(
      presentation.serverId,
      presentation.sourceMachineId,
    );
    const target = useServerScopedMachine(
      presentation.serverId,
      destination.kind === 'machine' ? destination.machineId : '',
    );
    const pools = useMachinePoolListForServer(presentation.serverId);
    const sourceName =
      source ? getMachineSentenceName(source) : presentation.sourceMachineId;
    const pool =
      destination.kind === 'pool'
        ? (pools?.find((candidate) => candidate.pool.id === destination.poolId)?.pool ??
          null)
        : null;
    const where =
      destination.kind === 'primary'
        ? sourceName
        : destination.kind === 'machine'
          ? (target ? getMachineSentenceName(target) : destination.machineId)
          : t('projects.scripts.adhocWherePool', {
              pool: pool?.name ?? destination.poolId,
            });
    const runsOn =
      destination.kind === 'primary'
        ? source
        : destination.kind === 'machine'
          ? target
          : null;
    const runsAs =
      runsOn?.isShared && runsOn.metadata?.username
        ? t('projects.scripts.adhocAsUser', {
            user: runsOn.metadata.username,
            machine: where,
          })
        : destination.kind === 'pool'
          ? t('projects.scripts.adhocAsYouAnywhere')
          : t('projects.scripts.adhocAsYou', { machine: where });
    const rows: ReadonlyArray<readonly [string, string, string]> = [
      ['where', t('projects.scripts.adhocWhere'), where],
      ...(presentation.kind === 'service'
        ? []
        : [['checkout', t('common.path'), presentation.workspace.rootPath] as const]),
      [
        'files',
        t('projects.scripts.adhocFiles'),
        destination.kind === 'primary'
          ? t('projects.scripts.adhocFilesHere')
          : t('projects.scripts.adhocFilesCopy', { machine: sourceName }),
      ],
      ['as', t('projects.scripts.adhocAs'), runsAs],
    ];
    return (
      <View style={styles.root} testID={props.testID}>
        {presentation.kind !== 'setup' && (presentation.kind !== 'service' || presentation.command) ? (
          <View testID={`${props.testID}.command`}>
            <CodeBlockView
              code={presentation.kind === 'script' ? presentation.name : `$ ${presentation.command}`}
              showHeaderRow={false}
              wrap
            />
          </View>
        ) : null}
        {presentation.kind === 'setup' ? (
          presentation.setupReview ? (
            // The same review anatomy as the Scripts page and the Session ask; the owner reads the effect.
            <ProjectSetupReviewFacts
              testID={`${props.testID}.review`}
              reviewedEffect={presentation.setupReview.reviewedEffect}
              machineName={sourceName}
              sharedRunAs={null}
            />
          ) : (
            <Text
              style={[styles.value, { color: theme.colors.text.tertiary }]}
              testID={`${props.testID}.stepsUnavailable`}
            >
              {t('projects.scripts.setup.stepsUnavailable')}
            </Text>
          )
        ) : null}
        <View style={styles.rows}>
          {rows.map(([key, label, value]) => (
            <View key={key} style={styles.row}>
              <Text
                style={[styles.label, { color: theme.colors.text.tertiary }]}
              >
                {label}
              </Text>
              <Text
                style={[styles.value, { color: theme.colors.text.secondary }]}
                testID={`${props.testID}.${key}`}
              >
                {value}
              </Text>
            </View>
          ))}
        </View>
        {presentation.kind === 'exec' ? (
          <View
            style={[
              styles.note,
              { borderTopColor: theme.colors.border.subtle },
            ]}
          >
            <Icon name="info" size={12} color={theme.colors.text.tertiary} />
            <Text
              style={[styles.noteText, { color: theme.colors.text.tertiary }]}
            >
              {t('projects.scripts.adhocAllowedBy')}
            </Text>
          </View>
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create(() => ({
  root: { gap: 10 },
  rows: { gap: 4 },
  row: { flexDirection: 'row', gap: 12 },
  label: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), width: 56 },
  value: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), flex: 1, minWidth: 0 },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  noteText: { ...Typography.default(), ...happierPageTextMetrics('meta'), flex: 1, minWidth: 0 },
}));
