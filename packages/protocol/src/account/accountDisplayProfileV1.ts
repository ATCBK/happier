import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/** One person label across hosts. An Account identity is never a display name. */
export function resolveAccountDisplayLabelV1(profile: Readonly<{ name?: string | null; username?: string | null }>): string | null {
  return profile.name?.trim() || profile.username?.trim() || null;
}

/** Decode released first/last presentation only when the canonical field is absent. */
export function readAccountNameFromLegacyProfileV1(profile: Readonly<{ name?: string | null; firstName?: string | null; lastName?: string | null }>): string | null {
  if (profile.name !== undefined) return profile.name?.trim() || null;
  return [profile.firstName?.trim(), profile.lastName?.trim()].filter(Boolean).join(' ') || null;
}

/** Preserve an unsplit chosen name for released clients that compose first/last. */
export function projectAccountNameToLegacyFieldsV1(name: string | null): Readonly<{ firstName: string | null; lastName: null }> {
  return { firstName: name?.trim() || null, lastName: null };
}

/**
 * The neutral, safe-to-disclose presentation fields of one Home Account.
 *
 * This is deliberately smaller than the social `UserProfile`: it carries no
 * Account identity, email, Home/Team role, relationship state, bio, badge,
 * provider identity, or cryptographic key. Consumers that need an identity
 * carry it beside this profile in their own authorized projection.
 *
 * The schema is strict because identity presentation is security-sensitive: an
 * unknown field is a disclosure bug, not an additive extension.
 */
export const AccountDisplayProfileV1BaseSchema = lazyZodSchema(() => z.object({
  name: z.string().nullable().optional(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
}).strict());

export const AccountDisplayProfileV1Schema = lazyZodSchema(() => AccountDisplayProfileV1BaseSchema.transform(
  profile => ({ ...profile, name: readAccountNameFromLegacyProfileV1(profile) }),
));

export type AccountDisplayProfileV1 = z.infer<typeof AccountDisplayProfileV1Schema>;

export function parseAccountDisplayProfileV1(value: unknown): AccountDisplayProfileV1 | null {
  const parsed = AccountDisplayProfileV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
