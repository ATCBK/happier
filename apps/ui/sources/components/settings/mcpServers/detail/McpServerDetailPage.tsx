import * as React from 'react';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { PageLeaveActions } from '@/components/ui/layout/PageLeaveActions';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import { McpServerConfigurationSection, type McpConfigurationSaveState } from '../McpServerConfigureForm';
import { mcpServerMissingKeyNames } from '../status/mcpServerStatus';
import { mcpServerDisplayName } from '../collection/mcpServerCollectionModel';
import { McpServerMark } from '../identity/McpServerMark';
import { McpServerMachineDifferences } from './McpServerMachineDifferences';
import {
  McpServerBanner,
  McpServerMachinesAndDetails,
  McpServerWhereAndTools,
  useMcpServerDetail,
} from './McpServerDetailBody';

/**
 * A saved MCP server (md A order): who it is, the one thing blocking it, Where it's on, its Tools, its
 * Configuration, what it looks like on each machine, the Details, and the way out.
 */
export const McpServerDetailPage = React.memo(function McpServerDetailPage(
  props: Readonly<{
    server: McpServerCatalogEntryV1;
    draftServer: McpServerCatalogEntryV1;
    catalogRevision: number | 'absent' | null;
    secrets: SavedSecret[];
    scope: AccountSettingsScope | null | undefined;
    /** A Configuration value was committed (blur, a type or secret chosen): save it now. */
    onCommitConfiguration: () => void;
    configurationSaveState: McpConfigurationSaveState;
    onRemove: () => void;
    approvalNotice: React.ReactNode;
    onChangeServer: (
      updater: (current: McpServerCatalogEntryV1) => McpServerCatalogEntryV1,
    ) => void;
  }>,
) {
  const { server } = props;
  const savedSecretIds = React.useMemo(
    () => new Set(props.secrets.map((secret) => secret.id)),
    [props.secrets],
  );
  const detail = useMcpServerDetail(
    server,
    props.catalogRevision,
    savedSecretIds,
  );
  const missingKeys = React.useMemo(
    () => mcpServerMissingKeyNames(server, savedSecretIds),
    [savedSecretIds, server],
  );
  const name = mcpServerDisplayName(server);
  const list = detail.tools.list;
  const toolCount =
    list?.snapshot?.tools.length ?? server.toolsSnapshot?.tools.length;
  const facts = React.useMemo(
    () => ({
      source:
        server.origin?.kind === 'registry'
          ? {
              kind: 'registry' as const,
              label: server.origin.provenance.sourceId,
            }
          : server.origin?.kind === 'machine'
            ? {
                kind: 'machine' as const,
                machineName: detail.names.machineName(server.origin.machineId),
              }
            : { kind: 'you' as const },
      extra: [
        server.transport === 'stdio'
          ? t('capabilities.mcp.local')
          : t('capabilities.mcp.remote'),
      ],
      ...(toolCount !== undefined
        ? {
            cost: {
              toolCount,
              ...(list?.tokens != null ? { tokensPerTurn: list.tokens } : {}),
            },
          }
        : {}),
    }),
    [detail.names, list?.tokens, server.origin, server.transport, toolCount],
  );
  const registryId =
    server.origin?.kind === 'registry'
      ? server.origin.provenance.itemId
      : undefined;

  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <CapabilityDetailHeader
        testID="mcp.server.editor.header"
        mark={<McpServerMark transport={server.transport} size={28} />}
        title={name}
        purpose={server.description}
        facts={facts}
        mono={registryId}
      />
      {props.approvalNotice}
      <McpServerBanner detail={detail} name={name} toolCount={toolCount} />
      <McpServerWhereAndTools detail={detail} />
      <McpServerConfigurationSection
        title={t('capabilities.mcp.detail.configurationTitle')}
        description={t('capabilities.mcp.detail.configurationDescription')}
        draftServer={props.draftServer}
        secrets={props.secrets}
        scope={props.scope}
        mode="edit"
        onCommit={props.onCommitConfiguration}
        saveState={props.configurationSaveState}
        attentionKeys={missingKeys}
        onChangeServer={props.onChangeServer}
      />
      <McpServerMachineDifferences
        server={props.draftServer}
        machineName={detail.names.machineName}
        onChangeServer={props.onChangeServer}
        onCommit={props.onCommitConfiguration}
      />
      <McpServerMachinesAndDetails detail={detail} server={server} />
      <PageLeaveActions
        testID="mcp.server.leave"
        footnote={t('capabilities.mcp.detail.removeFootnote')}
        actions={[
          {
            testID: 'mcp.server.editor.remove',
            display: 'bordered',
            icon: 'trash',
            label: t('capabilities.mcp.detail.removeServer'),
            onPress: props.onRemove,
          },
        ]}
      />
    </ItemList>
  );
});
