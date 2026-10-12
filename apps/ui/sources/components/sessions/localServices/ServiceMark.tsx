import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ServiceRow } from '@/sync/domains/local/services/serviceRow';

const stylesheet = StyleSheet.create((theme) => ({
    letter: {
        ...Typography.default('bold'),
        fontSize: 16,
        color: theme.colors.text.secondary,
    },
}));

/**
 * The one mark of a service in the Services pane, the Browser launchpad and the pushed detail.
 * A Project declaration is a service of this checkout (the Services page's own mark, lab s-services);
 * an undeclared script is a terminal command; a detected listener keeps the first letter of what it
 * is. No service brand-mark owner exists, so the letter stays neutral ink rather than a per-service
 * colour (a mark stands on its own, never on a tile).
 */
export function ServiceMark(props: Readonly<{ row: ServiceRow; testID: string }>): React.ReactElement {
    const { row } = props;
    if (row.target.declaration) return <Icon testID={props.testID} name="hard-drives" size={18} />;
    if (row.target.source === 'package_script') return <Icon testID={props.testID} name="terminal" size={18} />;
    return (
        <Text testID={props.testID} style={stylesheet.letter}>
            {(row.serviceLabel ?? row.title).slice(0, 1).toLocaleUpperCase()}
        </Text>
    );
}
