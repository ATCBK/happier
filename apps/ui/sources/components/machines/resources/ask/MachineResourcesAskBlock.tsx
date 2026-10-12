import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import {
  HubComposerSuggestionList,
  type HomeComposerSuggestionFill,
} from '@/components/hub/composer/suggestions/HubComposerSuggestions';
import { ComposerBannerCollapseProvider } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';
import { NewSessionScreen } from '@/components/sessions/new/NewSessionScreen';
import { NewSessionEmbeddedHostProvider } from '@/components/sessions/new/navigation/newSessionHost';
import { useNewSessionEmbeddedHostState } from '@/components/sessions/new/navigation/useNewSessionEmbeddedHostState';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useMachineTabFacts } from '@/components/machines/page/useMachineTabFacts';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { Modal } from '@/modal';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { deriveMachineResourceSuggestions } from './machineResourceSuggestions';

/**
 * "Ask an agent" (plan 60 AGW-11, lab `ra` A1/A1b/A1p): the last block of a Resources tab. The real
 * embedded New Session composer, bound to this machine, and three prompts written from what the page
 * shows right now. Pressing a prompt fills the composer; sending opens an ordinary session there.
 * Offline, there is no embedded composer; last-report prompts fill the global New Session draft.
 */
export const MachineResourcesAskBlock = React.memo(
  function MachineResourcesAskBlock(
    props: Readonly<{
      serverId: string;
      machineId: string;
      machineName: string;
    }>,
  ) {
    const router = useRouter();
    const language = usePreferredLanguage();
    const presence = useMachinePresenceSummary(props.serverId, props.machineId);
    const online = presence.reachability === 'reachable';
    const { homeDir } = useMachineTabFacts(props.serverId, props.machineId);
    const summary = useMachineResourceSummary({
      serverId: props.serverId,
      machineId: props.machineId,
    });
    const policy = useMachineResourcesPolicy({
      serverId: props.serverId,
      machineId: props.machineId,
    });
    const reported = summary?.kind === 'reporting' ? summary.summary : null;
    const calm = summary?.kind === 'reporting' && summary.attention?.level === 'calm';
    const guardEnabled = policy.policy
      ? policy.policy.guard?.memoryGuard?.enabled === true
      : null;
    const suggestions = React.useMemo(
      () =>
        deriveMachineResourceSuggestions({
          machine: {
            serverId: props.serverId,
            machineId: props.machineId,
            name: props.machineName,
            directory: homeDir ?? '',
          },
          online,
          ...(reported
            ? {
                calm,
                memoryPressure: reported.memory.pressure,
                disk: {
                  availableBytes: reported.disk.availableBytes,
                  totalBytes: reported.disk.totalBytes,
                  tone: reported.disk.tone,
                },
              }
            : {}),
          guardEnabled,
          automationsEnabled: true,
        }),
      [
      language,
        calm,
        guardEnabled,
        homeDir,
        props.machineId,
        props.machineName,
        online,
        props.serverId,
        reported,
      ],
    );
    const lastReportSuggestions = React.useMemo(
      // Notify me currently delivers immediately; it cannot register a machine-return notification.
      // Do not offer that operation as a composer fill or an inert notification tile.
      () => suggestions.filter((suggestion) => suggestion.kind !== 'notifyWhenBack'),
      [suggestions],
    );
    const fillGlobalComposer = React.useCallback((suggestion: HomeComposerSuggestionFill) => {
      const lifetime = captureActiveServerAccountScopeLifetime();
      const outcome = lifetime && seedAndOpenNewSession({
        seed: { prompt: suggestion.prompt },
        scope: lifetime.scope,
        isCurrent: lifetime.isCurrent,
        navigateToNewSession: ({ draftId }) => router.push({
          pathname: '/new',
          params: { draftId, draftServerId: lifetime.scope.serverId, draftAccountId: lifetime.scope.accountId },
        }),
      });
      if (!outcome || outcome.kind !== 'opened') {
        Modal.alert(t('common.error'), t('errors.operationFailed'));
      }
    }, [router]);

    return (
      <ItemGroup
        surface="none"
        title={t('machineResources.ask.title')}
        description={
          online
            ? t('machineResources.ask.description')
            : t('machineResources.ask.offline', { machine: props.machineName })
        }
      >
        <View testID="machine-resources-ask" style={styles.stack}>
          {online ? (
            <AskComposer
              key={`${props.serverId}:${props.machineId}`}
              serverId={props.serverId}
              machineId={props.machineId}
              machineName={props.machineName}
              directory={homeDir}
              suggestions={suggestions}
            />
          ) : (
            <HubComposerSuggestionList
              suggestions={lastReportSuggestions}
              onFill={fillGlobalComposer}
            />
          )}
        </View>
      </ItemGroup>
    );
  },
);

/** The composer is bound to this machine: the draft's placement starts here, and prompts fill it. */
function AskComposer(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    directory: string | undefined;
    suggestions: ReturnType<typeof deriveMachineResourceSuggestions>;
  }>,
) {
  const initialParams = React.useMemo(() => ({
    spawnServerId: props.serverId,
    machineId: props.machineId,
    ...(props.directory ? { directory: props.directory } : {}),
  }), [props.directory, props.machineId, props.serverId]);
  const { host, markDemanded } = useNewSessionEmbeddedHostState(initialParams);
  const setHostParams = host.setParams;
  const draftId =
    typeof host.params.draftId === 'string'
      ? host.params.draftId
      : `machine-ask:${props.machineId}`;
  const demand = markDemanded;
  const fill = React.useCallback(
    (suggestion: HomeComposerSuggestionFill) => {
      markDemanded();
      setHostParams({
        prompt: suggestion.prompt,
        spawnServerId: suggestion.placement?.serverId ?? props.serverId,
        machineId: suggestion.placement?.machineId ?? props.machineId,
        ...(suggestion.placement?.directory
          ? { directory: suggestion.placement.directory }
          : {}),
      });
    },
    [markDemanded, props.machineId, props.serverId, setHostParams],
  );
  return (
    <>
      <View
        testID="machine-resources-ask.composer"
        onFocus={demand}
        onPointerEnter={demand}
        onTouchStart={demand}
      >
        <NewSessionEmbeddedHostProvider host={host}>
          <ComposerBannerCollapseProvider key={draftId}>
            <NewSessionScreen
              presentation="embedded"
              inputPlaceholder={t('machineResources.ask.placeholder', { machine: props.machineName })}
            />
          </ComposerBannerCollapseProvider>
        </NewSessionEmbeddedHostProvider>
      </View>
      <HubComposerSuggestionList
        suggestions={props.suggestions}
        onFill={fill}
      />
    </>
  );
}

const styles = StyleSheet.create(() => ({
  // A sheetless section (anatomy): the composer is its own card and the prompts their own tiles.
  stack: {
    gap: 12,
  },
}));
