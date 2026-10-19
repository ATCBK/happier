import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { CapabilityAddFooter } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';
import { t } from '@/text';

import { skillOutsideReferencesNote } from '../outsideReferences';
import { installSkills, previewSkillInstall } from './skillInstall';

/** The preview's identity facts: where it was found, pinned. */
export function previewRef(item: SkillInstallPreviewV1): string | undefined {
  const provenance = item.provenance;
  if (provenance.kind === 'link' && provenance.ref.kind === 'gitTree')
    return provenance.ref.commit.slice(0, 7);
  if (
    provenance.kind === 'registry' &&
    provenance.registry.ref.kind === 'gitTree'
  )
    return provenance.registry.ref.commit.slice(0, 7);
  return undefined;
}

/**
 * From a link (lab sa L): paste a repository or folder, look (`skills.install` dry run, nothing written), tick the
 * skills to add, and add them in one call with `selectPaths`.
 */
export function SkillLinkInput(
  props: Readonly<{
    execute: MountedAuthoringActionExecute;
    onAdded: (skillId: string) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
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

  const find = React.useCallback(async () => {
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
    setTicked(new Set(preview.items.map((item) => item.path)));
  }, [props.execute, url]);

  const add = React.useCallback(async () => {
    if (state.kind !== 'found' || ticked.size === 0) return;
    setAdding(true);
    setAddError(null);
    const outcome = await installSkills(props.execute, {
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
    props.onAdded(outcome.skillIds[0]!);
  }, [props, state, ticked, url]);

  const found = state.kind === 'found' ? state.items : null;
  return (
    <View style={styles.fill}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.body}
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
        {found !== null ? (
          <ItemGroup
            title={
              found.length > 0
                ? t('capabilities.skillAdd.link.found', { count: found.length })
                : t('capabilities.skillAdd.link.none')
            }
            surface="none"
          >
            {found.map((item) => (
              <CapabilityRow
                key={item.path}
                testID={`${props.testID}.item.${item.name}`}
                title={item.name}
                description={item.description}
                facts={{
                  presentation: 'row',
                  source: {
                    kind: 'git',
                    label: item.path || '/',
                    ...(previewRef(item) ? { ref: previewRef(item)! } : {}),
                  },
                  trust: item.trust,
                  cost: { tokensWhenUsed: item.cost.bodyTokens },
                }}
                checked={ticked.has(item.path)}
                note={skillOutsideReferencesNote(item.outsideReferences, `${props.testID}.item.${item.name}.outsideReferences`)}
                onPress={() =>
                  setTicked((previous) => {
                    const next = new Set(previous);
                    if (next.has(item.path)) next.delete(item.path);
                    else next.add(item.path);
                    return next;
                  })
                }
              />
            ))}
          </ItemGroup>
        ) : null}
      </ScrollView>
      {found !== null && found.length > 0 ? (
        <CapabilityAddFooter
          testID={`${props.testID}.footer`}
          start={
            addError ? (
              <Text variant="meta" style={{ color: theme.colors.status.error }}>
                {addError}
              </Text>
            ) : null
          }
        >
          <RoundButton
            size="normal"
            title={t('capabilities.skillAdd.link.addSelected', {
              count: ticked.size,
            })}
            loading={adding}
            disabled={ticked.size === 0}
            onPress={() => void add()}
            testID={`${props.testID}.add`}
          />
        </CapabilityAddFooter>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  body: {
    paddingHorizontal: theme.space.s24,
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
