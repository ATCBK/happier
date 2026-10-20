import * as React from 'react';
import { View } from 'react-native';

import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { WorkflowWaitLeafV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';

import {
    ScopedAuthoringComposer,
    type AuthoringComposerScope,
    type ScopedAuthoringDocument,
} from '@/components/sessions/authoring/ScopedAuthoringComposer';
import type { WorkflowAuthoringComposerCustody } from '@/components/sessions/authoring/authoringComposerCustody';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { resolveWorkflowUnnamedHeading, workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';

import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowBlockHeading, type WorkflowBlockNameEditor } from './WorkflowBlockHeading';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';
import { formatWorkflowBlockOptionsSummary, useWorkflowStepOptionsChip } from './WorkflowStepOptionsChip';
import type { WorkflowDocumentStepSlots } from './workflowDocumentPresentation';
import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * A Wait for you step (U4, 04 §4.3): what the person should do, in the same
 * authoring-only composer every step uses (no submit), and "This lane waits
 * until you continue." Its own node at run time is 05's; the result fields the
 * person supplies are the result editor's (U-13).
 */
type WorkflowWaitBlockEditorProps = Readonly<{
    block: WorkflowWaitLeafV1;
    ordinal: number;
    /** The block's visible number (`workflowBlockOrdinalV1`); `null` for a container. */
    visibleOrdinal?: string | null;
    /** Whether this step is the selected block: its ordinal fills. */
    selected?: boolean;
    nameEditor?: WorkflowBlockNameEditor;
    total: number;
    actions: readonly WorkflowBlockAction[];
    composerScope: AuthoringComposerScope;
    composerCustody: WorkflowAuthoringComposerCustody;
    onSelect: () => void;
    onChangeBlock: (next: WorkflowWaitLeafV1) => void;
    editable?: boolean;
    /** Whether this Wait sits in a lane; at the workflow's root it pauses the workflow (DESIGN-6 P3). */
    inLane?: boolean;
    /** Registers the block's heading as its focus target (blocks without a prompt). */
    focusRegistration?: (focus: (() => void) | null) => void;
    /** The first issue on this step, once the page reveals issues; named in its own words (P3). */
    issue?: string | null;
    slots?: WorkflowDocumentStepSlots | null;
    /** Opens this block's Step options, anchored beside its options control; absent when read-only. */
    onOpenOptions?: (anchorRef: React.RefObject<View | null>) => void;
    testIDPrefix: string;
}>;

export function WorkflowWaitBlockEditor(props: WorkflowWaitBlockEditorProps): React.ReactElement {
    // The list publishes a new draft and callbacks on every keystroke. A Wait
    // card renders only its own block; events must still consume the latest
    // callbacks so an untouched sibling cannot write an older whole draft.
    const latest = React.useRef(props);
    latest.current = props;
    const events = React.useMemo(() => ({
        select: () => latest.current.onSelect(),
        change: (block: WorkflowWaitLeafV1) => latest.current.onChangeBlock(block),
        openOptions: (anchor: React.RefObject<View | null>) => latest.current.onOpenOptions?.(anchor),
        registerFocus: (focus: (() => void) | null) => latest.current.focusRegistration?.(focus),
        rename: (name: string) => latest.current.nameEditor?.onChangeText(name),
        commitName: () => latest.current.nameEditor?.onCommit?.(),
        focusName: () => latest.current.nameEditor?.onFocus?.(),
    }), []);
    const name = props.nameEditor;
    const nameEditor = React.useMemo(() => name === undefined ? undefined : ({
        value: name.value,
        placeholder: name.placeholder,
        accessibilityLabel: name.accessibilityLabel,
        accessibilityHint: name.accessibilityHint,
        editable: name.editable,
        controlRef: name.controlRef,
        testID: name.testID,
        onChangeText: events.rename,
        onCommit: name.onCommit === undefined ? undefined : events.commitName,
        onFocus: name.onFocus === undefined ? undefined : events.focusName,
    }), [name?.value, name?.placeholder, name?.accessibilityLabel, name?.accessibilityHint,
        name?.editable, name?.controlRef, name?.testID, name !== undefined,
        name?.onCommit !== undefined, name?.onFocus !== undefined, events]);
    // Menu identity depends on its displayed choices, never on closures over
    // the entire draft. Dispatch each choice through the current list owner.
    const actionKey = JSON.stringify(props.actions.map(({ onSelect: _onSelect, ...action }) => action));
    const actions = React.useMemo(() => props.actions.map(action => ({
        ...action,
        onSelect: () => latest.current.actions.find(current => current.id === action.id)?.onSelect(),
    })), [actionKey]);
    return <WorkflowWaitBlockEditorContent {...props}
        nameEditor={nameEditor} actions={actions}
        onSelect={events.select} onChangeBlock={events.change}
        onOpenOptions={props.onOpenOptions === undefined ? undefined : events.openOptions}
        focusRegistration={props.focusRegistration === undefined ? undefined : events.registerFocus} />;
}

const WorkflowWaitBlockEditorContent = React.memo(function WorkflowWaitBlockEditorContent(props: WorkflowWaitBlockEditorProps): React.ReactElement {
    const { block, testIDPrefix } = props;
    const editable = props.editable !== false;
    const custody = props.composerCustody.entryFor(block.id);
    const latestRef = React.useRef(props);
    latestRef.current = props;
    const handleChangeDocument = React.useCallback((document: ScopedAuthoringDocument) => {
        const current = latestRef.current;
        current.onChangeBlock({
            ...current.block,
            document: {
                text: document.text,
                references: [...document.references],
                attachments: document.attachments.map((attachment) => ({
                    ...attachment,
                    value: PluginJsonValueV2Schema.parse(attachment.value),
                })),
            },
        });
    }, []);
    const handleFocus = React.useCallback(() => latestRef.current.onSelect(), []);
    const displayName = workflowBlockReferenceLabel(block);
    const rowPrefix = `${testIDPrefix}-wait-${block.id}`;
    // Step options is a chip in the composer's own chip row, as on every step (07 S7).
    const optionsSummary = formatWorkflowBlockOptionsSummary(block);
    const stepOptionsChip = useWorkflowStepOptionsChip({
        label: optionsSummary.label,
        changed: optionsSummary.changed,
        onOpen: (anchorRef) => latestRef.current.onOpenOptions?.(anchorRef),
        testID: `${rowPrefix}-options`,
        labelTestID: `${rowPrefix}-options-label`,
    });
    const hasOptions = editable && props.onOpenOptions !== undefined;
    const composerChips = React.useMemo(
        () => (hasOptions ? [stepOptionsChip] : undefined),
        [hasOptions, stepOptionsChip],
    );

    return (
        <View testID={rowPrefix} style={workflowEditorStyles.blockBody}>
            <WorkflowBlockHeading
                nameEditor={props.nameEditor}
                kindMark={<Icon name={WORKFLOW_BLOCK_KIND_GLYPH.wait} size={ICON_SIZE.sm} />}
                ordinal={props.ordinal}
                selected={props.selected}
                unnamed={resolveWorkflowUnnamedHeading(block)}
                visibleOrdinal={props.visibleOrdinal ?? null}
                {...(props.focusRegistration === undefined ? {} : { focusRegistration: props.focusRegistration })}
                displayName={displayName}
                accessibilityLabel={t('workflows.a11y.stepContext', { block: displayName, position: props.ordinal, total: props.total })}
                issue={props.issue ?? null}
                actions={editable ? props.actions : []}
                accessory={props.slots?.state}
                onSelect={props.onSelect}
                testID={`${rowPrefix}-label`}
                actionsTestID={`${rowPrefix}-actions`}
            />
            {props.slots?.occurrenceSelector ?? null}
            <View testID={`${rowPrefix}-prompt`} style={workflowEditorStyles.promptFrame}>
                <ScopedAuthoringComposer
                    inputAccessibilityLabel={displayName}
                    custody={custody}
                    scope={props.composerScope}
                    document={block.document}
                    onChangeDocument={editable ? handleChangeDocument : undefined}
                    attachmentsEnabled
                    placeholder={t('workflows.page.blocks.waitPlaceholder')}
                    editable={editable}
                    // A workflow step's prompt is written, not spoken to: dictation without the Voice
                    // planet, as every step composer (07 S-o).
                    voiceAffordance="dictation"
                    onFocus={handleFocus}
                    {...(composerChips === undefined ? {} : { extraActionChips: composerChips })}
                />
            </View>
            {props.slots?.reviewedCard ?? null}
            <View style={workflowEditorStyles.metaRow}>
                {props.slots?.settled === true ? null
                    : <Text style={workflowEditorStyles.metaText}>{t(props.inLane === true ? 'workflows.page.blocks.waitSub' : 'workflows.page.blocks.waitSubRoot')}</Text>}
                {props.slots?.footer ?? null}
            </View>
            {props.issue === undefined || props.issue === null ? null
                : <Text testID={`${rowPrefix}-issue`} style={workflowEditorStyles.issueText}>{props.issue}</Text>}
        </View>
    );
});
