import * as React from 'react';
import type { UiSurfaceNetworkPolicyV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { t } from '@/text';

type PublicLinkNetworkConsequence = Readonly<{
    visualCount: number; networkVisualCount: number; policies: readonly UiSurfaceNetworkPolicyV1[];
}>;

function networkPolicyKey(policy: UiSurfaceNetworkPolicyV1): string {
    return JSON.stringify([policy.network, [...new Set(policy.networkOrigins)].sort()]);
}

/** Compare the effect the person reviewed, not content revisions or declaration order. */
export function hasSamePublicLinkNetworkPolicy(left: UiSurfaceNetworkPolicyV1, right: UiSurfaceNetworkPolicyV1): boolean {
    return networkPolicyKey(left) === networkPolicyKey(right);
}

export function hasSamePublicLinkNetworkConsequence(left: PublicLinkNetworkConsequence, right: PublicLinkNetworkConsequence): boolean {
    return left.visualCount === right.visualCount && left.networkVisualCount === right.networkVisualCount
        && JSON.stringify([...new Set(left.policies.map(networkPolicyKey))].sort())
            === JSON.stringify([...new Set(right.policies.map(networkPolicyKey))].sort());
}

export function describePublicLinkNetworkConsequence(value: PublicLinkNetworkConsequence): string {
    return [t('session.collaboration.pane.linkNetworkCount', { count: value.networkVisualCount, total: value.visualCount }),
        ...value.policies.map(policy => policy.network === 'open' ? t('session.collaboration.pane.linkNetworkOpen')
            : policy.networkOrigins.join(', '))].filter(Boolean).join(' · ');
}

/** The off choice's words, shared by the link card's options and an original Action approval. */
export function describePublicLinkNetworkChoice(label?: string): Readonly<{ title: string; description: string }> {
    return { title: t('session.collaboration.pane.linkNetworkOff'),
        description: [label, t('session.collaboration.pane.linkNetworkConsequence')].filter(Boolean).join(' · ') };
}

/** The off switch itself; the card and the approval row each place it in their own anatomy. */
export function PublicLinkNetworkSwitch(props: Readonly<{
    networkOff: boolean; onNetworkOffChange: (off: boolean) => void; disabled?: boolean;
}>) {
    return <Switch testID="session-public-link-network-off" accessibilityLabel={t('session.collaboration.pane.linkNetworkOff')}
        value={props.networkOff} onValueChange={props.onNetworkOffChange} disabled={props.disabled} />;
}

/** The same consequence and off choice in Share and in an original Action approval. */
export function PublicLinkNetworkChoice(props: Readonly<{
    label?: string; networkOff: boolean; onNetworkOffChange: (off: boolean) => void; disabled?: boolean;
}>) {
    const copy = describePublicLinkNetworkChoice(props.label);
    return <Item title={copy.title} subtitle={copy.description} accessoryLayout="adaptive"
        rightElement={<PublicLinkNetworkSwitch networkOff={props.networkOff} onNetworkOffChange={props.onNetworkOffChange}
            disabled={props.disabled} />} />;
}

export function PublicLinkNetworkConfirmation(props: Readonly<{
    label: string; available: boolean; initiallyOff: boolean;
    onConfirm: (networkOff: boolean) => void; onClose: () => void;
}>) {
    const [networkOff, setNetworkOff] = React.useState(props.initiallyOff);
    return <ItemGroup title={t('session.sharing.publicLink')}>
        <PublicLinkNetworkChoice label={props.label} networkOff={networkOff} onNetworkOffChange={setNetworkOff}
            disabled={props.initiallyOff} />
        <SectionButtonRow>
            {/* One primary per view: issuing the link. Cancel stays quiet. */}
            <RoundButton display="secondary" title={t('common.cancel')} onPress={props.onClose} />
            <RoundButton testID="public-link-network-confirm" title={t('common.continue')}
                disabled={!props.available && !networkOff} onPress={() => {
                    if (!props.available && !networkOff) return;
                    props.onConfirm(networkOff);
                    props.onClose();
                }} />
        </SectionButtonRow>
    </ItemGroup>;
}
