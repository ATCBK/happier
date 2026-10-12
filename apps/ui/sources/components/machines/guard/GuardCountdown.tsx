import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import { Text } from '@/components/ui/text/Text';

import { formatMachineCountdown } from '@/components/machines/durationWords';

/**
 * "Stops in 4:52": a leaf that ticks once a second only while it is shown and the stop is under ten
 * minutes away (every half minute before that), so nothing above it re-renders with the clock. It
 * ticks without pulsing; screen readers hear it when it appears, not every second.
 */
export const GuardCountdown = React.memo(function GuardCountdown(props: Readonly<{
    stopAt: number;
    format: (remaining: string) => string;
    style?: StyleProp<TextStyle>;
    testID?: string;
}>) {
    const [now, setNow] = React.useState(() => Date.now());
    const remaining = props.stopAt - now;
    const fast = remaining < 10 * 60_000;
    React.useEffect(() => {
        if (remaining <= 0) return;
        const timer = setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
        return () => clearInterval(timer);
    }, [fast, remaining <= 0]);
    return <Text testID={props.testID} style={props.style}>{props.format(formatMachineCountdown(remaining))}</Text>;
});
