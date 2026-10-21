import type { PublicIdentityTranslations } from '../publicIdentityTranslations.shared';

export const publicIdentity: PublicIdentityTranslations = {
  publicIdentity: {
    handle: {
      available: ({ username }: { username: string }) => `@${username} està disponible`,
      taken: ({ username }: { username: string }) => `@${username} ja està en ús`,
      reserved: ({ username }: { username: string }) => `@${username} està reservat en aquest servei`,
      invalid: 'Aquest servei no permet aquest nom d’usuari.',
      suggestions: 'Disponibles en lloc seu',
      checkFailed: 'No s’ha pogut comprovar aquest nom d’usuari. La teva elecció es conserva; torna-ho a provar.',
      renameConsequence: ({ username }: { username: string }) =>
        `Els teus amics et trobaran amb el nom nou, i els enllaços o les insígnies que usen @${username} deixaran de funcionar.`,
      releaseTitle: 'Allibera el nom d’usuari',
      releaseDetail: ({ username }: { username: string }) =>
        `Els teus amics deixaran de trobar-te com a @${username} i els enllaços a la teva pàgina pública deixaran de funcionar. Ningú podrà reclamar @${username} durant 30 dies, tu inclòs.`,
      releaseAction: 'Allibera',
      releaseFailed: 'No s’ha pogut alliberar el teu nom d’usuari. No ha canviat res.',
    },
    profile: {
      title: 'Perfil públic',
      entrySubtitle: 'Una pàgina que mostra el que han construït els teus agents',
      searchKeywords: 'perfil públic, pàgina pública, insígnia, README, compartir, identificador, nom d’usuari, publicar',
      purposeIntro: 'Una pàgina que mostra el que han construït els teus agents, en un enllaç que tries.',
      purposePublished: ({ url }: { url: string }) => `Així veuen els altres l’ús que fas dels agents a ${url}.`,
      openPage: 'Obre la pàgina',
      invitationTitle: 'Mostra el que han construït els teus agents',
      invitationBody:
        'Totals, el teu calendari d’activitat i els teus agents, en una pàgina que pots enllaçar des del teu README. Res és públic fins que publiques, i tu tries cada camp.',
      usernameFirst: 'La teva pàgina viu al teu nom d’usuari. Tria’n un per començar.',
      chooseUsername: 'Tria un nom d’usuari',
      yourPage: 'La teva pàgina',
      link: 'Enllaç',
      status: 'Estat',
      statusPublished: ({ synced }: { synced: string }) => `Publicada · sincronitzada ${synced}`,
      statusPaused: 'En pausa · els visitants veuen una pàgina en pausa',
      syncNow: 'Sincronitza ara',
      handle: 'Identificador',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · també el teu nom d’usuari per a Amics`,
      change: 'Canvia',
      whatsPublic: 'Què és públic',
      whatsPublicDescription:
        'Tries cada element a la pàgina mateixa. Els elements que comparteixes també apareixen a les insígnies i al JSON públic.',
      period: 'Període',
      periodDetail: ({ range }: { range: string }) =>
        `${range}. Cada xifra, el calendari, les insígnies i la targeta cobreixen els mateixos dies.`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${shown} de ${total} elements públics`,
      teamUsage: 'Ús de l’equip',
      teamUsageDetail:
        'Mai s’inclou. L’ús de places d’equip, o d’una plaça que no es pot distingir, queda fora del teu perfil.',
      excluded: 'Exclòs',
      searchEngines: 'Motors de cerca',
      indexTitle: 'Deixa que els motors de cerca indexin la teva pàgina',
      indexOff: 'Desactivat: només s’hi arriba pel seu enllaç',
      indexOn: 'Activat: els motors de cerca poden llistar la teva pàgina',
      pauseOrRemove: 'Posa en pausa o elimina',
      pauseTitle: 'Posa el perfil en pausa',
      pauseDetail: 'Conserva el teu enllaç i identificador; els visitants veuen una pàgina en pausa fins que el represis',
      pause: 'Posa en pausa',
      resumeTitle: 'Reprèn el perfil',
      resumeDetail: 'Recalcula la teva pàgina amb els mateixos elements i la torna a mostrar',
      resume: 'Reprèn',
      unpublishTitle: 'Deixa de publicar',
      unpublishDetail:
        'Elimina el registre públic. La teva pàgina, les insígnies i la imatge de vista prèvia deixaran de funcionar la propera vegada que se sol·licitin; les imatges ja publicades en altres llocs hi romanen.',
      unpublishAction: 'Deixa de publicar…',
      restrictedTitle: 'S’ha eliminat la teva pàgina',
      restrictedBody: ({ reason }: { reason: string }) =>
        `L’operador d’aquest servei ha eliminat la teva pàgina: «${reason}». Posa’t en contacte amb ell per consultar-ho. El teu ús i el teu nom d’usuari no han canviat.`,
      unavailableTitle: 'Els perfils públics no estan disponibles aquí',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} no ofereix perfils públics. El teu ús continua sent privat.`,
      loadFailedTitle: 'No s’ha pogut carregar el teu perfil públic',
      loadFailedBody: 'No ha canviat res. Torna-ho a provar d’aquí a un moment.',
      retry: 'Torna-ho a provar',
      actionFailed: 'No s’ha completat. No ha canviat res.',
      actionUncertain: 'El servei no ha respost. La teva pàgina de sota és el que mostra ara.',
      savedRefreshPending: 'Desat. Les xifres de la teva pàgina s’actualitzen a la propera sincronització.',
      reasons: {
        feature_disabled: 'Els perfils públics estan desactivats en aquest servei.',
        username_required: 'Tria primer un nom d’usuari.',
        report_contact_unconfigured:
          'Aquest servei encara no ha definit un contacte per a denúncies, així que no es poden publicar pàgines. Consulta-ho amb el seu operador.',
        public_ingress_unconfigured:
          'Aquest servei encara no ha definit una adreça pública, així que no es poden publicar pàgines. Consulta-ho amb el seu operador.',
        not_published: 'La teva pàgina no està publicada.',
        restricted: 'L’operador d’aquest servei ha eliminat la teva pàgina.',
        query_mismatch: 'El teu període d’ús ha canviat. Obre la teva pàgina i torna’l a aplicar.',
        invalid_stored_content: 'No s’ha pogut llegir la teva pàgina pública. Torna-la a publicar.',
        asset_unavailable: 'La imatge de la teva pàgina no és en aquest dispositiu. Torna-la a triar.',
        usage_unavailable: 'El teu ús no es pot llegir en aquest dispositiu ara mateix.',
        usage_query_result_invalid: 'El teu ús ha arribat incomplet. Torna-ho a provar.',
        project_visibility_unavailable:
          'No s’ha pogut confirmar que un projecte és públic. Es queda fora de la teva pàgina.',
        preparation_unavailable: 'Aquest dispositiu no pot preparar la teva pàgina ara mateix.',
      },
    },
  },
};
