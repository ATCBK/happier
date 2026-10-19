import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
  McpServerCatalogEntryV1,
  McpServerConfigOverrideFieldsV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';
import { applyMcpServerConfigOverrideV1 } from '@happier-dev/protocol/mcp/servers/resolveMcpServerConfigForContextV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { CustomModalInjectedProps } from '@/modal';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import { McpServerConfigurationSection } from '../McpServerConfigurationSection';
import { diffMcpServerConfigOverride } from './mcpMachineOverride';

/**
 * One machine's values for a server (T5 "Different on a machine…"): the same Configuration rows the
 * server page uses, showing what this machine runs, so a difference is an edit of a value rather than a
 * second way to describe one. Save stores only what differs from the server's own configuration.
 */
export function McpMachineDifferenceEditorModal(
  props: CustomModalInjectedProps &
    Readonly<{
      /** The server with its own (all machines) configuration. */
      server: McpServerCatalogEntryV1;
      /** This machine's current difference, if it already has one. */
      current: McpServerConfigOverrideFieldsV1 | undefined;
      secrets: SavedSecret[];
      scope: AccountSettingsScope | null | undefined;
      onSubmit: (next: McpServerConfigOverrideFieldsV1 | undefined) => void;
    }>,
) {
  const { server, current, onClose, onSubmit } = props;
  const [effective, setEffective] = React.useState(() =>
    applyMcpServerConfigOverrideV1(server, current),
  );
  const save = React.useCallback(() => {
    onSubmit(diffMcpServerConfigOverride(server, effective));
    onClose();
  }, [effective, onClose, onSubmit, server]);

  return (
    <ItemList
      presentation="grouped"
      style={styles.list}
      keyboardShouldPersistTaps="handled"
    >
      <McpServerConfigurationSection
        draftServer={effective}
        secrets={props.secrets}
        scope={props.scope}
        mode="machine"
        title={t('capabilities.mcp.detail.configurationTitle')}
        onChangeServer={setEffective}
      />
      <View style={styles.footer}>
        <RoundButton
          testID="mcp.server.differences.cancel"
          size="normal"
          display="secondary"
          title={t('common.cancel')}
          onPress={onClose}
        />
        <RoundButton
          testID="mcp.server.differences.save"
          size="normal"
          title={t('common.save')}
          onPress={save}
        />
      </View>
    </ItemList>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { paddingTop: 0 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s16,
  },
}));
