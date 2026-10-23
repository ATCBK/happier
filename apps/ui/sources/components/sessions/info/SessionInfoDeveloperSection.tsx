import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  buildSessionDebugInformation,
  isSessionDebugInformationEnabled,
  resolveProviderSessionArtifactPath,
  resolveProviderSessionIdForDebug,
} from '@/components/sessions/debug/sessionDebugInformation';
import { stringifySessionDebugJson } from '@/components/sessions/debug/sessionDebugRedaction';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CodeView } from '@/components/ui/media/CodeView';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useLocalSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { t } from '@/text';
import {
  formatPathRelativeToHome,
  type SessionStatus,
} from '@/utils/sessions/sessionUtils';

type RawJsonSectionId = 'agentState' | 'metadata' | 'sessionStatus' | 'session';
type RawJsonSnapshot = Readonly<{ section: RawJsonSectionId; code: string }>;

/**
 * Developer (developer mode only): raw records for debugging. A JSON view is serialized and redacted
 * only when it is opened, and stays as it was until reopened, so live arrivals never re-stringify it.
 */
export const SessionInfoDeveloperSection = React.memo(
  function SessionInfoDeveloperSection(
    props: Readonly<{
      session: Session;
      metadata: ReturnType<typeof readSessionOwnerMetadataView>;
      serverId: string;
      providerDisplayName: string;
      vendorResumeIdField: Parameters<typeof resolveProviderSessionIdForDebug>[0]['vendorResumeIdField'];
      status: SessionStatus;
    }>,
  ) {
    const localDevModeEnabled = useLocalSetting('devModeEnabled');
    if (!isSessionDebugInformationEnabled(localDevModeEnabled)) return null;
    return <SessionInfoDeveloperContent {...props} />;
  },
);

function SessionInfoDeveloperContent(
  props: Readonly<{
    session: Session;
    metadata: ReturnType<typeof readSessionOwnerMetadataView>;
    serverId: string;
    providerDisplayName: string;
    vendorResumeIdField: Parameters<typeof resolveProviderSessionIdForDebug>[0]['vendorResumeIdField'];
    status: SessionStatus;
  }>,
) {
  const router = useRouter();
  const { session, metadata } = props;
  const [expanded, setExpanded] = React.useState<RawJsonSnapshot | null>(null);
  const providerSessionArtifactPath =
    resolveProviderSessionArtifactPath(metadata);
  const buildCode = (section: RawJsonSectionId) => {
    switch (section) {
      case 'agentState':
        return stringifySessionDebugJson(session.agentState);
      case 'metadata':
        return stringifySessionDebugJson(metadata);
      case 'sessionStatus':
        return stringifySessionDebugJson({
          isConnected: props.status.isConnected,
          statusText: props.status.statusText,
          statusColor: props.status.statusColor,
          statusDotColor: props.status.statusDotColor,
          isPulsing: props.status.isPulsing,
        });
      case 'session':
        return stringifySessionDebugJson(session);
    }
  };
  const toggle = (section: RawJsonSectionId) =>
    setExpanded((current) =>
      current?.section === section
        ? null
        : { section, code: buildCode(section) },
    );
  const debugText = React.useMemo(
    () =>
      buildSessionDebugInformation({
        session,
        providerDisplayName: props.providerDisplayName,
        providerSessionId: resolveProviderSessionIdForDebug({
          metadata,
          vendorResumeIdField: props.vendorResumeIdField,
        }),
      }).text,
    [metadata, props.providerDisplayName, props.vendorResumeIdField, session],
  );
  const jsonRow = (section: RawJsonSectionId, title: string) => (
    <React.Fragment key={section}>
      <Item
        title={title}
        accessibilityExpanded={expanded?.section === section}
        onPress={() => toggle(section)}
      />
      {expanded?.section === section ? (
        <View style={styles.code}>
          <CodeView code={expanded.code} language="json" />
        </View>
      ) : null}
    </React.Fragment>
  );

  return (
    <ItemGroup
      testID="session-info-developer"
      title={t('sessionPages.info.developerTitle')}
      description={t('sessionPages.info.developerDescription')}
    >
      <Item
        title={t('sessionInfo.thinking')}
        detail={
          session.thinking
            ? `${t('common.yes')} · ${new Date(session.thinkingAt).toLocaleTimeString()}`
            : t('common.no')
        }
        showChevron={false}
      />
      {providerSessionArtifactPath ? (
        <Item
          title={t('sessionInfo.providerSessionLogs', {
            provider: props.providerDisplayName,
          })}
          detail={formatPathRelativeToHome(
            providerSessionArtifactPath,
            metadata?.homeDir,
          )}
          detailStyle={styles.mono}
          copy={providerSessionArtifactPath}
          showChevron={false}
        />
      ) : null}
      <Item
        testID="session-info-session-log"
        title={t('sessionLog.logPathCopyLabel')}
        detail={t('sessionPages.info.view')}
        onPress={() =>
          router.push(
            buildScopedSessionRouteHref({
              sessionId: session.id,
              serverId: props.serverId,
              suffix: '/log',
            }) as never,
          )
        }
      />
      {session.agentState
        ? jsonRow('agentState', t('sessionInfo.agentState'))
        : null}
      {metadata ? jsonRow('metadata', t('sessionInfo.metadata')) : null}
      {jsonRow('sessionStatus', t('sessionInfo.sessionStatus'))}
      {jsonRow('session', t('sessionInfo.fullSessionObject'))}
      <Item
        testID="session-info-copy-debug-information"
        title={t('sessionInfo.copyDebugInformation')}
        copy={debugText}
        showChevron={false}
      />
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  code: {
    marginHorizontal: theme.space.s16,
    marginBottom: theme.space.s12,
  },
  mono: {
    ...Typography.mono(),
  },
}));
