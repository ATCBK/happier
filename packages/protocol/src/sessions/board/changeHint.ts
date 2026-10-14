import { z } from 'zod/mini';

/** Content-free wake hint; ordinary Session changes also invalidate surface reads. */
export const SessionSurfacesChangeHintV1Schema = z.strictObject({
  v: z.literal(1),
  sessionSurfaces: z.literal(true),
});
export type SessionSurfacesChangeHintV1 = z.infer<typeof SessionSurfacesChangeHintV1Schema>;
