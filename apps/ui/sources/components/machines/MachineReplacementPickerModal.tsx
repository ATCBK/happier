import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';

export type MachineReplacementPickerCandidate = Readonly<{
    id: string;
    label: string;
    subtitle: string;
    online: boolean | null;
}>;

export type MachineReplacementPickerModalProps = CustomModalInjectedProps & Readonly<{
    candidates: readonly MachineReplacementPickerCandidate[];
    onSelectCandidate: (machineId: string, label: string) => void;
}>;

export function MachineReplacementPickerModal(props: MachineReplacementPickerModalProps) {
    return (
        <ItemList presentation="grouped">
            <ItemGroup title={t('machine.replacementRepair.pickerCandidatesTitle')}
                description={t('machine.replacementRepair.chooseReplacementSubtitle')}>
                {props.candidates.map((candidate) => (
                    <Item
                        key={candidate.id}
                        testID={`machine-replacement-picker-candidate:${candidate.id}`}
                        title={candidate.label}
                        subtitle={candidate.subtitle}
                        detail={candidate.online === null ? t('common.unknown') : candidate.online ? t('status.online') : t('status.offline')}
                        showChevron={false}
                        onPress={() => {
                            props.onClose();
                            props.onSelectCandidate(candidate.id, candidate.label);
                        }}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
}
