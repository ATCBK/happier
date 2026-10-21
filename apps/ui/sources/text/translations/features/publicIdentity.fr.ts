import type { PublicIdentityTranslations } from '../publicIdentityTranslations.shared';

export const publicIdentity: PublicIdentityTranslations = {
  publicIdentity: {
    handle: {
      available: ({ username }: { username: string }) => `@${username} est disponible`,
      taken: ({ username }: { username: string }) => `@${username} est déjà pris`,
      reserved: ({ username }: { username: string }) => `@${username} est réservé sur ce service`,
      invalid: 'Ce service n’autorise pas ce nom d’utilisateur.',
      suggestions: 'Disponibles à la place',
      checkFailed: 'Impossible de vérifier ce nom d’utilisateur. Ton choix est conservé ; réessaie.',
      renameConsequence: ({ username }: { username: string }) =>
        `Tes amis te trouvent avec le nouveau nom, et les liens ou badges qui utilisent @${username} cessent de fonctionner.`,
      releaseTitle: 'Libérer le nom d’utilisateur',
      releaseDetail: ({ username }: { username: string }) =>
        `Tes amis ne te trouveront plus sous @${username} et les liens vers ta page publique cesseront de fonctionner. Personne ne pourra réclamer @${username} pendant 30 jours, toi compris.`,
      releaseAction: 'Libérer',
      releaseFailed: 'Impossible de libérer ton nom d’utilisateur. Rien n’a changé.',
    },
    profile: {
      title: 'Profil public',
      entrySubtitle: 'Une page qui montre ce que tes agents ont construit',
      searchKeywords: 'profil public, page publique, badge, README, partager, identifiant, nom d’utilisateur, publier',
      purposeIntro: 'Une page qui montre ce que tes agents ont construit, à un lien de ton choix.',
      purposePublished: ({ url }: { url: string }) => `Voici comment les autres voient ton usage des agents sur ${url}.`,
      openPage: 'Ouvrir la page',
      invitationTitle: 'Montre ce que tes agents ont construit',
      invitationBody:
        'Totaux, calendrier d’activité et agents, sur une page que tu peux lier depuis ton README. Rien n’est public tant que tu ne publies pas, et tu choisis chaque champ.',
      usernameFirst: 'Ta page vit à ton nom d’utilisateur. Choisis-en un pour commencer.',
      chooseUsername: 'Choisir un nom d’utilisateur',
      yourPage: 'Ta page',
      link: 'Lien',
      status: 'Statut',
      statusPublished: ({ synced }: { synced: string }) => `Publiée · synchronisée ${synced}`,
      statusPaused: 'En pause · les visiteurs voient une page en pause',
      syncNow: 'Synchroniser maintenant',
      handle: 'Identifiant',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · aussi ton nom d’utilisateur pour Amis`,
      change: 'Modifier',
      whatsPublic: 'Ce qui est public',
      whatsPublicDescription:
        'Tu choisis chaque élément sur la page elle-même. Les éléments partagés apparaissent aussi dans les badges et le JSON public.',
      period: 'Période',
      periodDetail: ({ range }: { range: string }) =>
        `${range}. Chaque chiffre, le calendrier, les badges et la carte couvrent les mêmes jours.`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${shown} éléments publics sur ${total}`,
      teamUsage: 'Usage de l’équipe',
      teamUsageDetail:
        'Jamais inclus. L’usage des places d’équipe, ou d’une place impossible à distinguer, reste hors de ton profil.',
      excluded: 'Exclus',
      searchEngines: 'Moteurs de recherche',
      indexTitle: 'Laisser les moteurs de recherche indexer ta page',
      indexOff: 'Désactivé : on n’y accède que par son lien',
      indexOn: 'Activé : les moteurs de recherche peuvent lister ta page',
      pauseOrRemove: 'Mettre en pause ou retirer',
      pauseTitle: 'Mettre le profil en pause',
      pauseDetail: 'Conserve ton lien et ton identifiant ; les visiteurs voient une page en pause jusqu’à la reprise',
      pause: 'Mettre en pause',
      resumeTitle: 'Reprendre le profil',
      resumeDetail: 'Recalcule ta page à partir des mêmes éléments et l’affiche de nouveau',
      resume: 'Reprendre',
      unpublishTitle: 'Dépublier',
      unpublishDetail:
        'Supprime l’enregistrement public. Ta page, tes badges et l’image d’aperçu cesseront de fonctionner à leur prochaine requête ; les images déjà publiées ailleurs y restent.',
      unpublishAction: 'Dépublier…',
      restrictedTitle: 'Ta page a été retirée',
      restrictedBody: ({ reason }: { reason: string }) =>
        `L’opérateur de ce service a retiré ta page : « ${reason} ». Contacte-le pour en savoir plus. Ton usage et ton nom d’utilisateur sont inchangés.`,
      unavailableTitle: 'Les profils publics ne sont pas disponibles ici',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} ne propose pas de profils publics. Ton usage reste privé.`,
      loadFailedTitle: 'Impossible de charger ton profil public',
      loadFailedBody: 'Rien n’a changé. Réessaie dans un instant.',
      retry: 'Réessayer',
      actionFailed: 'Cela n’a pas abouti. Rien n’a changé.',
      actionUncertain: 'Le service n’a pas répondu. Ta page ci-dessous est ce qu’il affiche actuellement.',
      savedRefreshPending: 'Enregistré. Les chiffres de ta page se mettent à jour à la prochaine synchronisation.',
      reasons: {
        feature_disabled: 'Les profils publics sont désactivés sur ce service.',
        username_required: 'Choisis d’abord un nom d’utilisateur.',
        report_contact_unconfigured:
          'Ce service n’a pas encore défini de contact pour les signalements, les pages ne peuvent donc pas être publiées. Demande à son opérateur.',
        public_ingress_unconfigured:
          'Ce service n’a pas encore défini d’adresse publique, les pages ne peuvent donc pas être publiées. Demande à son opérateur.',
        not_published: 'Ta page n’est pas publiée.',
        restricted: 'L’opérateur de ce service a retiré ta page.',
        query_mismatch: 'Ta période d’usage a changé. Ouvre ta page et applique-la de nouveau.',
        invalid_stored_content: 'Ta page publique n’a pas pu être lue. Publie-la de nouveau.',
        asset_unavailable: 'L’image de ta page n’est pas sur cet appareil. Choisis-la de nouveau.',
        usage_unavailable: 'Ton usage ne peut pas être lu sur cet appareil pour le moment.',
        usage_query_result_invalid: 'Ton usage est revenu incomplet. Réessaie.',
        project_visibility_unavailable:
          'Impossible de confirmer qu’un projet est public. Il reste hors de ta page.',
        preparation_unavailable: 'Cet appareil ne peut pas préparer ta page pour le moment.',
      },
    },
  },
};
