import type { AgentInputControlPlacement } from '@/components/sessions/agentInput/controls/agentInputControlTypes';
import type { IconName } from '@/components/ui/icons/Icon';
import { tLoose } from '@/text';

/** The parsed declaration, shared by interactive and metadata-only consumers. */
export type BooleanOptionActionChipDefinition = Readonly<{
    key: string;
    optionStateKey: string;
    iconName: string;
    onLabelKey: string;
    offLabelKey: string;
}>;

/** Resolve labels when consumed so an interpreted descriptor never captures a prior locale. */
export function getBooleanOptionActionChipPlacement(
    definition: Pick<BooleanOptionActionChipDefinition, 'key' | 'onLabelKey' | 'iconName'>,
): AgentInputControlPlacement {
    return {
        id: `providerOption:${definition.key}`,
        title: tLoose(definition.onLabelKey),
        icon: definition.iconName as IconName,
        defaultPlacement: 'overflow',
    };
}
