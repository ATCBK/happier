import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { formatAccountDisplayName } from './formatAccountDisplayName';
import { t } from '@/text';

/** Shared Account byline facts; neither a profile lookup nor an access decision. */
export function resolveAccountActorPresentation(actor: TranscriptAccountActor, viewerScope: ServerAccountScope | null) {
    const isSelf = areServerAccountScopesEqual(actor, viewerScope);
    return {
        isSelf,
        name: actor.profile === null
            ? t('message.accountActorFormerMember')
            : isSelf
                ? t('message.accountActorYou')
                : formatAccountDisplayName(actor.profile) ?? t('message.accountActorUnnamedMember'),
        avatar: {
            id: actor.profile === null ? 'former-member' : serverAccountScopeKeySuffix(actor),
            imageUrl: actor.profile?.avatarUrl,
        },
    };
}
