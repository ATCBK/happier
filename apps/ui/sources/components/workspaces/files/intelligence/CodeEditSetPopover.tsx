import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { LanguageIntelligenceCodeAction } from '@happier-dev/protocol/machines/languageIntelligence';
import type { WorkspaceFileEditSetFile } from '@happier-dev/protocol/machines/workspaceFiles';
import { buildWorkspaceFileRestoreOperation } from '@happier-dev/protocol/machines/workspaceFilesReplace';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { Rect } from '@/components/ui/code/editor/codeEditorTypes';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { decodeUtf8Base64 } from '@/scm/diff/fallbackUnifiedDiff';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import {
  machineLanguageIntelligenceApplyAction,
  machineLanguageIntelligencePreviewAction,
} from '@/sync/ops/machineLanguageIntelligence';
import { machineWorkspaceFileReplaceApply } from '@/sync/ops/machineWorkspaceFileReplace';
import { workspaceReadFile } from '@/sync/ops/workspaceFileSystem/fileReadWrite';
import { t } from '@/text';

import {
  buildEditSetPreviewDiff,
  countEditSetChanges,
} from './codeEditSetPreview';

/** Rename (F2) or quick fixes (⌘.) for one name, asked from the File page. */
export type CodeEditSetRequest = Readonly<{
  op: 'rename' | 'fixes';
  anchor: Rect | null;
  /** Zero-based line and UTF-16 column of the name. */
  line: number;
  character: number;
  symbol: string;
}>;

export type CodeEditSetPopoverProps = Readonly<{
  request: CodeEditSetRequest;
  scope: WorkspaceScopeBase;
  accountId: string | null;
  filePath: string;
  languageId: string | null;
  /** The page's text; used for this file's diff while it has no unsaved edits. */
  readText: () => string;
  isUnsaved: () => boolean;
  /** Saves this file's editor; true when the disk now holds what the person sees. */
  save: () => Promise<boolean>;
  /** "TypeScript · NLDW3" when a server answered on this page. */
  sourceLabel: string | null;
  onRequestClose: () => void;
}>;

type Receipt = Readonly<{
  path: string;
  status: string;
  reason?: string;
  renameTo?: string;
  hash?: string;
  edits?: readonly unknown[];
}>;
type Stage =
  | Readonly<{ kind: 'unsaved'; saving: boolean }>
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'naming'; value: string; previewing: boolean }>
  | Readonly<{
      kind: 'choosing';
      actions: readonly LanguageIntelligenceCodeAction[];
      fileHash: string;
    }>
  | Readonly<{
      kind: 'review';
      files: readonly WorkspaceFileEditSetFile[];
      newName?: string;
      action?: LanguageIntelligenceCodeAction;
      fileHash?: string;
      back?: Stage;
      applying: boolean;
    }>
  | Readonly<{
      kind: 'result';
      receipts: readonly Receipt[];
      undo:
        | 'idle'
        | 'running'
        | Readonly<{ restored: number; changed: number; failed: boolean }>;
    }>
  | Readonly<{ kind: 'note'; text: string }>;

const POPOVER_WIDTH = 560;
const POPOVER_MAX_HEIGHT = 560;

function refusalText(
  result: Readonly<{ status: string; reason?: string; errorCode?: string }>,
  op: CodeEditSetRequest['op'],
): string {
  if (result.status === 'loading')
    return t('files.pane.intelligence.editLoading');
  if (
    result.status === 'unavailable' &&
    (result.reason === 'no_capable_server' ||
      result.reason === 'method_unavailable')
  )
    return op === 'rename'
      ? t('files.pane.intelligence.renameUnavailable')
      : t('files.pane.intelligence.fixesUnavailable');
  return t('files.pane.intelligence.editFailed');
}

/**
 * Semantic edits on the File page (P7 U7): the rename field or the fix list at the name, then the
 * edit set as the review renderer's diffs, one apply through the guarded writer, its per-file results
 * and one Undo through the canonical restore. A floating card on desktop, the shared sheet on phones.
 */
export function CodeEditSetPopover(
  props: CodeEditSetPopoverProps,
): React.ReactElement {
  const { request } = props;
  const latest = React.useRef(props);
  latest.current = props;
  const options = React.useMemo(
    () => ({ serverId: props.scope.serverId, accountId: props.accountId }),
    [props.accountId, props.scope.serverId],
  );
  const [stage, setStage] = React.useState<Stage>(() =>
    props.isUnsaved()
      ? { kind: 'unsaved', saving: false }
      : { kind: 'loading' },
  );
  const [texts, setTexts] = React.useState<ReadonlyMap<string, string | null>>(
    new Map(),
  );
  const alive = React.useRef(true);
  React.useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const address = React.useMemo(
    () => ({
      rootPath: props.scope.rootPath,
      path: props.filePath,
      line: request.line + 1,
      symbol: request.symbol,
      ...(props.languageId ? { languageId: props.languageId } : {}),
    }),
    [
      props.filePath,
      props.languageId,
      props.scope.rootPath,
      request.line,
      request.symbol,
    ],
  );

  const begin = React.useCallback(async () => {
    setStage({ kind: 'loading' });
    const machineId = latest.current.scope.machineId;
    const result = await machineLanguageIntelligencePreviewAction(
      machineId,
      request.op === 'rename' ? 'code.rename.preview' : 'code.codeActions.list',
      address,
      options,
    );
    if (!alive.current) return;
    if (result.status === 'ok' && result.kind === 'prepareRename') {
      const target = result.targets[0];
      if (!target)
        setStage({
          kind: 'note',
          text: t('files.pane.intelligence.cannotRename'),
        });
      else
        setStage({
          kind: 'naming',
          value: target.placeholder ?? request.symbol,
          previewing: false,
        });
      return;
    }
    if (result.status === 'ok' && result.kind === 'codeActions') {
      setStage(
        result.actions.length && result.fileHash
          ? {
              kind: 'choosing',
              actions: result.actions,
              fileHash: result.fileHash,
            }
          : { kind: 'note', text: t('files.pane.intelligence.noFixes') },
      );
      return;
    }
    if (
      result.status === 'error' &&
      result.errorCode === 'unsaved_editor_changes'
    ) {
      setStage({ kind: 'unsaved', saving: false });
      return;
    }
    setStage({ kind: 'note', text: refusalText(result, request.op) });
  }, [address, options, request.op, request.symbol]);

  React.useEffect(() => {
    if (stage.kind === 'loading') void begin();
    // Runs once per opening; later stages are driven by the person.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The review reads each file it shows; the page's own clean text needs no read.
  const loadTexts = React.useCallback(
    (files: readonly WorkspaceFileEditSetFile[]) => {
      const current = latest.current;
      const initial = new Map<string, string | null>();
      for (const file of files)
        if (file.path === current.filePath && !current.isUnsaved())
          initial.set(file.path, current.readText());
      setTexts(initial);
      for (const file of files) {
        if (initial.has(file.path)) continue;
        void workspaceReadFile(current.scope, file.path).then(
          (response) => {
            if (!alive.current) return;
            setTexts((previous) =>
              new Map(previous).set(
                file.path,
                response.success ? decodeUtf8Base64(response.content) : null,
              ),
            );
          },
          () => {
            if (alive.current)
              setTexts((previous) => new Map(previous).set(file.path, null));
          },
        );
      }
    },
    [],
  );

  const preview = React.useCallback(
    async (value: string) => {
      const name = value.trim();
      if (!name || name === request.symbol) return;
      setStage({ kind: 'naming', value, previewing: true });
      const result = await machineLanguageIntelligencePreviewAction(
        latest.current.scope.machineId,
        'code.rename.preview',
        { ...address, newName: name },
        options,
      );
      if (!alive.current) return;
      if (result.status === 'ok' && result.kind === 'rename') {
        if (!result.files.length) {
          setStage({
            kind: 'note',
            text: t('files.pane.intelligence.nothingToChange'),
          });
          return;
        }
        loadTexts(result.files);
        setStage({
          kind: 'review',
          files: result.files,
          newName: name,
          back: { kind: 'naming', value, previewing: false },
          applying: false,
        });
        return;
      }
      if (
        result.status === 'error' &&
        result.errorCode === 'unsaved_editor_changes'
      ) {
        setStage({ kind: 'unsaved', saving: false });
        return;
      }
      setStage({ kind: 'note', text: refusalText(result, 'rename') });
    },
    [address, loadTexts, options, request.symbol],
  );

  const choose = React.useCallback(
    (action: LanguageIntelligenceCodeAction, fileHash: string, back: Stage) => {
      if (action.disabledReason) return;
      loadTexts(action.files);
      setStage({
        kind: 'review',
        files: action.files,
        action,
        fileHash,
        back,
        applying: false,
      });
    },
    [loadTexts],
  );

  const apply = React.useCallback(async () => {
    if (stage.kind !== 'review' || stage.applying) return;
    setStage({ ...stage, applying: true });
    const current = latest.current;
    const operation =
      stage.action && stage.fileHash
        ? {
            kind: 'codeAction' as const,
            action: stage.action,
            expectedHash: stage.fileHash,
          }
        : { kind: 'rename' as const, files: [...stage.files] };
    let response: Awaited<
      ReturnType<typeof machineLanguageIntelligenceApplyAction>
    >;
    try {
      response = await machineLanguageIntelligenceApplyAction(
        current.scope.machineId,
        {
          rootPath: current.scope.rootPath,
          path: current.filePath,
          ...(current.languageId ? { languageId: current.languageId } : {}),
          operation,
        },
        options,
      );
    } catch {
      if (alive.current)
        setStage({
          kind: 'note',
          text: t('files.pane.intelligence.outcomeUnknown'),
        });
      return;
    }
    if (!alive.current) return;
    if ('ok' in response && response.ok) {
      setStage({ kind: 'result', receipts: response.results, undo: 'idle' });
      return;
    }
    // A request that may have reached the Machine never claims nothing happened.
    const unknown = 'errorCode' in response
      && (response.errorCode === 'outcome_unknown' || response.errorCode === 'outcome_uncertain' || response.errorCode === 'transport_failed');
    setStage({ kind: 'note', text: unknown ? t('files.pane.intelligence.outcomeUnknown') : t('files.pane.intelligence.editFailed') });
  }, [options, stage]);

  const undo = React.useCallback(async () => {
    if (stage.kind !== 'result' || stage.undo !== 'idle') return;
    const receipts = stage.receipts;
    setStage({ kind: 'result', receipts, undo: 'running' });
    const current = latest.current;
    const operation = buildWorkspaceFileRestoreOperation(
      receipts as Parameters<typeof buildWorkspaceFileRestoreOperation>[0],
    );
    const response = await machineWorkspaceFileReplaceApply(
      current.scope.machineId,
      { rootPath: current.scope.rootPath, operation },
      options,
    ).catch(() => null);
    if (!alive.current) return;
    if (!response || !response.ok) {
      setStage({
        kind: 'result',
        receipts,
        undo: { restored: 0, changed: 0, failed: true },
      });
      return;
    }
    let restored = 0,
      changed = 0,
      failed = false;
    for (const result of response.results) {
      if (result.status === 'restored') restored += 1;
      else if (result.status === 'changed') changed += 1;
      else failed = true;
    }
    setStage({ kind: 'result', receipts, undo: { restored, changed, failed } });
  }, [options, stage]);

  const saveFirst = React.useCallback(async () => {
    setStage({ kind: 'unsaved', saving: true });
    const saved = await latest.current.save();
    if (!alive.current) return;
    if (saved) void begin();
    else setStage({ kind: 'unsaved', saving: false });
  }, [begin]);

  const anchor = request.anchor;
  const popoverAnchor = React.useMemo(
    () =>
      anchor
        ? {
            kind: 'rect' as const,
            rect: {
              left: anchor.x,
              top: anchor.y,
              width: Math.max(1, anchor.width),
              height: Math.max(1, anchor.height),
            },
            coordinateSpace: 'window' as const,
          }
        : null,
    [anchor?.x, anchor?.y, anchor?.width, anchor?.height],
  );

  const body = (
    <CodeEditSetBody
      request={request}
      stage={stage}
      texts={texts}
      sourceLabel={props.sourceLabel}
      onChangeName={(value) =>
        setStage((previous) =>
          previous.kind === 'naming' ? { ...previous, value } : previous,
        )
      }
      onPreview={preview}
      onChoose={choose}
      onApply={apply}
      onBack={() =>
        setStage((previous) =>
          previous.kind === 'review' && previous.back
            ? previous.back
            : previous,
        )
      }
      onUndo={undo}
      onSave={saveFirst}
      onClose={props.onRequestClose}
    />
  );
  return (
    <Popover
      open
      anchor={popoverAnchor ?? undefined}
      backdrop={false}
      boundaryRef={null}
      onRequestClose={props.onRequestClose}
      phonePresentation="sheet"
      sheetHeader="none"
      sheetMaterial="solid"
      accessibilityLabel={
        request.op === 'rename'
          ? t('files.pane.intelligence.renameTitle')
          : t('files.pane.intelligence.fixesTitle')
      }
      portal={{
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'start',
      }}
      placement="bottom"
      flip
      gap={4}
      minWidth={0}
      maxWidthCap={POPOVER_WIDTH}
      maxHeightCap={POPOVER_MAX_HEIGHT}
    >
      {({ presentation, maxHeight, maxWidth }) =>
        presentation === 'sheet' ? (
          <View style={styles.sheet} testID="code-edit-set-sheet">
            {body}
          </View>
        ) : (
          <FloatingOverlay
            maxHeight={Math.min(maxHeight, POPOVER_MAX_HEIGHT)}
            role="panel"
          >
            <View
              testID="code-edit-set-card"
              style={{
                width: Math.min(POPOVER_WIDTH, maxWidth),
                maxHeight: Math.min(maxHeight, POPOVER_MAX_HEIGHT),
              }}
            >
              {body}
            </View>
          </FloatingOverlay>
        )
      }
    </Popover>
  );
}

function CodeEditSetBody(
  props: Readonly<{
    request: CodeEditSetRequest;
    stage: Stage;
    texts: ReadonlyMap<string, string | null>;
    sourceLabel: string | null;
    onChangeName: (value: string) => void;
    onPreview: (value: string) => void;
    onChoose: (
      action: LanguageIntelligenceCodeAction,
      fileHash: string,
      back: Stage,
    ) => void;
    onApply: () => void;
    onBack: () => void;
    onUndo: () => void;
    onSave: () => void;
    onClose: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { stage, request } = props;
  const rename = request.op === 'rename';
  const header = (
    <View style={styles.header}>
      <Text
        variant="label"
        emphasis="semiBold"
        style={styles.primaryText}
        numberOfLines={1}
      >
        {rename
          ? t('files.pane.intelligence.renameTitle')
          : t('files.pane.intelligence.fixesTitle')}
      </Text>
      <Text
        variant="meta"
        numberOfLines={1}
        style={[styles.mono, styles.tertiaryText, styles.headerName]}
      >
        {request.symbol}
      </Text>
    </View>
  );

  if (
    stage.kind === 'loading' ||
    stage.kind === 'note' ||
    stage.kind === 'unsaved'
  ) {
    return (
      <>
        {header}
        <View style={styles.block} testID={`code-edit-set-${stage.kind}`}>
          <Text
            variant="body"
            style={
              stage.kind === 'loading'
                ? styles.tertiaryText
                : styles.secondaryText
            }
          >
            {stage.kind === 'loading'
              ? rename
                ? t('files.pane.intelligence.preparingRename')
                : t('files.pane.intelligence.lookingForFixes')
              : stage.kind === 'unsaved'
                ? t('files.pane.intelligence.saveFirst')
                : stage.text}
          </Text>
        </View>
        {stage.kind === 'unsaved' ? (
          <Footer>
            <RoundButton
              size="small"
              display="secondary"
              title={t('common.cancel')}
              onPress={props.onClose}
              testID="code-edit-set-cancel"
            />
            <RoundButton
              size="small"
              title={t('common.save')}
              loading={stage.saving}
              onPress={props.onSave}
              testID="code-edit-set-save"
            />
          </Footer>
        ) : stage.kind === 'note' ? (
          <Footer>
            <RoundButton
              size="small"
              display="secondary"
              title={t('common.done')}
              onPress={props.onClose}
              testID="code-edit-set-done"
            />
          </Footer>
        ) : null}
      </>
    );
  }

  if (stage.kind === 'naming') {
    return (
      <>
        {header}
        <View style={styles.block}>
          <TextInput
            testID="code-rename-input"
            value={stage.value}
            onChangeText={props.onChangeName}
            onSubmitEditing={() => props.onPreview(stage.value)}
            accessibilityLabel={t('files.pane.intelligence.newName')}
            autoFocus
            selectTextOnFocus
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            editable={!stage.previewing}
            style={[Typography.variant('body'), styles.mono, styles.input]}
          />
          <Text variant="meta" style={styles.tertiaryText}>
            {stage.previewing
              ? t('files.pane.intelligence.findingUses')
              : t('files.pane.intelligence.renameHint')}
          </Text>
        </View>
        <Footer>
          <RoundButton
            size="small"
            display="secondary"
            title={t('common.cancel')}
            onPress={props.onClose}
            testID="code-edit-set-cancel"
          />
          <RoundButton
            size="small"
            title={t('files.pane.intelligence.previewRename')}
            disabled={
              !stage.value.trim() || stage.value.trim() === request.symbol
            }
            loading={stage.previewing}
            onPress={() => props.onPreview(stage.value)}
            testID="code-rename-preview"
          />
        </Footer>
      </>
    );
  }

  if (stage.kind === 'choosing') {
    return (
      <>
        {header}
        <ScrollView style={styles.scroll} testID="code-fixes-list">
          {stage.actions.map((action, index) => (
            <SelectableRow
              key={`${action.serverId}:${index}`}
              testID={`code-fix-${index}`}
              presentation="menu"
              title={action.title}
              {...(action.disabledReason
                ? { subtitle: action.disabledReason }
                : {})}
              left={
                <Icon
                  name="lightbulb"
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.secondary}
                />
              }
              disabled={Boolean(action.disabledReason)}
              onPress={() => props.onChoose(action, stage.fileHash, stage)}
            />
          ))}
        </ScrollView>
        {props.sourceLabel ? (
          <Footer>
            <Text
              variant="meta"
              numberOfLines={1}
              style={[styles.tertiaryText, styles.footerStatus]}
            >
              {props.sourceLabel}
            </Text>
          </Footer>
        ) : null}
      </>
    );
  }

  if (stage.kind === 'review') {
    const counts = countEditSetChanges(stage.files);
    const commandOnly =
      Boolean(stage.action?.hasCommand) && stage.files.length === 0;
    // A server action can carry no edit and no command: say so and offer nothing to apply.
    const empty = stage.files.length === 0 && !commandOnly;
    return (
      <>
        <View style={styles.header}>
          <Text
            variant="label"
            emphasis="semiBold"
            style={[styles.primaryText, stage.action ? null : styles.mono]}
            numberOfLines={1}
          >
            {stage.action
              ? stage.action.title
              : t('files.pane.intelligence.renameTo', {
                  from: request.symbol,
                  to: stage.newName ?? '',
                })}
          </Text>
        </View>
        <ScrollView style={styles.scroll} testID="code-edit-set-review">
          {commandOnly || empty ? (
            <View style={styles.block}>
              <Text variant="body" style={styles.secondaryText}>
                {empty ? t('files.pane.intelligence.nothingToChange') : t('files.pane.intelligence.runsCommand')}
              </Text>
            </View>
          ) : (
            stage.files.map((file) => (
              <EditSetFile
                key={file.path}
                file={file}
                text={props.texts.get(file.path)}
              />
            ))
          )}
          {stage.action?.hasCommand && !commandOnly ? (
            <View style={styles.block}>
              <Text variant="meta" style={styles.tertiaryText}>
                {t('files.pane.intelligence.alsoRunsCommand')}
              </Text>
            </View>
          ) : null}
        </ScrollView>
        <Footer>
          <Text
            variant="meta"
            numberOfLines={1}
            style={[styles.secondaryText, styles.tabular, styles.footerStatus]}
          >
            {commandOnly || empty
              ? ''
              : t('files.pane.intelligence.changesInFiles', counts)}
          </Text>
          {stage.back ? (
            <RoundButton
              size="small"
              display="secondary"
              title={t('common.back')}
              disabled={stage.applying}
              onPress={props.onBack}
              testID="code-edit-set-back"
            />
          ) : null}
          {empty ? null : <RoundButton
            size="small"
            title={
              stage.action
                ? t('files.pane.intelligence.applyFix')
                : t('files.pane.intelligence.renameInFiles', {
                    files: counts.files,
                  })
            }
            loading={stage.applying}
            onPress={props.onApply}
            testID="code-edit-set-apply"
          />}
        </Footer>
      </>
    );
  }

  // Results: what was written, what was left alone and why, and one Undo for all of it.
  const written = stage.receipts.filter(
    (receipt) => receipt.status === 'replaced',
  );
  const others = stage.receipts.filter(
    (receipt) => receipt.status !== 'replaced',
  );
  const undo = stage.undo;
  const title =
    typeof undo === 'object' && undo.restored > 0
      ? t('files.pane.intelligence.undone', { files: undo.restored })
      : written.length
        ? rename
          ? t('files.pane.intelligence.renamed', { files: written.length })
          : t('files.pane.intelligence.fixApplied')
        : t('files.pane.intelligence.nothingChanged');
  return (
    <>
      <View style={styles.header} testID="code-edit-set-result">
        <Icon
          name={written.length ? 'check' : 'warning'}
          size={ICON_SIZE.sm}
          color={
            written.length
              ? theme.colors.text.secondary
              : theme.colors.state.warning.foreground
          }
        />
        <Text
          variant="label"
          emphasis="semiBold"
          style={styles.primaryText}
          numberOfLines={1}
        >
          {title}
        </Text>
      </View>
      {others.length ||
      (typeof undo === 'object' && (undo.changed > 0 || undo.failed)) ? (
        <View style={styles.block}>
          {others.map((receipt) => (
            <View
              key={`${receipt.path}:${receipt.status}`}
              style={styles.resultRow}
            >
              <Text
                variant="meta"
                numberOfLines={1}
                style={[styles.mono, styles.secondaryText, styles.resultPath]}
              >
                {receipt.path}
              </Text>
              <Text
                variant="meta"
                numberOfLines={2}
                style={
                  receipt.status === 'failed'
                    ? styles.failureText
                    : styles.tertiaryText
                }
              >
                {receipt.status === 'changed'
                  ? t('files.pane.intelligence.resultChanged')
                  : receipt.status === 'skipped'
                    ? t('files.pane.intelligence.resultSkipped')
                    : t('files.pane.intelligence.resultFailed', {
                        reason: receipt.reason ?? '',
                      })}
              </Text>
            </View>
          ))}
          {typeof undo === 'object' && undo.changed > 0 ? (
            <Text variant="meta" style={styles.tertiaryText}>
              {t('files.pane.intelligence.undoChanged', {
                files: undo.changed,
              })}
            </Text>
          ) : null}
          {typeof undo === 'object' && undo.failed ? (
            <Text variant="meta" style={styles.failureText}>
              {t('files.pane.intelligence.undoFailed')}
            </Text>
          ) : null}
        </View>
      ) : null}
      <Footer>
        {written.length && typeof undo !== 'object' ? (
          <RoundButton
            size="small"
            display="secondary"
            title={t('common.undo')}
            loading={undo === 'running'}
            onPress={props.onUndo}
            testID="code-edit-set-undo"
          />
        ) : null}
        <RoundButton
          size="small"
          title={t('common.done')}
          onPress={props.onClose}
          testID="code-edit-set-done"
        />
      </Footer>
    </>
  );
}

function EditSetFile(
  props: Readonly<{
    file: WorkspaceFileEditSetFile;
    text: string | null | undefined;
  }>,
) {
  const { file } = props;
  const slash = file.path.lastIndexOf('/');
  const name = file.path.slice(slash + 1);
  const directory = slash > 0 ? file.path.slice(0, slash) : '';
  const patch = React.useMemo(
    () =>
      typeof props.text === 'string'
        ? buildEditSetPreviewDiff(file, props.text)
        : null,
    [file, props.text],
  );
  const count = file.edits.length + (file.renameTo ? 1 : 0);
  return (
    <View testID="code-edit-set-file">
      <View style={styles.fileHeader}>
        <FileIcon fileName={name} size={ICON_SIZE.sm} appearance="line" />
        <Text
          numberOfLines={1}
          style={[Typography.variant('label'), styles.fileName]}
        >
          <Text style={[Typography.default('medium'), styles.primaryText]}>
            {name}
          </Text>
          {directory ? (
            <Text style={styles.tertiaryText}>{`  ${directory}`}</Text>
          ) : null}
        </Text>
        <Text variant="meta" style={[styles.tertiaryText, styles.tabular]}>
          {String(count)}
        </Text>
      </View>
      {patch ? (
        <DiffViewer
          mode="unified"
          unifiedDiff={patch}
          filePath={file.renameTo ?? file.path}
          wrapLines
          showPrefix
          presentationStyleOverride="unified"
        />
      ) : (
        <Text variant="meta" style={[styles.tertiaryText, styles.fileNote]}>
          {props.text === undefined
            ? t('files.pane.intelligence.readingFile')
            : t('files.pane.intelligence.changesNotShown', { count })}
        </Text>
      )}
    </View>
  );
}

function Footer(props: Readonly<{ children: React.ReactNode }>) {
  return <View style={styles.footer}>{props.children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  sheet: {
    paddingBottom: theme.space.s12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s10,
    paddingBottom: theme.space.s6,
  },
  headerName: {
    flexShrink: 1,
  },
  block: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s8,
    gap: theme.space.s6,
  },
  input: {
    color: theme.colors.input.text,
    backgroundColor: theme.colors.input.background,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.space.s10,
    paddingVertical: theme.space.s6,
  },
  scroll: {
    flexShrink: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s10,
    paddingBottom: theme.space.s6,
  },
  fileName: {
    flex: 1,
    minWidth: 0,
  },
  fileNote: {
    paddingHorizontal: theme.space.s12,
    paddingBottom: theme.space.s8,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  footerStatus: {
    flex: 1,
    minWidth: 0,
  },
  resultRow: {
    gap: theme.space.s2,
  },
  resultPath: {
    flexShrink: 1,
  },
  mono: {
    ...Typography.mono(),
  },
  tabular: {
    ...Typography.tabular(),
  },
  primaryText: {
    color: theme.colors.text.primary,
  },
  secondaryText: {
    color: theme.colors.text.secondary,
  },
  tertiaryText: {
    color: theme.colors.text.tertiary,
  },
  failureText: {
    color: theme.colors.state.danger.foreground,
  },
}));
