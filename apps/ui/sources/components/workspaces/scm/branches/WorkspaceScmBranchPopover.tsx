import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Popover } from '@/components/ui/popover';
import { SelectableMenuResults } from '@/components/ui/forms/dropdown/SelectableMenuResults';
import type { SelectableMenuItem } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { CREATE_ITEM_ID, useSelectableMenu } from '@/components/ui/forms/dropdown/useSelectableMenu';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export type WorkspaceScmBranchPopoverControls = Readonly<{
    closeMenu: () => void;
    reopenMenu: () => void;
}>;

export type WorkspaceScmBranchPopoverProps = Readonly<{
    open: boolean;
    onOpenChange: (next: boolean) => void;
    currentBranch: string | null;
    disabled?: boolean;
    branchItems: ReadonlyArray<SelectableMenuItem>;
    worktreeItems: ReadonlyArray<SelectableMenuItem>;
    onSelectItem: (itemId: string, controls: WorkspaceScmBranchPopoverControls) => void | Promise<void>;
    onCreateBranch?: ((query: string) => void | Promise<void>) | null;
    /**
     * `title`: the branch name as a standalone title (project pane). `line`: the pane header's live-line door
     * (Git lab BR): a branch glyph, the name as the line's one emphasised noun, a small chevron.
     */
    triggerAppearance?: 'title' | 'line';
    /** Asks the search field to take focus (a "New branch…" row); bump the value to ask again. */
    focusSearchRequest?: number;
    testID?: string;
}>;

export function WorkspaceScmBranchPopover(props: WorkspaceScmBranchPopoverProps): React.ReactElement {
    const { theme } = useUnistyles();
    const disabled = props.disabled === true;
    const anchorRef = React.useRef<View>(null);
    const triggerTestId = props.testID ?? 'scm-branch-menu-trigger';
    // Git lab BR: one list read top to bottom (current, branches, kept aside, worktrees, start something new).
    const items = React.useMemo(() => [...props.branchItems, ...props.worktreeItems], [props.branchItems, props.worktreeItems]);
    const allowCreateBranch = props.onCreateBranch ?? null;
    const { searchQuery, selectedIndex, filteredCategories, inputRef, handleSearchChange, handleKeyPress, setSelectedIndex } = useSelectableMenu({
        items,
        onRequestClose: () => props.onOpenChange(false),
        open: props.open,
        initialSelectedId: props.currentBranch ? `branch:${props.currentBranch}` : null,
        onCreateItem: allowCreateBranch
            ? (query) => {
                void allowCreateBranch(query);
            }
            : null,
        createItemFactory: allowCreateBranch
            ? (query) => ({
                title: t('files.branchMenu.create.title'),
                subtitle: t('files.branchMenu.create.subtitle', { name: query.trim() }),
                disabled: !query.trim(),
            })
            : null,
        allowEmptySelection: false,
    });

    React.useEffect(() => {
        if (!props.open || !props.focusSearchRequest) return;
        inputRef.current?.focus();
    }, [inputRef, props.focusSearchRequest, props.open]);

    const closeMenu = React.useCallback(() => props.onOpenChange(false), [props]);
    const reopenMenu = React.useCallback(() => props.onOpenChange(true), [props]);
    const controls = React.useMemo<WorkspaceScmBranchPopoverControls>(() => ({ closeMenu, reopenMenu }), [closeMenu, reopenMenu]);

    const handleActivateItem = React.useCallback((item: SelectableMenuItem) => {
        if (item.id === CREATE_ITEM_ID && allowCreateBranch) {
            void allowCreateBranch(searchQuery);
            return;
        }
        void props.onSelectItem(item.id, controls);
    }, [allowCreateBranch, controls, props, searchQuery]);

    return (
        <>
            <View ref={anchorRef} collapsable={false}>
                {props.triggerAppearance === 'line' ? (
                    <Pressable
                        testID={triggerTestId}
                        accessibilityRole="button"
                        accessibilityLabel={t('sessionGitBranches.openA11y', { branch: props.currentBranch || t('files.detachedHead') })}
                        accessibilityState={{ expanded: props.open, disabled }}
                        onPress={() => props.onOpenChange(!props.open)}
                        disabled={disabled}
                        hitSlop={6}
                        style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: theme.space.s4,
                            maxWidth: '100%',
                            opacity: pressed ? motionTokens.press.opacitySubtle : 1,
                        })}
                    >
                        <Icon name="git-branch" size={13} color={theme.colors.text.secondary} />
                        <Text numberOfLines={1} style={{ flexShrink: 1, ...Typography.variant('body', 'semiBold'), color: theme.colors.text.primary,  }}>
                            {props.currentBranch || t('files.detachedHead')}
                        </Text>
                        <Icon name={props.open ? 'caret-up' : 'caret-down'} size={11} color={theme.colors.text.tertiary} />
                    </Pressable>
                ) : (
                    <Pressable
                        testID={triggerTestId}
                        accessibilityRole="button"
                        accessibilityLabel={t('files.branchMenu.openA11y')}
                        onPress={() => props.onOpenChange(!props.open)}
                        disabled={disabled}
                        style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: theme.space.s6,
                            opacity: disabled ? 0.6 : pressed ? motionTokens.press.opacitySubtle : 1,
                        })}
                    >
                        <Text numberOfLines={1} style={{ ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary,  }}>
                            {props.currentBranch || t('files.detachedHead')}
                        </Text>
                        <Icon name={props.open ? 'caret-up' : 'caret-down'} size={14} color={theme.colors.text.secondary} />
                    </Pressable>
                )}
            </View>
            <Popover
                open={props.open}
                onRequestClose={closeMenu}
                anchorRef={anchorRef}
                placement="bottom"
                gap={4}
                maxHeightCap={480}
                maxWidthCap={420}
                portal={{ web: { target: 'body' }, native: true }}
            >
                {() => (
                    <View
                        style={{
                            width: 360,
                            maxWidth: 420,
                            minWidth: 280,
                            borderRadius: 14,
                            borderWidth: 1,
                            borderColor: theme.colors.border.default,
                            backgroundColor: theme.colors.surface.base,
                            overflow: 'hidden',
                        }}
                    >
                        <View style={{ paddingHorizontal: theme.space.s12, paddingTop: theme.space.s12, paddingBottom: theme.space.s10 }}>
                            <TextInput
                                ref={inputRef}
                                value={searchQuery}
                                onChangeText={handleSearchChange}
                                placeholder={t('sessionGitBranches.searchPlaceholder')}
                                placeholderTextColor={theme.colors.text.secondary}
                                testID="workspace-scm-branch-popover-search"
                                onKeyPress={(event) => {
                                    handleKeyPress(String(event.nativeEvent.key ?? ''), handleActivateItem);
                                }}
                                style={{
                                    fontSize: 13,
                                    color: theme.colors.text.primary,
                                    borderWidth: 1,
                                    borderColor: theme.colors.border.default,
                                    borderRadius: 10,
                                    paddingHorizontal: theme.space.s12,
                                    paddingVertical: theme.space.s8,
                                    backgroundColor: theme.colors.surface.inset ?? theme.colors.surface.base,
                                }}
                            />
                        </View>
                        <ScrollView
                            style={{ maxHeight: 360 }}
                            contentContainerStyle={{ paddingBottom: theme.space.s8 }}
                            keyboardShouldPersistTaps="handled"
                            nestedScrollEnabled
                            testID="workspace-scm-branch-popover-scroll"
                        >
                            <SelectableMenuResults
                                categories={filteredCategories}
                                selectedIndex={selectedIndex}
                                onSelectionChange={setSelectedIndex}
                                onPressItem={handleActivateItem}
                                rowVariant="slim"
                                emptyLabel={t('files.branchMenu.empty')}
                            />
                        </ScrollView>
                    </View>
                )}
            </Popover>
        </>
    );
}
