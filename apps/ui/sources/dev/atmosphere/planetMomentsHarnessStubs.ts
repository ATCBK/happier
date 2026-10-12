/**
 * U8 harness boundary: the session-ripple observation (U9b) and the theme host are app-store owners the
 * standalone page does not run. The Loading and Welcome moments never answer a session finish.
 */
export const useRuntimeActive = () => true;
export const useSessionTurnStates = () => new Map();
export const useSessionFinishedRipple = () => 0;
export const useSessionRipplePlayback = () => ({ gain: 1, ringShown: false });
export const useUnistyles = () => ({ theme: { dark: document.querySelector('[data-theme="dark"]') !== null, colors: { surface: { base: '#131111' } } } });
