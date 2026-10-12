import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    presentMachineAdministrationTargetState,
    useMachineAdministrationTargetFilter,
    type MachineAdministrationTargetSelectorProps,
} from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * The part of an Account page that runs on one computer ("On this computer", "Setup and status"):
 * a section whose header carries the machine chip, so the page around it never waits for a machine.
 *
 * Its rows render only while the chosen machine is online. With no machine it says what one is
 * needed for, and the line's one small control is the machine chooser itself (or, with no machine
 * to choose, leads to setting one up); no header chip repeats it. With an offline or unusable
 * machine it names the machine, keeps the last known fact when the caller has one, and offers
 * another; the chip stays in the header, because it is the control that recovers those states.
 * On a phone the line's control moves beneath its sentence.
 *
 * Untitled, it is a page's one machine line rather than a section: nothing while the chosen machine
 * is usable and there is nothing to run there, otherwise the line alone, its own chooser recovering
 * every state (no header to carry a chip).
 */
export const MachineScopedSection = React.memo(function MachineScopedSection(props: Readonly<{
    title?: string;
    description?: string;
    selection: MachineAdministrationTargetSelectorProps['selection'];
    resolveCandidateAvailability?: MachineAdministrationTargetSelectorProps['resolveCandidateAvailability'];
    /** What a computer is needed for here, said when none is chosen. */
    unselectedInvitation: string;
    /** The last known fact for an offline machine ("Last test: working, yesterday 18:20."). */
    offlineDetail?: string | null;
    /** Why the chosen machine is locked, when the domain knows ("Locked by its owner"). */
    lockedReason?: string | null;
    testIDPrefix: string;
    children?: React.ReactNode;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const [chipOpen, setChipOpen] = React.useState(false);
    const openChip = React.useCallback(() => setChipOpen(true), []);
    const setUpComputer = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push('/(app)/settings/machines' as never));
        if (result !== true) fireAndForget(result, { tag: 'MachineScopedSection.setUpComputer' });
    }, [router]);
    // One machine filter: the header chip, or, with no machine chosen, the line's own chooser.
    const filter = useMachineAdministrationTargetFilter({
        selection: props.selection,
        resolveCandidateAvailability: props.resolveCandidateAvailability,
        testIDPrefix: props.testIDPrefix,
        chipOpen,
        onChipOpenChange: setChipOpen,
    });
    const state = props.selection.state;
    const lineTestID = `${props.testIDPrefix}.state`;
    // A sentence, not a row title: body weight in the secondary ink (lab PD3).
    const lineTitleStyle = React.useMemo(() => ({ ...Typography.default(), color: theme.colors.text.secondary }), [theme.colors.text.secondary]);
    const line = (title: string, control: React.ReactNode) => (
        <Item
            testID={lineTestID}
            title={title}
            titleStyle={lineTitleStyle}
            // The sentence says why the section is empty and what to do; it wraps, never cut.
            titleLines={0}
            mode="info"
            showChevron={false}
            rightElement={control}
            rightElementOutsidePressable
            accessoryLayout="adaptive"
        />
    );

    const untitled = props.title === undefined;
    let body: React.ReactNode;
    if (state.kind === 'online') {
        if (props.children == null || props.children === false) return null;
        body = props.children;
    } else if (state.kind === 'unselected') {
        body = line(props.unselectedInvitation, state.candidates.length > 0 ? (
            <SelectionListFilterChip
                filter={{
                    ...filter,
                    // The selector's own unselected label, so the chip reads the same everywhere it appears.
                    valueLabel: t('newSession.selectMachineTitle'),
                    icon: undefined,
                    muted: false,
                    testID: `${props.testIDPrefix}.choose`,
                }}
            />
        ) : (
            <RoundButton
                testID={`${props.testIDPrefix}.setUp`}
                size="small"
                display="secondary"
                title={t('settingsMachines.scopeSetUpComputer')}
                onPress={setUpComputer}
            />
        ));
    } else if (state.kind === 'missing' && state.inventoryKnown === false && (state.inventoryStatus ?? 'loading') === 'loading') {
        // The machine's Home has not listed its machines yet: not known to be gone.
        body = <SurfaceStateCard testID={lineTestID} size="line" kind="loading" title={t('common.loading')} />;
    } else {
        const presentation = presentMachineAdministrationTargetState(state);
        const title = state.kind === 'offline'
            ? [t('settingsMachines.scopeOffline', { machine: presentation.title }), props.offlineDetail]
                .filter(Boolean)
                .join(' ')
            : [presentation.title, state.kind === 'locked' ? props.lockedReason : null, presentation.detail]
                .filter(Boolean)
                .join(' · ');
        body = line(title, untitled ? (
            <SelectionListFilterChip
                filter={{
                    ...filter,
                    valueLabel: t('settingsPlugins.targetSelection.chooseAnother'),
                    icon: undefined,
                    muted: false,
                    testID: `${props.testIDPrefix}.chooseAnother`,
                }}
            />
        ) : (
            <RoundButton
                testID={`${props.testIDPrefix}.chooseAnother`}
                size="small"
                display="secondary"
                title={t('settingsPlugins.targetSelection.chooseAnother')}
                onPress={openChip}
            />
        ));
    }

    return (
        <ItemGroup
            title={props.title}
            description={props.description}
            action={state.kind === 'unselected' || untitled ? undefined : <SelectionListFilterChip filter={filter} />}
        >
            {body}
        </ItemGroup>
    );
});
