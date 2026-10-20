import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueRefRowsEditor } from '@/components/ui/forms/valueRefs/ValueRefRowsEditor';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

import type { useMcpServerUpdate } from './useMcpServerUpdate';

type Update = ReturnType<typeof useMcpServerUpdate>;
type Ready = Extract<Update['review'], { status: 'ready' }>;

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

/** How the entry starts or is reached, as one line the person can compare. */
function launchLine(entry: McpServerCatalogEntryV1): string {
  return entry.transport === 'stdio'
    ? [entry.stdio?.command ?? '', ...(entry.stdio?.args ?? [])]
        .filter(Boolean)
        .join(' ')
    : (entry.remote?.url ?? '');
}

const seed = (secret: boolean): ValueRefV1 =>
  secret ? { t: 'savedSecret', secretId: '' } : { t: 'literal', v: '' };

/**
 * "Updates" for a server added from a registry: where its upstream stands (one Check now), and for a
 * newer version a Review that shows what changes and asks for any value the new version needs before
 * Update. Name, values, tools and reach stay with the server; nothing here is stored.
 */
export const McpServerUpdateSection = React.memo(
  function McpServerUpdateSection(
    props: Readonly<{
      testID: string;
      update: Update;
      secrets: SavedSecret[];
      scope: AccountSettingsScope | null;
    }>,
  ) {
    const { theme } = useUnistyles();
    const { update } = props;
    const { check, review, applyState } = update;
    const upstream = check.upstream;
    const available =
      upstream?.state === 'update_available' &&
      upstream.latest?.kind === 'version'
        ? upstream.latest.version
        : null;
    const reviewing =
      review.status === 'ready' && !update.staleReview ? review : null;
    const words = check.failed
      ? t('capabilities.mcp.detail.update.checkFailed')
      : upstream?.state === 'update_available' && available
        ? t('capabilities.mcp.detail.update.available', { version: available })
        : upstream?.state === 'removed_from_source'
          ? t('capabilities.mcp.detail.update.removed')
          : upstream?.state === 'current'
            ? t('capabilities.mcp.detail.update.upToDate')
            : t('capabilities.mcp.detail.notChecked');
    const subtitle =
      check.checkedAt && !check.failed
        ? `${words} · ${t('capabilities.mcp.detail.checked', { time: formatTime(check.checkedAt) })}`
        : words;
    const loading = review.status === 'loading';

    return (
      <ItemGroup testID={props.testID} header="none">
        <Item
          testID={`${props.testID}.status`}
          title={t('capabilities.mcp.detail.update.title')}
          subtitle={subtitle}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={
            available && !reviewing ? (
              <RoundButton
                testID={`${props.testID}.review`}
                size="small"
                display="secondary"
                title={t('capabilities.mcp.detail.update.review')}
                loading={loading}
                disabled={loading}
                onPress={() => void update.loadReview()}
              />
            ) : (
              <RoundButton
                testID={`${props.testID}.checkNow`}
                size="small"
                display="secondary"
                title={t('capabilities.mcp.detail.update.checkNow')}
                loading={check.checking}
                disabled={check.checking}
                onPress={() => void update.checkNow()}
              />
            )
          }
        />
        {review.status === 'failed' ? (
          <SectionContentRow>
            <Text
              variant="meta"
              style={{ color: theme.colors.status.error }}
              testID={`${props.testID}.readFailed`}
            >
              {t('capabilities.mcp.detail.update.readFailed')}
            </Text>
          </SectionContentRow>
        ) : null}
        {reviewing ? (
          <UpdateReview
            testID={`${props.testID}.review.panel`}
            review={reviewing}
            update={update}
            secrets={props.secrets}
            scope={props.scope}
            applyFailed={applyState.status === 'failed'}
            applying={applyState.status === 'applying'}
          />
        ) : null}
      </ItemGroup>
    );
  },
);

function UpdateReview(
  props: Readonly<{
    testID: string;
    review: Ready;
    update: Update;
    secrets: SavedSecret[];
    scope: AccountSettingsScope | null;
    applyFailed: boolean;
    applying: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { review, update } = props;
  const secretOf = (key: string) =>
    review.inputs.find((input) => input.name === key)?.secret ?? false;
  const ask = (target: 'env' | 'header') =>
    review.missingValues.filter((item) => item.target === target);
  const rows = (target: 'env' | 'header') =>
    Object.fromEntries(
      ask(target).map((item): [string, ValueRefV1] => [
        item.key,
        update.values[item.key] ?? seed(secretOf(item.key)),
      ]),
    );
  const change =
    (target: 'env' | 'header') => (next: Record<string, ValueRefV1>) => {
      for (const item of ask(target)) {
        const value = next[item.key];
        if (value && value !== update.values[item.key])
          update.setValue(item.key, value);
      }
    };
  const attention = (target: 'env' | 'header') =>
    new Set(
      ask(target)
        .filter((item) => {
          const value = update.values[item.key] ?? seed(secretOf(item.key));
          return value.t === 'literal'
            ? value.v.trim().length === 0
            : value.t === 'savedSecret' && value.secretId.length === 0;
        })
        .map((item) => item.key),
    );
  const plain = review.missingValues.filter(
    (item) => item.target !== 'env' && item.target !== 'header',
  );
  const version = review.pointer.version;
  const before = launchLine(review.before);
  const after = review.after ? launchLine(review.after) : '';

  return (
    <SectionContentRow>
      <View style={styles.review} testID={props.testID}>
        <View style={styles.head}>
          <Text variant="label" style={{ color: theme.colors.text.primary }}>
            {t('capabilities.mcp.detail.update.changesTitle', { version })}
          </Text>
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {t('capabilities.mcp.detail.update.changesBody')}
          </Text>
        </View>
        {before !== after && after ? (
          <View style={styles.compare}>
            <View style={styles.line}>
              <Text
                variant="meta"
                style={[
                  styles.lineLabel,
                  { color: theme.colors.text.secondary },
                ]}
              >
                {t('capabilities.mcp.detail.update.now')}
              </Text>
              <Text
                variant="meta"
                style={[styles.mono, { color: theme.colors.text.secondary }]}
                selectable
              >
                {before}
              </Text>
            </View>
            <View style={styles.line}>
              <Text
                variant="meta"
                style={[
                  styles.lineLabel,
                  { color: theme.colors.text.secondary },
                ]}
              >
                {t('capabilities.mcp.detail.update.after')}
              </Text>
              <Text
                variant="meta"
                style={[styles.mono, { color: theme.colors.text.primary }]}
                selectable
              >
                {after}
              </Text>
            </View>
          </View>
        ) : null}
        {review.missingValues.length > 0 ? (
          <View style={styles.needs}>
            <Text variant="label" style={{ color: theme.colors.text.primary }}>
              {t('capabilities.mcpAdd.detail.needsTitle')}
            </Text>
            {ask('env').length > 0 ? (
              <ValueRefRowsEditor
                kind="env"
                declaredNames
                entries={rows('env')}
                onChangeEntries={change('env')}
                secrets={props.secrets}
                scope={props.scope}
                testIdPrefix={`${props.testID}.env`}
                attentionKeys={attention('env')}
              />
            ) : null}
            {ask('header').length > 0 ? (
              <ValueRefRowsEditor
                kind="header"
                declaredNames
                entries={rows('header')}
                onChangeEntries={change('header')}
                secrets={props.secrets}
                scope={props.scope}
                testIdPrefix={`${props.testID}.header`}
                attentionKeys={attention('header')}
              />
            ) : null}
            {plain.map((item) => {
              const value = update.values[item.key];
              return (
                <View key={item.key} style={styles.field}>
                  <Text
                    variant="meta"
                    style={{ color: theme.colors.text.secondary }}
                  >
                    {item.key}
                  </Text>
                  <FieldTextInput
                    testID={`${props.testID}.field.${item.key}`}
                    value={value?.t === 'literal' ? value.v : ''}
                    onChangeText={(next) =>
                      update.setValue(item.key, { t: 'literal', v: next })
                    }
                    accessibilityLabel={item.key}
                    invalid={
                      !value ||
                      (value.t === 'literal' && value.v.trim().length === 0)
                    }
                    monospace
                  />
                </View>
              );
            })}
          </View>
        ) : null}
        <View style={styles.footer}>
          <Text
            variant="meta"
            style={[styles.note, { color: theme.colors.status.error }]}
            testID={`${props.testID}.note`}
          >
            {props.applyFailed
              ? t('capabilities.mcp.detail.update.applyFailed')
              : ''}
          </Text>
          <RoundButton
            testID={`${props.testID}.apply`}
            size="small"
            title={t('capabilities.mcp.detail.update.apply')}
            loading={props.applying}
            disabled={!update.canApply}
            onPress={() => void update.apply()}
          />
        </View>
      </View>
    </SectionContentRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  review: { gap: theme.space.s12, minWidth: 0 },
  head: { gap: theme.space.s4 },
  compare: { gap: theme.space.s4 },
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s8,
    minWidth: 0,
  },
  lineLabel: { width: 96, flexShrink: 0 },
  mono: { ...Typography.mono(), flexShrink: 1, minWidth: 0 },
  needs: { gap: theme.space.s8 },
  field: { gap: theme.space.s4 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s12,
  },
  note: { flexShrink: 1, minHeight: 18 },
}));
