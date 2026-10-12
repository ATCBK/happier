import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';

/** Closed data-only picture declaration; rendering remains with the host atmosphere owner. */
export const PluginAtmospherePictureContributionV1Schema = lazyZodSchema(() => z.object({
    id: asProtocolZod(PluginContributionLocalIdSchema),
    kind: z.enum(['photo', 'painting']),
    title: z.string().min(1),
    credit: z.object({ author: z.string().min(1), source: z.string().min(1), url: z.string().url(), licence: z.string().min(1), note: z.string().optional() }).strict(),
    src: z.object({ full: z.string().url(), thumb: z.string().url() }).strict(),
    horizon: z.object({ src: z.number().optional(), at: z.number().optional() }).strict(),
    focus: z.object({ x: z.number().optional(), y: z.number().optional(), zoom: z.number().optional() }).strict(),
    hour: z.number(),
    grades: z.object({ light: z.number(), dusk: z.number(), night: z.number() }).strict(),
    dark: z.enum(['dusk', 'night']),
    look: z.object({
        effect: z.enum(['original', 'fine', 'painted-fine', 'halftone', 'mosaic', 'painted', 'haze', 'engraving']).optional(),
        params: z.record(z.string(), z.number()).optional(),
        dissolve: z.object({ style: z.enum(['ordered', 'gradient', 'haze', 'shrink', 'rows']).optional(), from: z.number().optional(), to: z.number().optional() }).strict().optional(),
        strength: z.number().optional(),
    }).strict(),
    adjust: z.object({ exposure: z.number().optional(), contrast: z.number().optional(), saturation: z.number().optional(), temperature: z.number().optional() }).strict().optional(),
    themes: z.array(z.enum(['light', 'dark'])).optional(),
}).strict());

export type PluginAtmospherePictureContributionV1 = z.infer<typeof PluginAtmospherePictureContributionV1Schema>;
