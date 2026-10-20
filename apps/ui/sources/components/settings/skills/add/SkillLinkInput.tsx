import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { useAddDialogEdge, type CapabilityAddInputContext } from '@/components/capabilities/add/CapabilityAddModal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';
import { t } from '@/text';

import { previewRef } from './SkillPreviewRows';
import { previewSkillInstall, type SkillInstallSource } from './skillInstall';
import { SkillFoundAdd } from './SkillFoundAdd';

/**
 * From a link (lab sa L): paste a repository or folder in the tools band, look (`skills.install` dry run, nothing
 * written), then the skills found as a checklist in the dialog's list + details: tick several and add them in one
 * call, or open one to see what it installs and choose where it's on.
 */
export function SkillLinkInput(
  props: Readonly<{
    ctx: CapabilityAddInputContext;
    execute: MountedAuthoringActionExecute;
    onAdded: (skillId: string) => void;
    /** A detail's Add closed the dialog: the page selects that skill. */
    onSelectAdded: (skillId: string) => void;
    /** Closes the dialog (the footer's Done when everything found is already held). */
    onDone: () => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const edge = useAddDialogEdge();
  const [url, setUrl] = React.useState('');
  const [state, setState] = React.useState<
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'finding' }>
    | Readonly<{ kind: 'found'; url: string; source: SkillInstallSource; items: readonly SkillInstallPreviewV1[] }>
    | Readonly<{ kind: 'error'; message: string }>
  >({ kind: 'idle' });

  const find = React.useCallback(async () => {
    const link = url.trim().replace(/^npx\s+skills\s+add\s+/, '');
    if (!/^https:\/\/\S+$/.test(link)) {
      setState({ kind: 'error', message: t('capabilities.skillAdd.link.invalid') });
      return;
    }
    props.ctx.openDetail(null);
    setState({ kind: 'finding' });
    const preview = await previewSkillInstall(props.execute, { kind: 'link', url: link });
    if (!preview.ok) {
      setState({
        kind: 'error',
        message: preview.status ? describeRegistrySourceStatus(preview.status) : t('capabilities.skillAdd.link.failed'),
      });
      return;
    }
    setState({ kind: 'found', url: link, source: preview.source, items: preview.items });
  }, [props.ctx, props.execute, url]);

  const found = state.kind === 'found' ? state : null;
  const pin = found?.items[0] ? previewRef(found.items[0]) : undefined;
  const field = (
    <View style={styles.fieldRow}>
      <View style={styles.field}>
        <FieldTextInput
          testID={`${props.testID}.url`}
          value={url}
          onChangeText={(next) => {
            setUrl(next);
            if (state.kind === 'error') setState({ kind: 'idle' });
          }}
          placeholder={t('capabilities.skillAdd.link.placeholder')}
          accessibilityLabel={t('capabilities.skillAdd.link.title')}
          autoCapitalize="none"
          autoFocus
          monospace
          inputMode="url"
          returnKeyType="go"
          onSubmitEditing={() => void find()}
          error={state.kind === 'error' ? state.message : null}
        />
      </View>
      <RoundButton
        size="normal"
        display="secondary"
        title={t('capabilities.skillAdd.link.find')}
        loading={state.kind === 'finding'}
        disabled={url.trim() === ''}
        onPress={() => void find()}
        testID={`${props.testID}.find`}
      />
    </View>
  );
  return (
    <SkillFoundAdd
      // A new find is a new set to choose from: its ticks, adds and details start over.
      key={found?.url ?? ''}
      ctx={props.ctx}
      execute={props.execute}
      source={found?.source ?? null}
      items={found?.items ?? null}
      groupTitle={t('capabilities.skillAdd.link.chooseWhich')}
      field={field}
      empty={
        <View style={[styles.empty, edge]}>
          <Text variant="reading" style={{ color: theme.colors.text.secondary }} testID={`${props.testID}.body`}>
            {found ? t('capabilities.skillAdd.link.none') : t('capabilities.skillAdd.link.body')}
          </Text>
        </View>
      }
      factsSource={(item) => ({ kind: 'git', label: item.path || '/', ...(previewRef(item) ? { ref: previewRef(item)! } : {}) })}
      note={
        pin ? (
          <>
            <Icon name="push-pin" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text variant="meta" numberOfLines={1} style={styles.noteText}>
              {`${t('capabilities.skillAdd.pinnedTo', { ref: pin })}. ${t('capabilities.skillAdd.link.openOne')}`}
            </Text>
          </>
        ) : null
      }
      detailNote={
        pin ? (
          <>
            <Icon name="push-pin" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text variant="meta" numberOfLines={1} style={styles.noteText}>
              {t('capabilities.skillAdd.pinnedTo', { ref: pin })}
            </Text>
          </>
        ) : null
      }
      onAdded={props.onAdded}
      onSelectAdded={props.onSelectAdded}
      onDone={props.onDone}
      testID={props.testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s12,
  },
  field: { flex: 1, minWidth: 0 },
  empty: { paddingTop: theme.space.s16, paddingBottom: theme.space.s24 },
  noteText: { flexShrink: 1, color: theme.colors.text.secondary },
}));
