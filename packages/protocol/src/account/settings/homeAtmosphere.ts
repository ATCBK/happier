import * as z from 'zod/mini';
import { lazyDefinition } from '../../lazyZodSchema.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';

const PlanetSchema = lazyDefinition(() => z.strictObject({
    placement: z.enum(['corner', 'side', 'rise']), style: z.enum(['airy', 'balanced', 'rich']), digits: z.boolean(),
}));
export const AtmospherePictureRefSchema = lazyDefinition(() => z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('builtin'), id: z.string() }),
        z.strictObject({ kind: z.literal('user'), localId: z.string() }),
    ]));
export const AtmospherePictureSchema = lazyDefinition(() => z.strictObject({
    ref: AtmospherePictureRefSchema,
    layout: z.enum(['horizon', 'wallpaper']),
}));
export const AtmosphereLookOverrideSchema = lazyDefinition(() => z.strictObject({
    look: z.optional(z.enum(['original', 'fine', 'painted-fine', 'halftone', 'mosaic', 'painted', 'haze', 'engraving'])),
    strength: z.optional(defineStoredReadProjection(z.number().check(z.minimum(0), z.maximum(1)), () => z.number())),
    dissolve: z.optional(z.enum(['ordered', 'gradient', 'haze', 'shrink', 'rows'])),
}));
/** Presentation shared by contextual editors; context lifecycle switches stay with their owners. */
export const AtmospherePresentationSchema = lazyDefinition(() => z.strictObject({
    source: z.enum(['none', 'planet', 'picture']), planet: PlanetSchema, picture: AtmospherePictureSchema,
    looks: z.record(z.string(), AtmosphereLookOverrideSchema),
}));
export const ProjectAtmosphereSchema = lazyDefinition(() => z.strictObject({
    ...AtmospherePresentationSchema.shape, behindSessions: z.boolean(),
}));
export const HomeAtmosphereSchema = lazyDefinition(() => z.strictObject({
    ...ProjectAtmosphereSchema.shape, moments: z.record(z.string(), z.boolean()),
}));
export type HomeAtmosphere = z.infer<typeof HomeAtmosphereSchema>;
export type ProjectAtmosphere = z.infer<typeof ProjectAtmosphereSchema>;
export type AtmosphereLookOverride = z.infer<typeof AtmosphereLookOverrideSchema>;
export type AtmospherePresentation = z.infer<typeof AtmospherePresentationSchema>;

export const DEFAULT_HOME_ATMOSPHERE: HomeAtmosphere = {
    source: 'planet', planet: { placement: 'corner', style: 'balanced', digits: true },
    picture: { ref: { kind: 'builtin', id: 'white-rocks-open-sea' }, layout: 'horizon' }, looks: {}, behindSessions: false,
    moments: { welcome: true, loading: true, send: true, qr: true, pairing: true, themeSwitch: true,
        sessionFinished: true, idleResettle: true, releaseCaption: true, yourHome: true },
};

export function atmospherePresentation(value: AtmospherePresentation): AtmospherePresentation {
    return { source: value.source, planet: value.planet, picture: value.picture, looks: value.looks };
}
