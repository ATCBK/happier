import { resolveAccountDisplayLabelV1, type AccountDisplayProfileV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';

import { t } from '@/text';

/**
 * How the app names an Account. `formatAccountDisplayName` is the Account's own name, else
 * username, or `null`; surfaces that name a person on screen use `resolveAccountDisplayName`, which
 * never falls back to the raw id: an Account without a name is "Unnamed account", told apart by a hint
 * (a sign-in email the caller already holds, else a short, stable id suffix). Keys and dedupe keep
 * using the id itself.
 */
export function formatAccountDisplayName(profile: Readonly<{ name?: string | null; username?: string | null }>): string | null {
    return resolveAccountDisplayLabelV1(profile);
}

/** Characters of the id kept in the hint: enough to tell a Home's unnamed Accounts apart. */
const ACCOUNT_SHORT_ID_LENGTH = 5;

export type AccountDisplayPresentation = Readonly<{
    /** What the Account is called on screen. */
    name: string;
    /** A secondary line that tells unnamed Accounts apart; `null` for a named Account. */
    hint: string | null;
    named: boolean;
    /**
     * The viewer's own Account. Unnamed, it is already "Your account"; named, a surface says "you"
     * after the name (`person.viewer && person.named`).
     */
    viewer: boolean;
}>;

export function resolveAccountDisplayName(input: Readonly<{
    profile: AccountDisplayProfileV1 | null | undefined;
    accountId: string;
    /** A sign-in email the surface is already allowed to show (Home People), preferred as the hint. */
    signInEmail?: string | null;
    /**
     * The Account the surface is shown to. That Account is named to its owner by the one viewer
     * rule (`resolveViewerAccountDisplayName`): never "Unnamed account" or a hint about themselves.
     */
    viewerAccountId?: string | null;
}>): AccountDisplayPresentation {
    const name = input.profile ? formatAccountDisplayName(input.profile) : null;
    const id = input.accountId.trim();
    const viewer = Boolean(id) && id === input.viewerAccountId?.trim();
    if (viewer) return { name: resolveViewerAccountDisplayName(name), hint: null, named: name !== null, viewer: true };
    if (name) return { name, hint: null, named: true, viewer: false };
    const email = input.signInEmail?.trim();
    return {
        name: t('accountDisplay.unnamed'),
        hint: email || (id ? t('accountDisplay.shortId', { id: id.slice(-ACCOUNT_SHORT_ID_LENGTH) }) : null),
        named: false,
        viewer: false,
    };
}

/**
 * The viewer's own Account, named to its owner: its name, else "Your account" — never "Unnamed
 * account" or an id hint about themselves. `name` comes from `formatAccountDisplayName`.
 */
export function resolveViewerAccountDisplayName(name: string | null | undefined): string {
    return name?.trim() || t('accountDisplay.yours');
}
