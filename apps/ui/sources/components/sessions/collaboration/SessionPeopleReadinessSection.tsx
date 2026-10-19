import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import type { SessionReadinessRepairV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { presentSessionReadiness } from '@/components/sessions/model/sessionReadinessPresentation';
import { useSessionReadiness } from '@/components/sessions/model/useSessionReadiness';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { PaneSectionHeader } from '@/components/ui/lists/PaneSectionHeader';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * Both repairs need a person to finish them (a sign-in terminal, an OAuth or device step), so the
 * button opens the page that runs that exact Action with its continuation, rather than starting an
 * attempt nobody here could complete.
 */
function useOpenSessionReadinessRepair() {
  const router = useRouter();
  return React.useCallback(
    (repair: SessionReadinessRepairV1) => {
      if (repair.actionId === 'machines.agents.signIn.start') {
        router.push({
          pathname: '/(app)/settings/agents/[agentId]',
          params: {
            agentId: repair.input.agentId,
            machineId: repair.input.machineId,
          },
        } as never);
        return;
      }
      router.push({ pathname: '/(app)/settings/connected-services' } as never);
    },
    [router],
  );
}

/**
 * Configured vs ready for this Session (C7, lab K3-R), in the People pane beside who follows it. The
 * pane being open is the demand: one status read, an explicit Check again, no polling. Healthy is one
 * quiet line; a cause speaks once with its repair, or says who can fix it.
 */
export const SessionPeopleReadinessSection = React.memo(function SessionPeopleReadinessSection(props: Readonly<{
  scope: ServerAccountScope;
  sessionId: string;
}>) {
  const serverIds = React.useMemo(() => [props.scope.serverId], [props.scope.serverId]);
  const bindings = useServerCredentialAccountScopeBindings(serverIds);
  const binding = [...bindings.values()][0] ?? null;
  // Only the exact Account this pane reads as; another Account's binding never answers for it.
  if (!binding || !areServerAccountScopesEqual(binding.scope, props.scope)) return null;
  return <SessionPeopleReadinessRows accountLifetime={binding} sessionId={props.sessionId} />;
});

function SessionPeopleReadinessRows(
  props: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    sessionId: string;
  }>,
) {
  const { theme } = useUnistyles();
  const state = useSessionReadiness({
    accountLifetime: props.accountLifetime,
    sessionId: props.sessionId,
    enabled: true,
  });
  const presentation = presentSessionReadiness({
    readiness: state.readiness,
    repair: state.repair,
    demanded: true,
    loading: state.loading,
    unavailableReason: state.unavailableReason,
  });
  const openRepair = useOpenSessionReadinessRepair();
  const { refresh } = state;
  const checkAgain = React.useCallback(
    () => fireAndForget(refresh(), { tag: 'SessionPeopleReadiness.refresh' }),
    [refresh],
  );
  const subtitle =
    joinHappierFacts(presentation.cause, presentation.guidance) || undefined;
  const failed =
    !state.readiness && !state.loading && state.unavailableReason !== null;
  const repair = presentation.repair;
  return (
    <View testID="session-people-readiness" style={styles.section}>
      <PaneSectionHeader title={t('session.collaboration.readiness.title')} />
      <Item
        testID="session-people-readiness-row"
        density="compact"
        showDivider={false}
        showChevron={false}
        icon={
          <Icon name="robot" size={18} color={theme.colors.text.secondary} />
        }
        title={presentation.title}
        subtitle={subtitle}
        subtitleLines={2}
        subtitleStyle={
          presentation.tone === 'attention' ? styles.attention : undefined
        }
        loading={state.loading && !state.readiness}
        accessibilityLiveRegion="polite"
        rightElement={
          repair ? (
            <RoundButton
              testID="session-people-readiness-repair"
              size="small"
              display="secondary"
              title={repair.label}
              onPress={() => openRepair(repair.repair)}
            />
          ) : failed ? (
            <RoundButton
              testID="session-people-readiness-retry"
              size="small"
              display="secondary"
              title={t('common.retry')}
              onPress={checkAgain}
            />
          ) : undefined
        }
        onPress={state.loading ? undefined : checkAgain}
        accessibilityHint={t('session.collaboration.readiness.check')}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { paddingTop: theme.space.s12 },
  attention: { color: theme.colors.state.warning.foreground },
}));
