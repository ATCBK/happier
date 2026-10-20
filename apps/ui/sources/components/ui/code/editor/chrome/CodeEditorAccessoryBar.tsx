import * as React from 'react';
import { Keyboard, Platform } from 'react-native';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { t } from '@/text';
import type {
  CodeEditorCommand,
  CodeEditorHistory,
  TextEditorHandle,
} from '../codeEditorTypes';
import { EditorAccessoryBar, EditorAccessoryChip } from './EditorAccessoryBar';

/** Symbol keys a phone keyboard buries a layer or two deep, in the order code reaches for them. */
const SYMBOL_KEYS = [
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '"',
  "'",
  '/',
  ',',
  ';',
  '=',
  '<',
  '>',
  '|',
  '&',
] as const;

export type CodeEditorAccessoryBarProps = Readonly<{
  editor: TextEditorHandle | null;
  /** The editor's Save: primary once dirty, quiet while the Machine can't take it, hidden during a conflict. */
  save: Readonly<{
    visible: boolean;
    enabled: boolean;
    tone: 'primary' | 'default';
    busy?: boolean;
    onPress(): void;
  }>;
  /** Present when the file has change marks: steps to the next change and opens its peek. */
  onChanges?: () => void;
  testID?: string;
}>;

function useEditorHistory(editor: TextEditorHandle | null): CodeEditorHistory {
  const [history, setHistory] = React.useState<CodeEditorHistory>({
    canUndo: false,
    canRedo: false,
  });
  React.useEffect(() => editor?.subscribeHistory?.(setHistory), [editor]);
  return history;
}

function hideKeyboard() {
  if (Platform.OS !== 'web') {
    Keyboard.dismiss();
    return;
  }
  if (
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement
  )
    document.activeElement.blur();
}

/**
 * The phone editor's one key row above the keyboard (files lab ED1p, ade-shell Ep, P4-R7): hide
 * keyboard, Tab and outdent, the code symbols, the caret arrows, Find and Changes, with Undo and Save
 * pinned at the end. Every key is an editor command through the handle, never a synthetic key event;
 * the engine refuses commands while an IME composition is open.
 */
export const CodeEditorAccessoryBar = React.memo(
  function CodeEditorAccessoryBar(props: CodeEditorAccessoryBarProps) {
    const { editor } = props;
    const history = useEditorHistory(editor);
    const run = React.useCallback(
      (command: CodeEditorCommand) => {
        editor?.runCommand?.(command);
      },
      [editor],
    );
    const testID = props.testID ?? 'code-editor-accessory';
    return (
      <EditorAccessoryBar
        testID={testID}
        accessibilityLabel={t('files.editing.editorKeys')}
        leading={
          <EditorAccessoryChip
            testID={`${testID}-hide-keyboard`}
            icon="keyboard"
            label={t('files.editing.hideKeyboard')}
            onPress={hideKeyboard}
          />
        }
        trailing={
          <>
            <EditorAccessoryChip
              testID={`${testID}-undo`}
              icon="arrow-arc-left"
              label={t('common.undo')}
              disabled={!history.canUndo}
              onPress={() => run('undo')}
            />
            {props.save.visible ? (
              <ToolbarButton
                testID={`${testID}-save`}
                label={t('common.save')}
                size="md"
                tone={props.save.tone}
                disabled={!props.save.enabled}
                busy={props.save.busy}
                onPress={props.save.onPress}
              />
            ) : null}
          </>
        }
      >
        <EditorAccessoryChip
          testID={`${testID}-tab`}
          text="Tab"
          label={t('files.editing.indent')}
          onPress={() => run('indent')}
        />
        <EditorAccessoryChip
          testID={`${testID}-outdent`}
          text="⇤"
          label={t('files.editing.outdent')}
          onPress={() => run('outdent')}
        />
        {SYMBOL_KEYS.map((key) => (
          <EditorAccessoryChip
            key={key}
            testID={`${testID}-insert-${key}`}
            text={key}
            label={t('files.editing.insertText', { text: key })}
            onPress={() => run({ insert: key })}
          />
        ))}
        <EditorAccessoryChip
          testID={`${testID}-left`}
          icon="arrow-left"
          label={t('files.editing.moveLeft')}
          onPress={() => run('moveLeft')}
        />
        <EditorAccessoryChip
          testID={`${testID}-right`}
          icon="arrow-right"
          label={t('files.editing.moveRight')}
          onPress={() => run('moveRight')}
        />
        <EditorAccessoryChip
          testID={`${testID}-redo`}
          icon="arrow-arc-right"
          label={t('files.editing.redo')}
          disabled={!history.canRedo}
          onPress={() => run('redo')}
        />
        <EditorAccessoryChip
          testID={`${testID}-find`}
          icon="magnifying-glass"
          label={t('find.open')}
          onPress={() => run('find')}
        />
        {props.onChanges ? (
          <EditorAccessoryChip
            testID={`${testID}-changes`}
            text={t('files.editing.changes')}
            label={t('files.editing.nextChange')}
            onPress={props.onChanges}
          />
        ) : null}
      </EditorAccessoryBar>
    );
  },
);
