/**
 * Copy for the Account handle (one username shared with Friends and the public page) and the
 * public profile settings page. English is the shape every locale block
 * (`features/publicIdentity.<locale>.ts`) must match.
 */
export const publicIdentityEn = {
  publicIdentity: {
    handle: {
      available: ({ username }: { username: string }) =>
        `@${username} is available`,
      taken: ({ username }: { username: string }) => `@${username} is taken`,
      reserved: ({ username }: { username: string }) =>
        `@${username} is reserved on this service`,
      invalid: 'This service doesn’t allow that username.',
      suggestions: 'Available instead',
      checkFailed:
        'Couldn’t check this username. Your choice is kept; try again.',
      renameConsequence: ({ username }: { username: string }) =>
        `Friends find you by the new name, and links or badges that use @${username} stop working.`,
      releaseTitle: 'Release username',
      releaseDetail: ({ username }: { username: string }) =>
        `Friends stop finding you as @${username} and links to your public page stop working. No one can claim @${username} for 30 days, including you.`,
      releaseAction: 'Release',
      releaseFailed: 'Couldn’t release your username. Nothing changed.',
    },
    profile: {
      title: 'Public profile',
      entrySubtitle: 'A page that shows what your agents built',
      searchKeywords: 'public profile, public page, badge, README, share, handle, username, publish',
      purposeIntro:
        'A page that shows what your agents built, at a link you choose.',
      purposePublished: ({ url }: { url: string }) =>
        `How others see your agent usage at ${url}.`,
      openPage: 'Open page',
      invitationTitle: 'Show what your agents built',
      invitationBody:
        'Totals, your activity calendar and your agents, on a page you can link from your README. Nothing is public until you publish, and you choose every field.',
      usernameFirst: 'Your page lives at your username. Choose one to begin.',
      chooseUsername: 'Choose a username',
      yourPage: 'Your page',
      link: 'Link',
      status: 'Status',
      statusPublished: ({ synced }: { synced: string }) =>
        `Published · synced ${synced}`,
      statusPaused: 'Paused · visitors see a paused page',
      syncNow: 'Sync now',
      handle: 'Handle',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · also your username for Friends`,
      change: 'Change',
      whatsPublic: 'What’s public',
      whatsPublicDescription:
        'You choose each item on the page itself. Items you share also appear in badges and the public JSON.',
      period: 'Period',
      periodDetail: ({ range }: { range: string }) =>
        `${range}. Every number, the calendar, badges and card cover the same days.`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${shown} of ${total} items public`,
      teamUsage: 'Team usage',
      teamUsageDetail:
        'Never included. Usage from Team seats, or from a seat that can’t be told apart, stays off your profile.',
      excluded: 'Excluded',
      searchEngines: 'Search engines',
      indexTitle: 'Let search engines index your page',
      indexOff: 'Off: people reach it only through its link',
      indexOn: 'On: search engines may list your page',
      pauseOrRemove: 'Pause or remove',
      pauseTitle: 'Pause profile',
      pauseDetail:
        'Keeps your link and handle; visitors see a paused page until you resume',
      pause: 'Pause',
      resumeTitle: 'Resume profile',
      resumeDetail:
        'Recomputes your page from the same items and shows it again',
      resume: 'Resume',
      unpublishTitle: 'Unpublish',
      unpublishDetail:
        'Deletes the public record. Your page, badges and preview image stop working the next time they’re requested; images already posted elsewhere stay where they are.',
      unpublishAction: 'Unpublish…',
      restrictedTitle: 'Your page was removed',
      restrictedBody: ({ reason }: { reason: string }) =>
        `The operator of this service removed your page: “${reason}”. Contact them to ask about it. Your usage and username are unchanged.`,
      unavailableTitle: 'Public profiles aren’t available here',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} doesn’t offer public profiles. Your usage stays private.`,
      loadFailedTitle: 'Couldn’t load your public profile',
      loadFailedBody: 'Nothing changed. Try again in a moment.',
      retry: 'Try again',
      actionFailed: 'That didn’t go through. Nothing changed.',
      actionUncertain: 'The service didn’t answer. Your page below is what it shows now.',
      savedRefreshPending: 'Saved. The numbers on your page update at the next sync.',
      reasons: {
        feature_disabled: 'Public profiles are turned off on this service.',
        username_required: 'Choose a username first.',
        report_contact_unconfigured:
          'This service hasn’t set a contact for reports yet, so pages can’t be published. Ask its operator.',
        public_ingress_unconfigured:
          'This service hasn’t set a public address yet, so pages can’t be published. Ask its operator.',
        not_published: 'Your page isn’t published.',
        restricted: 'This service’s operator removed your page.',
        query_mismatch:
          'Your usage period changed. Open your page and apply it again.',
        invalid_stored_content:
          'Your public page couldn’t be read. Publish it again.',
        asset_unavailable:
          'Your page’s picture isn’t on this device. Choose it again.',
        usage_unavailable: 'Your usage can’t be read on this device right now.',
        usage_query_result_invalid:
          'Your usage came back incomplete. Try again.',
        project_visibility_unavailable:
          'Couldn’t confirm a project is public. It stays off your page.',
        preparation_unavailable:
          'This device can’t prepare your page right now.',
      },
    },
  },
};

type TranslationShape<T> = T extends (...args: infer Args) => infer Return
  ? (...args: Args) => Return
  : T extends string
    ? string
    : { readonly [K in keyof T]: TranslationShape<T[K]> };

export type PublicIdentityTranslations = TranslationShape<
  typeof publicIdentityEn
>;
