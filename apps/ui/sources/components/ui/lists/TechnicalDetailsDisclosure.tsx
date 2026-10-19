import * as React from 'react';
import {
    HappierTechnicalDetailsDisclosure,
    happierPageTextMetrics,
    type HappierTechnicalDetailsContentProps,
    type HappierTechnicalDetailsLine,
    type HappierTechnicalDetailsTextRender,
} from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type TechnicalDetailsLine = HappierTechnicalDetailsLine;

function TechnicalDetailsBody(props: Readonly<{ children: React.ReactNode }>) {
    return <SectionContentRow>{props.children}</SectionContentRow>;
}

// Core's text adapter, so the `uiFontScale` local setting applies to the reference lines.
const renderTechnicalDetailsText: HappierTechnicalDetailsTextRender = (input) => input.role === 'value' ? (
    <Text selectable style={styles.value}>{input.text}</Text>
) : (
    <Text style={styles.label}>{input.text}</Text>
);

/**
 * Happier core's binding of the shared "Technical details" disclosure (approvals, Run steps): its
 * counted-disclosure row, section content inset, density-scaled spacing and typography. The
 * composition is `HappierTechnicalDetailsDisclosure` in `@happier-dev/plugin-ui`.
 */
export function TechnicalDetailsDisclosure(props: HappierTechnicalDetailsContentProps) {
    const { theme } = useUnistyles();
    const space = React.useMemo(() => ({ s4: theme.space.s4 }), [theme.space.s4]);
    return (
        <HappierTechnicalDetailsDisclosure
            {...props}
            Disclosure={CountedDisclosureItem}
            Body={TechnicalDetailsBody}
            renderText={renderTechnicalDetailsText}
            space={space}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    label: {
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
    },
    value: {
        ...happierPageTextMetrics('rowDescription'),
        ...Typography.mono(),
        minWidth: 0,
        color: theme.colors.text.secondary,
    },
}));
