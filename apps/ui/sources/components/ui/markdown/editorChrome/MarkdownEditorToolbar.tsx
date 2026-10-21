import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { EditorAccessoryBar, EditorAccessoryChip } from '@/components/ui/code/editor/chrome/EditorAccessoryBar';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { t } from '@/text';
import type { IconName } from '@/components/ui/icons/Icon';
import type {
    MarkdownEditorCommand,
    MarkdownEditorController,
    MarkdownSelectionState,
} from '@/components/ui/markdown/editor/markdownEditorTypes';

/**
 * Phase-1 formatting toolbar for the rich markdown editor (Lane C / C2).
 *
 * Drives the editor purely through the `MarkdownEditorController` contract
 * (`runCommand` + `subscribeSelection`). It never imports `@tiptap/*` or any
 * surface/bridge module — it reads from `MarkdownSelectionState` and writes
 * back commands. This makes it identical on web (react-native-web) and native.
 *
 * Phase-1 scope (R-A9): headings H1-H3, bold/italic/strike/inline-code,
 * bullet/ordered/task lists, blockquote, code block, horizontal rule. Links are
 * created via autolink/linkOnPaste in the surface — the toolbar only exposes
 * open/unlink for an already-selected link (R-A13/R-A18). There is no
 * insert-link chip in Phase 1.
 */

export type MarkdownEditorToolbarProps = Readonly<{
    controller: MarkdownEditorController;
    /**
     * Visual variant.
     * - `'panel'` (default): full footer bar with its own border + background; on
     *   native it is wrapped in `KeyboardStickyFooter` so it sits above the
     *   keyboard. Used by `RichMarkdownEditorPanel` in the file-pane.
     * - `'inline'`: chrome-less variant intended to sit inside a host header row
     *   (e.g. the prompt-editor screens, left of the Raw/Rich dropdown). The host
     *   provides the container; this variant adds NO outer bar background and is
     *   ALWAYS rendered inline (no keyboard-sticky wrap), since on a prompt screen
     *   it must read as part of the field's own header, not as a floating footer.
     */
    variant?: 'panel' | 'inline';
    /** Panel only: pinned keys before and after the chips (the phone key row's hide-keyboard and Save, ED1mp). */
    leading?: React.ReactNode;
    trailing?: React.ReactNode;
    testID?: string;
}>;

type OcticonName = IconName;

const DEFAULT_SELECTION_STATE: MarkdownSelectionState = {
    marks: { bold: false, italic: false, strike: false, code: false },
    blockType: 'paragraph',
    isLinkActive: false,
    canUndo: false,
    canRedo: false,
};

/**
 * Static descriptor for each always-present formatting chip. `isActive` reads
 * the live selection so the chip can reflect the mark/block currently under the
 * cursor; `command` is dispatched on press.
 */
type ToolbarChipSpec = Readonly<{
    id: string;
    icon: OcticonName;
    label: string;
    command: MarkdownEditorCommand;
    isActive: (state: MarkdownSelectionState) => boolean;
    /** Optional numeric badge (used to disambiguate H1/H2/H3 which share a glyph). */
    badge?: string;
}>;

function buildChipSpecs(): ToolbarChipSpec[] {
    return [
        {
            id: 'heading1',
            icon: 'text-h',
            label: t('markdownEditorToolbar.heading1'),
            command: { kind: 'setHeading', level: 1 },
            isActive: (s) => s.blockType === 'heading1',
            badge: '1',
        },
        {
            id: 'heading2',
            icon: 'text-h',
            label: t('markdownEditorToolbar.heading2'),
            command: { kind: 'setHeading', level: 2 },
            isActive: (s) => s.blockType === 'heading2',
            badge: '2',
        },
        {
            id: 'heading3',
            icon: 'text-h',
            label: t('markdownEditorToolbar.heading3'),
            command: { kind: 'setHeading', level: 3 },
            isActive: (s) => s.blockType === 'heading3',
            badge: '3',
        },
        {
            id: 'bold',
            icon: 'text-b',
            label: t('markdownEditorToolbar.bold'),
            command: { kind: 'toggleBold' },
            isActive: (s) => s.marks.bold,
        },
        {
            id: 'italic',
            icon: 'text-italic',
            label: t('markdownEditorToolbar.italic'),
            command: { kind: 'toggleItalic' },
            isActive: (s) => s.marks.italic,
        },
        {
            id: 'strike',
            icon: 'text-strikethrough',
            label: t('markdownEditorToolbar.strikethrough'),
            command: { kind: 'toggleStrike' },
            isActive: (s) => s.marks.strike,
        },
        {
            id: 'code',
            icon: 'code',
            label: t('markdownEditorToolbar.code'),
            command: { kind: 'toggleCode' },
            isActive: (s) => s.marks.code,
        },
        {
            id: 'bulletList',
            icon: 'list-bullets',
            label: t('markdownEditorToolbar.bulletList'),
            command: { kind: 'toggleBulletList' },
            isActive: (s) => s.blockType === 'bulletList',
        },
        {
            id: 'orderedList',
            icon: 'list-numbers',
            label: t('markdownEditorToolbar.orderedList'),
            command: { kind: 'toggleOrderedList' },
            isActive: (s) => s.blockType === 'orderedList',
        },
        {
            id: 'taskList',
            icon: 'list-checks',
            label: t('markdownEditorToolbar.taskList'),
            command: { kind: 'toggleTaskList' },
            isActive: (s) => s.blockType === 'taskList',
        },
        {
            id: 'blockquote',
            icon: 'quotes',
            label: t('markdownEditorToolbar.blockquote'),
            command: { kind: 'toggleBlockquote' },
            isActive: (s) => s.blockType === 'blockquote',
        },
        {
            id: 'codeBlock',
            icon: 'file-code',
            label: t('markdownEditorToolbar.codeBlock'),
            command: { kind: 'toggleCodeBlock' },
            isActive: (s) => s.blockType === 'codeBlock',
        },
        {
            id: 'horizontalRule',
            icon: 'minus',
            label: t('markdownEditorToolbar.horizontalRule'),
            command: { kind: 'setHorizontalRule' },
            isActive: () => false,
        },
    ];
}

function MarkdownEditorToolbarInner(props: MarkdownEditorToolbarProps): React.ReactElement {
    const { controller, testID, variant = 'panel' } = props;
    const styles = stylesheet;

    const [selectionState, setSelectionState] = React.useState<MarkdownSelectionState>(DEFAULT_SELECTION_STATE);

    React.useEffect(() => {
        const unsubscribe = controller.subscribeSelection(setSelectionState);
        return () => {
            unsubscribe();
        };
    }, [controller]);

    const chipSpecs = React.useMemo(() => buildChipSpecs(), []);

    const runCommand = React.useCallback(
        (command: MarkdownEditorCommand) => {
            hapticsLight();
            controller.runCommand(command);
        },
        [controller],
    );

    const handleOpenLink = React.useCallback(() => {
        // Open is a controller command (R-A18): the surface owns HOW a link is
        // opened (web `window.open`, native bridge), so the chrome stays decoupled
        // and never touches a surface/bridge module itself.
        runCommand({ kind: 'openLink' });
    }, [runCommand]);

    const handleUnlink = React.useCallback(() => {
        runCommand({ kind: 'unlink' });
    }, [runCommand]);

    const renderChip = (spec: ToolbarChipSpec) => {
        const active = spec.isActive(selectionState);
        return (
            <EditorAccessoryChip
                key={spec.id}
                testID={testID ? `${testID}:${spec.id}` : undefined}
                icon={spec.icon}
                label={spec.label}
                selected={active}
                badge={spec.badge}
                onPress={() => runCommand(spec.command)}
            />
        );
    };

    return (
        <EditorAccessoryBar testID={testID} variant={variant}
            leading={variant === 'panel' ? props.leading : undefined} trailing={variant === 'panel' ? props.trailing : undefined}>
            {chipSpecs.map(renderChip)}

            {selectionState.isLinkActive ? (
                <View style={styles.linkGroup} testID={testID ? `${testID}:link-actions` : undefined}>
                    <View style={styles.divider} />
                    <EditorAccessoryChip
                        testID={testID ? `${testID}:openLink` : undefined}
                        icon="arrow-square-out"
                        label={t('markdownEditorToolbar.openLink')}
                        onPress={handleOpenLink}
                    />
                    <EditorAccessoryChip
                        testID={testID ? `${testID}:unlink` : undefined}
                        icon="link-break"
                        label={t('markdownEditorToolbar.unlink')}
                        onPress={handleUnlink}
                    />
                </View>
            ) : null}
        </EditorAccessoryBar>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    linkGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    divider: {
        width: 1,
        height: 20,
        marginHorizontal: 2,
        backgroundColor: theme.colors.border.default,
    },
}));

export const MarkdownEditorToolbar = React.memo(MarkdownEditorToolbarInner);
