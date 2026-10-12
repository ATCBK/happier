import * as React from 'react';
import { AppState } from 'react-native';

export function useCanvasRenderState(size: { width: number; height: number }) {
    const [visible, setVisible] = React.useState(() => AppState.currentState == null || AppState.currentState === 'active');
    const [settled, setSettled] = React.useState(size);
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', state => setVisible(state === 'active'));
        return () => subscription.remove();
    }, []);
    React.useEffect(() => {
        if (!visible || (size.width === settled.width && size.height === settled.height)) return;
        const timer = setTimeout(() => setSettled(size), 120);
        return () => clearTimeout(timer);
    }, [settled.height, settled.width, size.height, size.width, visible]);
    return { visible, size: settled };
}
