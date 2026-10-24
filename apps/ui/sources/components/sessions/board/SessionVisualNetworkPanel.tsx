import * as React from 'react';
import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import type { WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import { WidgetFlowPanel } from '@/components/widgets/flow/WidgetFlowPanel';
import { t } from '@/text';

import { parseSessionVisualNetworkOrigins, readSessionVisualNetworkChoice, type SessionVisualNetworkChoice } from './sessionBoardVisualNetwork';

/**
 * Network access for an existing HTML visual: none, exact sites, or any site, each with what it
 * means for the viewer. Saving is the Board's ordinary item update, so it asks for approval like
 * any other change to what a visual may reach.
 */
export function SessionVisualNetworkPanel(props: Readonly<{
    item: SessionSurfaceItemV1;
    onSave: (choice: SessionVisualNetworkChoice) => Promise<WidgetSetupSubmitResult>;
    onClose: () => void;
    testID: string;
}>): React.ReactElement {
    const current = React.useMemo(() => readSessionVisualNetworkChoice(props.item), [props.item]);
    const [mode, setMode] = React.useState<SessionVisualNetworkChoice['mode']>(current?.mode ?? 'none');
    const [sitesText, setSitesText] = React.useState((current?.origins ?? []).join('\n'));
    const [state, setState] = React.useState<'idle' | 'busy' | 'pending' | 'failed'>('idle');
    const [failure, setFailure] = React.useState<string | null>(null);
    const inFlight = React.useRef(false);
    const sites = React.useMemo(() => parseSessionVisualNetworkOrigins(sitesText), [sitesText]);
    const blocked = mode !== 'origins' ? null
        : sites.invalid.length > 0 ? t('sessionBoard.item.network.sitesInvalid', { sites: sites.invalid.join(', ') })
            : sites.origins.length === 0 ? t('sessionBoard.item.network.sitesNeeded') : null;
    const unchanged = current !== null && current.mode === mode
        && (mode !== 'origins' || [...current.origins].sort().join('\n') === [...sites.origins].sort().join('\n'));
    const save = async () => {
        if (inFlight.current || blocked !== null || state === 'pending') return;
        inFlight.current = true;
        setState('busy');
        const result = await props.onSave({ mode, origins: mode === 'origins' ? sites.origins : [] });
        inFlight.current = false;
        if (result.ok) {
            if (result.approvalPending) { setState('pending'); return; }
            props.onClose();
            return;
        }
        setFailure(result.message);
        setState('failed');
    };
    return (
        <WidgetFlowPanel
            title={t('sessionBoard.item.network.title')}
            hint={t('sessionBoard.item.network.hint')}
            testID={props.testID}
            onCancel={props.onClose}
            note={state === 'pending' ? t('widgetAdd.areaApprovalPending') : t('sessionBoard.item.network.shareOffNote')}
            error={state === 'failed' ? failure ?? t('sessionBoard.item.network.failed') : null}
            primary={state === 'pending'
                ? { label: t('common.done'), onPress: props.onClose }
                : { label: t('common.save'), testID: `${props.testID}.save`, onPress: () => { void save(); },
                    busy: state === 'busy', disabled: unchanged, blockedReason: blocked }}
        >
            <ListPresentationProvider value="page" pageInsets="contained">
                <ItemGroup surface="none" density="compact">
                    <SegmentedChoiceItem<SessionVisualNetworkChoice['mode']>
                        testID={`${props.testID}.mode`}
                        testIDPrefix={`${props.testID}.mode`}
                        title={t('sessionBoard.item.network.reach')}
                        options={[
                            { id: 'none', label: t('sessionBoard.item.network.none'), description: t('sessionBoard.item.network.noneConsequence') },
                            { id: 'origins', label: t('sessionBoard.item.network.sites'), description: t('sessionBoard.item.network.sitesConsequence') },
                            { id: 'open', label: t('sessionBoard.item.network.open'), description: t('sessionBoard.item.network.openConsequence') },
                        ]}
                        value={mode}
                        onChange={(next) => { setMode(next); if (state === 'failed') setState('idle'); }}
                    />
                    {mode === 'origins' ? (
                        <Item
                            testID={`${props.testID}.sites`}
                            title={t('sessionBoard.item.network.sitesLabel')}
                            showChevron={false}
                            accessoryLayout="adaptive"
                            rightElement={(
                                <FieldTextInput testID={`${props.testID}.sitesInput`} accessibilityLabel={t('sessionBoard.item.network.sitesLabel')}
                                    value={sitesText} onChangeText={setSitesText} multiline growWithText monospace minLines={2}
                                    placeholder={t('sessionBoard.item.network.sitesPlaceholder')} />
                            )}
                        />
                    ) : null}
                </ItemGroup>
            </ListPresentationProvider>
        </WidgetFlowPanel>
    );
}
