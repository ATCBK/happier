import * as React from 'react';
import { WELCOME_RETYPE_RATE, WELCOME_RETYPE_STEP_S, welcomeRetypeTime } from './moments/planetMomentTimeline';
import type { PlanetCanvasProps } from './planetCanvas.types';

/** Only the drawing leaf advances Welcome's resting digits; its scene owner stays still. */
export function usePlanetDigits(props: PlanetCanvasProps): PlanetCanvasProps {
    const [time, setTime] = React.useState(0);
    const running = props.options !== undefined && props.retype !== undefined && !props.retype.paused;
    React.useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => setTime(current => welcomeRetypeTime(current + WELCOME_RETYPE_STEP_S)),
            WELCOME_RETYPE_STEP_S * 1000);
        return () => clearInterval(timer);
    }, [running]);
    return props.options && props.retype
        ? { ...props, options: { ...props.options, time, rate: WELCOME_RETYPE_RATE } }
        : props;
}
