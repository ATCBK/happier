import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { t } from '@/text';

import { mcpServerConflictFields } from './mcpServerConflictFields';

export type McpServerConflict = Readonly<{
  phase: 'detected' | 'reviewing';
  currentServer: McpServerCatalogEntryV1 | null;
  onReview: () => Promise<void>;
  /** Take what is saved now and drop the open edit (a removed server closes the page). */
  onUseCurrent: () => void;
  /** Save the open version over the reviewed current one. */
  onKeepMine: () => void;
}>;

/**
 * "Changed elsewhere · Review" (P7 F11/F17): the open edit met another writer's change. The page keeps
 * the person's version untouched and says so in one warning line; Review lays the saved values next to
 * theirs, and they keep their own or take the current. Nothing is written until they choose.
 */
export const McpServerConflictReview = React.memo(function McpServerConflictReview(props: Readonly<{
  conflict: McpServerConflict;
  draftServer: McpServerCatalogEntryV1;
  secrets: readonly SavedSecret[];
}>) {
  const { conflict, draftServer, secrets } = props;
  const reviewing = conflict.phase === 'reviewing';
  const fields = React.useMemo(() => (conflict.currentServer
    ? mcpServerConflictFields(
        conflict.currentServer,
        draftServer,
        (id) => secrets.find((secret) => secret.id === id)?.name ?? null,
      )
    : []), [conflict.currentServer, draftServer, secrets]);

  return (
    <>
      <View testID="mcp.server.conflict" style={styles.line}>
        <SurfaceFreshnessLine
          testID="mcp.server.conflict.line"
          tone="warning"
          reason={conflict.currentServer
            ? t('capabilities.mcp.detail.conflict.reason')
            : t('capabilities.mcp.detail.conflict.removedTitle')}
          action={reviewing ? undefined : {
            label: t('capabilities.mcp.detail.conflict.review'),
            onPress: () => { void conflict.onReview(); },
          }}
        />
      </View>
      {reviewing && !conflict.currentServer ? (
        <ItemGroup
          testID="mcp.server.conflict.removed"
          title={t('capabilities.mcp.detail.conflict.removedTitle')}
        >
          <Item
            title={t('capabilities.mcp.detail.conflict.removedDescription')}
            accessoryLayout="adaptive"
            showChevron={false}
            showDivider={false}
            rightElement={(
              <RoundButton
                testID="mcp.server.conflict.discard"
                size="small"
                display="default"
                title={t('capabilities.mcp.detail.conflict.discard')}
                onPress={conflict.onUseCurrent}
              />
            )}
          />
        </ItemGroup>
      ) : null}
      {reviewing && conflict.currentServer ? (
        <ItemGroup
          testID="mcp.server.conflict.review"
          title={t('capabilities.mcp.detail.conflict.title')}
          description={t('capabilities.mcp.detail.conflict.description')}
        >
          {fields.map((field) => (
            <Item
              key={field.id}
              testID={`mcp.server.conflict.field.${field.id}`}
              title={field.label}
              accessoryLayout="stacked"
              showChevron={false}
              rightElement={(
                <View style={styles.values}>
                  <View style={styles.value}>
                    <Text variant="meta" style={styles.valueLabel}>{t('capabilities.mcp.detail.conflict.current')}</Text>
                    <Text style={[styles.valueText, field.mono ? styles.mono : null]} selectable>{field.current}</Text>
                  </View>
                  <View style={styles.value}>
                    <Text variant="meta" style={styles.valueLabel}>{t('capabilities.mcp.detail.conflict.yours')}</Text>
                    <Text style={[styles.valueText, field.mono ? styles.mono : null]} selectable>{field.mine}</Text>
                  </View>
                </View>
              )}
            />
          ))}
          <SectionContentRow showDivider={fields.length > 0}>
            <View style={styles.actions}>
              <RoundButton
                testID="mcp.server.conflict.useCurrent"
                size="small"
                display="secondary"
                title={t('capabilities.mcp.detail.conflict.useCurrent')}
                onPress={conflict.onUseCurrent}
              />
              <RoundButton
                testID="mcp.server.conflict.keepMine"
                size="small"
                display="default"
                title={t('capabilities.mcp.detail.conflict.keepMine')}
                onPress={conflict.onKeepMine}
              />
            </View>
          </SectionContentRow>
        </ItemGroup>
      ) : null}
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  line: { marginBottom: theme.space.s8 },
  values: { gap: theme.space.s6, alignSelf: 'stretch' },
  value: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s12 },
  valueLabel: { width: 64, color: theme.colors.text.tertiary },
  valueText: { flex: 1, color: theme.colors.text.primary },
  mono: { ...Typography.mono() },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.space.s8 },
}));
