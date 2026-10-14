import { z } from "zod/mini";

export const GitHubProfileSchema = z.looseObject({
    id: z.number(),
    login: z.string(),
    avatar_url: z.optional(z.string()),
    name: z.optional(z.nullable(z.string())),
});

export type GitHubProfile = z.infer<typeof GitHubProfileSchema>;

