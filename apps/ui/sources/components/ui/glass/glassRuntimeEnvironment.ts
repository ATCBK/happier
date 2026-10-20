import * as React from 'react';
import type { GlassAtmosphereTone, GlassMaterialEnvironment } from './glassMaterial';

const DEFAULT_ENVIRONMENT: GlassMaterialEnvironment = Object.freeze({});
const GlassRuntimeEnvironment = React.createContext<GlassMaterialEnvironment>(DEFAULT_ENVIRONMENT);

export const GlassRuntimeEnvironmentProvider = GlassRuntimeEnvironment.Provider;
type AtmosphereBehind = NonNullable<GlassMaterialEnvironment['atmosphereBehind']>;
const GlassAtmosphereBehindSetter = React.createContext<(value: AtmosphereBehind) => void>(() => {});
export const GlassAtmosphereBehindSetterProvider = GlassAtmosphereBehindSetter.Provider;

/** The one shell atmosphere layer sets its covered layout and clears it on unmount. */
export function useSetGlassAtmosphereBehind() {
    return React.useContext(GlassAtmosphereBehindSetter);
}

const GlassAtmosphereToneSetter = React.createContext<(value: GlassAtmosphereTone | undefined) => void>(() => {});
export const GlassAtmosphereToneSetterProvider = GlassAtmosphereToneSetter.Provider;

/** The same layer publishes the measured tone of the picture it draws, and clears it with its cover. */
export function useSetGlassAtmosphereTone() {
    return React.useContext(GlassAtmosphereToneSetter);
}

/** Lightweight presentation input; subscribing does not import the runtime driver. */
export function useGlassRuntimeEnvironment(): GlassMaterialEnvironment {
    return React.useContext(GlassRuntimeEnvironment);
}
