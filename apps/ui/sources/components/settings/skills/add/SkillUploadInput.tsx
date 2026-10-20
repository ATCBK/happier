import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  SkillFileInputV1,
  SkillInstallPreviewV1,
} from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { CapabilityAddFooter } from '@/components/capabilities/add/CapabilityAddModal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone';
import {
  readSkillUpload,
  type SkillUploadError,
  type SkillUploadInput as UploadSource,
} from '@/sync/domains/skills/import/readSkillUpload';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { t } from '@/text';
import { applyWebDirectoryInputAttributes } from '@/utils/files/applyWebDirectoryInputAttributes';
import { nativePickFiles } from '@/utils/files/nativePickFiles';
import { readWebDroppedEntries } from '@/utils/files/webDroppedEntries';

import { SkillPreviewRows } from './SkillPreviewRows';
import { readOpenWhenAllHeld, tickAllSkillPreviews, toggleSkillPreview } from './skillPreviewSelection';
import { installSkills, previewSkillInstall } from './skillInstall';

function describeUploadError(error: SkillUploadError): string {
  switch (error.code) {
    case 'invalid_name':
      return t('capabilities.skillAdd.upload.invalidName', {
        file: error.file,
      });
    case 'unreadable':
      return t('capabilities.skillAdd.upload.unreadable', { file: error.file });
    case 'no_skill':
      return t('capabilities.skillAdd.upload.noSkill');
  }
}

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** A browser file chooser for one .zip or one folder, without a mounted DOM input. */
function chooseWebFiles(kind: 'zip' | 'folder'): Promise<readonly File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (kind === 'zip') input.accept = '.zip,application/zip';
    else applyWebDirectoryInputAttributes(input);
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

/**
 * Upload (lab sa U): a skill folder or a .zip, read here (`readSkillUpload`, nothing leaves the device until Add),
 * previewed by `skills.install { upload, dryRun }`, then added. A refusal names the file.
 */
export function SkillUploadInput(
  props: Readonly<{
    execute: MountedAuthoringActionExecute;
    onAdded: (skillId: string) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [state, setState] = React.useState<
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'reading' }>
    | Readonly<{
        kind: 'ready';
        files: readonly SkillFileInputV1[];
        items: readonly SkillInstallPreviewV1[];
      }>
    | Readonly<{ kind: 'error'; message: string }>
  >({ kind: 'idle' });
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(() => new Set());
  const [adding, setAdding] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);

  const accept = React.useCallback(
    async (source: UploadSource) => {
      setState({ kind: 'reading' });
      const read = await readSkillUpload(source);
      if (!read.ok) {
        setState({ kind: 'error', message: describeUploadError(read.error) });
        return;
      }
      const preview = await previewSkillInstall(props.execute, {
        kind: 'upload',
        files: [...read.files],
      });
      if (!preview.ok || preview.items.length === 0) {
        setState({
          kind: 'error',
          message: t('capabilities.skillAdd.upload.failed'),
        });
        return;
      }
      setTicked(tickAllSkillPreviews(preview.items));
      setState({ kind: 'ready', files: read.files, items: preview.items });
    },
    [props.execute],
  );

  const acceptWebFiles = React.useCallback(
    async (
      files: readonly Readonly<{ file: File; relativePath: string }>[],
    ) => {
      if (files.length === 0) return;
      const only = files[0]!;
      if (files.length === 1 && /\.zip$/i.test(only.file.name)) {
        await accept({
          kind: 'zip',
          name: only.file.name,
          bytes: await fileBytes(only.file),
        });
        return;
      }
      await accept({
        kind: 'folder',
        files: await Promise.all(
          files.map(async (entry) => ({
            path: entry.relativePath,
            bytes: await fileBytes(entry.file),
          })),
        ),
      });
    },
    [accept],
  );

  const drop = useWebFileDropZone({
    enabled: Platform.OS === 'web' && !adding,
    onFileDragActiveChange: setDragging,
    onFilesDropped: async (event) => {
      const transfer = event.dataTransfer as DataTransfer | null | undefined;
      if (!transfer) return;
      await acceptWebFiles(await readWebDroppedEntries(transfer));
    },
  });

  const choose = React.useCallback(
    async (kind: 'zip' | 'folder') => {
      if (Platform.OS === 'web') {
        const files = await chooseWebFiles(kind);
        await acceptWebFiles(
          files.map((file) => ({
            file,
            relativePath:
              (file as File & { webkitRelativePath?: string })
                .webkitRelativePath || file.name,
          })),
        );
        return;
      }
      const picked = await nativePickFiles({
        multiple: false,
        type: ['application/zip'],
      });
      const first = picked[0];
      if (!first) return;
      if (first.kind === 'web') {
        await accept({
          kind: 'zip',
          name: first.file.name,
          bytes: await fileBytes(first.file),
        });
        return;
      }
      const response = await fetch(first.uri);
      await accept({
        kind: 'zip',
        name: first.name,
        bytes: new Uint8Array(await response.arrayBuffer()),
      });
    },
    [accept, acceptWebFiles],
  );

  const previewRows = (items: readonly SkillInstallPreviewV1[], ticks: ReadonlySet<string> | null) => (
    <SkillPreviewRows
      testID={`${props.testID}.preview`}
      items={items}
      ticked={ticks}
      onToggle={(path) => setTicked((previous) => toggleSkillPreview(items, previous, path))}
      onOpen={props.onAdded}
      facts={(item) => ({
        presentation: 'row',
        source: { kind: 'you' },
        trust: item.trust,
        cost: { tokensWhenUsed: item.cost.bodyTokens },
      })}
    />
  );

  const add = React.useCallback(async () => {
    if (state.kind !== 'ready') return;
    setAdding(true);
    // One skill is added as it is; a folder of several adds the ticked ones.
    const several = state.items.length > 1;
    const outcome = await installSkills(props.execute, {
      source: { kind: 'upload', files: state.files },
      ...(several ? { selectPaths: state.items.filter((item) => ticked.has(item.path)).map((item) => item.path) } : {}),
    });
    setAdding(false);
    if (!outcome.ok) {
      setState({ kind: 'error', message: t('capabilities.add.addFailed') });
      return;
    }
    props.onAdded(outcome.skillIds[0]!);
  }, [props, state, ticked]);

  const openWhenHeld = state.kind === 'ready' ? readOpenWhenAllHeld(state.items) : null;
  return (
    <View style={styles.fill}>
      <ScrollView style={styles.fill} contentContainerStyle={[styles.body, edge]}>
        <Text variant="reading" style={{ color: theme.colors.text.secondary }}>
          {t('capabilities.skillAdd.upload.body')}
        </Text>
        <View
          {...(drop as object)}
          testID={`${props.testID}.drop`}
          style={[
            styles.drop,
            {
              borderColor: dragging
                ? theme.colors.border.focus
                : theme.colors.border.default,
            },
          ]}
        >
          <Icon
            name="upload"
            size={ICON_SIZE.lg}
            color={theme.colors.text.secondary}
          />
          <Text variant="body" style={{ color: theme.colors.text.secondary }}>
            {state.kind === 'reading'
              ? t('capabilities.skillAdd.upload.reading')
              : t('capabilities.skillAdd.upload.dropHere')}
          </Text>
          <View style={styles.chooseRow}>
            <RoundButton
              size="small"
              display="secondary"
              title={t('capabilities.skillAdd.upload.chooseZip')}
              onPress={() => void choose('zip')}
              testID={`${props.testID}.zip`}
            />
            {Platform.OS === 'web' ? (
              <RoundButton
                size="small"
                display="secondary"
                title={t('capabilities.skillAdd.upload.chooseFolder')}
                onPress={() => void choose('folder')}
                testID={`${props.testID}.folder`}
              />
            ) : null}
          </View>
        </View>
        {state.kind === 'error' ? (
          <Text
            variant="meta"
            style={{ color: theme.colors.status.error }}
            testID={`${props.testID}.error`}
          >
            {state.message}
          </Text>
        ) : null}
        {state.kind === 'ready' ? (
          state.items.length > 1 ? (
            <ItemGroup title={t('capabilities.skillAdd.upload.found', { count: state.items.length })} surface="none">
              {previewRows(state.items, ticked)}
            </ItemGroup>
          ) : (
            previewRows(state.items, null)
          )
        ) : null}
      </ScrollView>
      {state.kind === 'ready' ? (
        <CapabilityAddFooter testID={`${props.testID}.footer`} start={null}>
          <RoundButton
            size="normal"
            title={
              state.items.length > 1
                ? t('capabilities.skillAdd.link.addSelected', { count: ticked.size })
                : t('capabilities.skillAdd.addToLibrary')
            }
            loading={adding}
            disabled={state.items.length > 1 && ticked.size === 0}
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
    paddingTop: theme.space.s16,
    paddingBottom: theme.space.s24,
    gap: theme.space.s16,
  },
  drop: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s32,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: theme.borderRadius.lg,
  },
  chooseRow: { flexDirection: 'row', gap: theme.space.s8 },
}));
