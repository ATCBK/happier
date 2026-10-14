import { z } from "zod/mini";

export const NotFoundSchema = z.object({ error: z.literal("not_found") });

