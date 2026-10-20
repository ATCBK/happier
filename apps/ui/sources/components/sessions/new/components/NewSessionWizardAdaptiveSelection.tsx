import * as React from 'react';
import { View, type View as RNView } from 'react-native';

import { AgentInputContentPopover, type AgentInputContentPopoverConfig } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import type { ResolvedAdaptiveSelectionPresentation } from '@/components/ui/selection/AdaptiveSelectionSection';
import type { NewSessionWizardSectionPresentation } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';

export function resolveWizardAdaptivePresentation(
    value: NewSessionWizardSectionPresentation | undefined,
    autoPresentation: ResolvedAdaptiveSelectionPresentation,
): ResolvedAdaptiveSelectionPresentation {
    if (value === 'list') return 'expanded';
    if (value === 'dropdown') return 'compact';
    return autoPresentation;
}

/**
 * The wizard's compact selections share one row grammar: the current value (with the thing's own mark,
 * when it has one) and a chevron that opens its picker beside the row. The section's `ItemGroup` owns
 * the sheet, so these render bare rows.
 */
export function NewSessionWizardPopoverItem(props: Readonly<{
    testID: string;
    title: string;
    subtitle?: string | null;
    icon?: React.ReactNode;
    popover?: AgentInputContentPopoverConfig;
    boundaryRef: React.RefObject<RNView | null>;
}>) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<RNView>(null);
    return (
        <View ref={anchorRef} collapsable={false}>
            <Item
                testID={props.testID}
                title={props.title}
                subtitle={props.subtitle ?? undefined}
                leftElement={props.icon}
                showChevron={true}
                // Its picker opens beside the row, as the Agent and Permissions selects do.
                accessibilityExpanded={open}
                disabled={!props.popover}
                onPress={() => {
                    if (!props.popover) return;
                    setOpen(true);
                }}
            />
            {props.popover ? (
                <AgentInputContentPopover
                    open={open}
                    anchorRef={anchorRef}
                    boundaryRef={props.popover.boundaryRef ?? props.boundaryRef}
                    content={props.popover.renderContent}
                    maxHeightCap={props.popover.maxHeightCap}
                    maxWidthCap={props.popover.maxWidthCap}
                    scrollEnabled={props.popover.scrollEnabled}
                    keyboardShouldPersistTaps={props.popover.keyboardShouldPersistTaps}
                    edgeFades={props.popover.edgeFades}
                    edgeIndicators={props.popover.edgeIndicators}
                    initialVisibility={props.popover.initialVisibility}
                    onRequestClose={() => {
                        props.popover?.onRequestClose?.();
                        setOpen(false);
                    }}
                />
            ) : null}
        </View>
    );
}

export function NewSessionWizardDropdownSelectionItem(props: Readonly<{
    testID: string;
    title: string;
    subtitle?: string | null;
    icon?: React.ReactNode;
    items: readonly DropdownMenuItem[];
    selectedId?: string | null;
    search?: boolean;
    searchPlaceholder?: string;
    boundaryRef: React.RefObject<RNView | null>;
    onSelect: (id: string) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={props.items}
            selectedId={props.selectedId}
            onSelect={props.onSelect}
            rowKind="item"
            variant="selectable"
            search={props.search}
            searchPlaceholder={props.searchPlaceholder}
            showCategoryTitles={false}
            matchTriggerWidth
            connectToTrigger
            popoverBoundaryRef={props.boundaryRef}
            // The same value row as the wizard's other compact selections, not a page field select.
            trigger={({ toggle }) => (
                <Item
                    testID={props.testID}
                    title={props.title}
                    subtitle={props.subtitle ?? undefined}
                    leftElement={props.icon}
                    showChevron={true}
                    onPress={toggle}
                />
            )}
        />
    );
}
