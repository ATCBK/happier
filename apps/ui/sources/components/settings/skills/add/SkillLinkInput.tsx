import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { CapabilityAddFooter, useAddDialogEdge } from '@/components/capabilities/add/CapabilityAddModal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';
import { t } from '@/text';

import { previewRef, SkillPreviewRows } from './SkillPreviewRows';
import { readAllHeldFooter, tickAllSkillPreviews, toggleSkillPreview } from './skillPreviewSelection';
import { installSkills, previewSkillInstall, retrySkillInstallRules, type SkillInstallAcknowledgment } from './skillInstall';

/**
 * From a link (lab sa L): paste a repository or folder, look (`skills.install` dry run, nothing written), tick the
 * skills to add, and add them in one call with `selectPaths`.
 */
export function SkillLinkInput(
  props: Readonly<{
    execute: MountedAuthoringActionExecute;
    onAdded: (skillId: string) => void;
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
    | Readonly<{ kind: 'found'; items: readonly SkillInstallPreviewV1[] }>
    | Readonly<{ kind: 'error'; message: string }>
  >({ kind: 'idle' });
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);
  const [acknowledged, setAcknowledged] = React.useState<SkillInstallAcknowledgment | null>(null);

  const find = React.useCallback(async () => {
    if (acknowledged) return;
    const link = url.trim();
    if (!/^https:\/\/\S+$/.test(link)) {
      setState({
        kind: 'error',
        message: t('capabilities.skillAdd.link.invalid'),
      });
      return;
    }
    setState({ kind: 'finding' });
    const preview = await previewSkillInstall(props.execute, {
      kind: 'link',
      url: link,
    });
    if (!preview.ok) {
      setState({
        kind: 'error',
        message: preview.status
          ? describeRegistrySourceStatus(preview.status)
          : t('capabilities.skillAdd.link.failed'),
      });
      return;
    }
    setState({ kind: 'found', items: preview.items });
    setTicked(tickAllSkillPreviews(preview.items));
  }, [acknowledged, props.execute, url]);

  const add = React.useCallback(async () => {
    if (state.kind !== 'found' || ticked.size === 0) return;
    setAdding(true);
    setAddError(null);
    const outcome = acknowledged ? await retrySkillInstallRules(props.execute, acknowledged) : await installSkills(props.execute, {
      source: { kind: 'link', url: url.trim() },
      selectPaths: state.items
        .filter((item) => ticked.has(item.path))
        .map((item) => item.path),
    });
    setAdding(false);
    if (!outcome.ok) {
      setAddError(outcome.status ? describeRegistrySourceStatus(outcome.status) : t('capabilities.add.addFailed'));
      return;
    }
    setAcknowledged(outcome);
    if (outcome.incomplete.length > 0) {
      setAddError(t('capabilities.skillAdd.partial.rules'));
      return;
    }
    props.onAdded(outcome.skillIds[0]!);
  }, [acknowledged, props, state, ticked, url]);

  const found = state.kind === 'found' ? state.items : null;
  const allHeld = found ? readAllHeldFooter(found) : null;
  return (
    <View style={styles.fill}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.body, edge]}
        keyboardShouldPersistTaps="handled"
      >
        <Text variant="reading" style={{ color: theme.colors.text.secondary }}>
          {t('capabilities.skillAdd.link.body')}
        </Text>
        <View style={styles.fieldRow}>
          <View style={styles.field}>
            <FieldTextInput
              testID={`${props.testID}.url`}
              value={url}
              editable={!acknowledged && !adding}
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
            disabled={url.trim() === '' || acknowledged !== null || adding}
            onPress={() => void find()}
            testID={`${props.testID}.find`}
          />
        </View>
        {found !== null ? (
          <ItemGroup
            title={
              found.length > 0
                ? t('capabilities.skillAdd.link.found', { count: found.length })
                : t('capabilities.skillAdd.link.none')
            }
            surface="none"
          >
            <SkillPreviewRows
              testID={props.testID}
              items={found}
              ticked={ticked}
              onToggle={(path) => { if (!acknowledged && !adding) setTicked((previous) => toggleSkillPreview(found, previous, path)); }}
              onOpen={props.onAdded}
              facts={(item) => ({
                presentation: 'row',
                source: {
                  kind: 'git',
                  label: item.path || '/',
                  ...(previewRef(item) ? { ref: previewRef(item)! } : {}),
                },
                trust: item.trust,
                cost: { tokensWhenUsed: item.cost.bodyTokens },
              })}
            />
          </ItemGroup>
        ) : null}
      </ScrollView>
      {found !== null && found.length > 0 ? (
        <CapabilityAddFooter
          testID={`${props.testID}.footer`}
          start={
            addError ? (
              <Text variant="meta" style={{ color: theme.colors.status.error }} testID={`${props.testID}.add-error`}>
                {addError}
              </Text>
            ) : null
          }
        >
          {allHeld?.kind === 'open' ? (
            <RoundButton
              size="normal"
              title={t('capabilities.skillAdd.open')}
              onPress={() => props.onAdded(allHeld.skillId)}
              testID={`${props.testID}.add`}
            />
          ) : allHeld?.kind === 'done' ? (
            <RoundButton
              size="normal"
              title={t('capabilities.add.done')}
              onPress={props.onDone}
              testID={`${props.testID}.done`}
            />
          ) : (
            <RoundButton
              size="normal"
              title={acknowledged ? t('capabilities.skillAdd.partial.tryAgain') : t('capabilities.skillAdd.link.addSelected', {
                count: ticked.size,
              })}
              loading={adding}
              disabled={adding || ticked.size === 0}
              onPress={() => void add()}
              testID={`${props.testID}.add`}
            />
          )}
        </CapabilityAddFooter>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  body: {
    paddingTop: theme.space.s16,
    paddingBottom: theme.space.s24,
    gap: theme.space.s16,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s12,
  },
  field: { flex: 1, minWidth: 0 },
}));
