import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { presentSessionReadiness } from '@/components/sessions/model/sessionReadinessPresentation';
import { useSessionReadiness } from '@/components/sessions/model/useSessionReadiness';
import { SessionReadinessChecklist } from '@/components/sessions/readiness/SessionReadinessChecklist';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { PaneSectionHeader } from '@/components/ui/lists/PaneSectionHeader';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

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
  const { refresh } = state;
  const checkAgain = React.useCallback(
    () => fireAndForget(refresh(), { tag: 'SessionPeopleReadiness.refresh' }),
    [refresh],
  );
  const failed =
    !state.readiness && !state.loading && state.unavailableReason !== null;
  // Healthy stays one quiet line; anything short of ready opens into its prerequisites.
  const checklist = state.readiness && presentation.tone !== 'ready' ? (
    <SessionReadinessChecklist
      readiness={state.readiness}
      presentation={presentation}
      scope={props.accountLifetime.scope}
      sessionId={props.sessionId}
    />
  ) : undefined;
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
        subtitle={presentation.cause ?? undefined}
        subtitleLines={2}
        subtitleStyle={
          presentation.tone === 'attention' ? styles.attention : undefined
        }
        loading={state.loading && !state.readiness}
        accessibilityLiveRegion="polite"
        bottomElement={checklist}
        bottomElementInset="text"
        rightElement={
          failed ? (
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
