import * as React from 'react';
import { StyleSheet as NativeStyleSheet, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import type { WorkspaceFileDetailsFileContent } from '../details/workspaceFileDetails/refreshWorkspaceFileDetails';
import { formatFilePageBytes } from './FilePageStates';

export type FilePageInfoFacts = Readonly<{
  path: string;
  /** What the viewer calls the file ("Text file", "PNG image"). */
  kindLabel: string | null;
  language: string | null;
  sizeBytes: number | null;
  encoding: WorkspaceFileDetailsFileContent['encoding'] | null;
  lineCount: number | null;
}>;

/** UTF-8 with LF is what text is expected to be: only an unusual encoding or line ending is worth a row (P3 §3.2 Info). */
function unusualEncoding(encoding: FilePageInfoFacts['encoding']): string | null {
  if (!encoding) return null;
  if (encoding.reason === 'notUtf8') return t('files.pane.page.encodingNotUtf8');
  return encoding.hasBom ? t('files.pane.page.encodingBom') : null;
}

function unusualLineEndings(encoding: FilePageInfoFacts['encoding']): string | null {
  if (!encoding) return null;
  if (encoding.mixedEol) return t('files.pane.page.eolMixed');
  return encoding.eol === 'crlf' ? t('files.pane.page.eolCrlf') : null;
}

/**
 * `⋯ › Info` (P3 §3.2): the facts about this file the header has no room for, in one quiet list —
 * name first, then kind, language, lines, size, the encoding when unusual, and the full path.
 */
export function FilePageInfoDialog(
  props: CustomModalInjectedProps & Readonly<{ facts: FilePageInfoFacts }>,
) {
  const { facts } = props;
  const fileName =
    facts.path.split(/[\\/]/).filter(Boolean).at(-1) ?? facts.path;
  const rows: Array<
    Readonly<{ id: string; label: string; value: string; mono?: boolean }>
  > = [];
  if (facts.kindLabel)
    rows.push({
      id: 'kind',
      label: t('files.pane.page.infoKind'),
      value: facts.kindLabel,
    });
  // The language is worth its own row only when the kind doesn't already name it (Markdown · markdown).
  if (facts.language && facts.language !== 'text' && facts.language.toLowerCase() !== facts.kindLabel?.toLowerCase())
    rows.push({
      id: 'language',
      label: t('files.pane.page.infoLanguage'),
      value: facts.language,
      mono: true,
    });
  if (typeof facts.lineCount === 'number')
    rows.push({
      id: 'lines',
      label: t('files.pane.page.infoLines'),
      value: facts.lineCount.toLocaleString(),
    });
  if (typeof facts.sizeBytes === 'number')
    rows.push({
      id: 'size',
      label: t('files.pane.page.infoSize'),
      value: formatFilePageBytes(facts.sizeBytes),
    });
  const encoding = unusualEncoding(facts.encoding);
  if (encoding) rows.push({ id: 'encoding', label: t('files.pane.page.infoEncoding'), value: encoding });
  const lineEndings = unusualLineEndings(facts.encoding);
  if (lineEndings) rows.push({ id: 'lineEndings', label: t('files.pane.page.infoLineEndings'), value: lineEndings });
  return (
    <ModalCardFrame
      testID="file-info-dialog"
      title={fileName}
      onClose={props.onClose}
      dimensions={{
        width: HAPPIER_PAGE_METRICS.dialogWidthPx.default,
        size: 'dialog',
      }}
    >
      <View style={styles.body}>
        {/* Where it lives, when that says more than the title (a file at the root is its own name). */}
        {facts.path !== fileName ? (
          <View style={styles.identity}>
            <FileIcon fileName={fileName} size={20} appearance="line" />
            <Text testID="file-info-path" selectable style={styles.path}>
              {facts.path}
            </Text>
          </View>
        ) : null}
        <View style={styles.rows}>
          {rows.map((row, index) => (
            <View
              key={row.id}
              testID={`file-info-${row.id}`}
              style={[styles.row, index > 0 ? styles.rowDivided : null]}
            >
              <Text style={styles.label}>{row.label}</Text>
              <Text
                selectable
                numberOfLines={1}
                style={[styles.value, row.mono ? styles.mono : null]}
              >
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </ModalCardFrame>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s8,
    gap: theme.space.s12,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx,
    backgroundColor: theme.colors.surface.inset,
  },
  path: {
    ...Typography.variant('meta'),
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    color: theme.colors.text.secondary,
  },
  rows: {
    paddingHorizontal: theme.space.s4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.s16,
    paddingVertical: theme.space.s8,
  },
  rowDivided: {
    borderTopWidth: NativeStyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  label: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
  },
  value: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    textAlign: 'right',
  },
  mono: {
    ...Typography.mono(),
  },
}));
