import type { PublicIdentityTranslations } from '../publicIdentityTranslations.shared';

export const publicIdentity: PublicIdentityTranslations = {
  publicIdentity: {
    handle: {
      available: ({ username }: { username: string }) => `@${username} è disponibile`,
      taken: ({ username }: { username: string }) => `@${username} è già in uso`,
      reserved: ({ username }: { username: string }) => `@${username} è riservato su questo servizio`,
      invalid: 'Questo servizio non consente quel nome utente.',
      suggestions: 'Disponibili in alternativa',
      checkFailed: 'Impossibile controllare questo nome utente. La tua scelta è conservata; riprova.',
      renameConsequence: ({ username }: { username: string }) =>
        `I tuoi amici ti trovano con il nuovo nome, e i link o i badge che usano @${username} smettono di funzionare.`,
      releaseTitle: 'Rilascia il nome utente',
      releaseDetail: ({ username }: { username: string }) =>
        `I tuoi amici non ti troveranno più come @${username} e i link alla tua pagina pubblica smetteranno di funzionare. Nessuno potrà rivendicare @${username} per 30 giorni, nemmeno tu.`,
      releaseAction: 'Rilascia',
      releaseFailed: 'Impossibile rilasciare il tuo nome utente. Non è cambiato nulla.',
    },
    profile: {
      title: 'Profilo pubblico',
      entrySubtitle: 'Una pagina che mostra ciò che hanno costruito i tuoi agenti',
      searchKeywords: 'profilo pubblico, pagina pubblica, badge, README, condividi, handle, nome utente, pubblica',
      purposeIntro: 'Una pagina che mostra ciò che hanno costruito i tuoi agenti, a un link che scegli tu.',
      purposePublished: ({ url }: { url: string }) => `Così gli altri vedono il tuo uso degli agenti su ${url}.`,
      openPage: 'Apri la pagina',
      invitationTitle: 'Mostra ciò che hanno costruito i tuoi agenti',
      invitationBody:
        'Totali, calendario delle attività e agenti, su una pagina che puoi linkare dal tuo README. Nulla è pubblico finché non pubblichi, e scegli tu ogni campo.',
      usernameFirst: 'La tua pagina vive sul tuo nome utente. Scegline uno per iniziare.',
      chooseUsername: 'Scegli un nome utente',
      yourPage: 'La tua pagina',
      link: 'Link',
      status: 'Stato',
      statusPublished: ({ synced }: { synced: string }) => `Pubblicata · sincronizzata ${synced}`,
      statusPaused: 'In pausa · i visitatori vedono una pagina in pausa',
      syncNow: 'Sincronizza ora',
      handle: 'Handle',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · anche il tuo nome utente per Amici`,
      change: 'Cambia',
      whatsPublic: 'Cosa è pubblico',
      whatsPublicDescription:
        'Scegli ogni elemento sulla pagina stessa. Gli elementi che condividi compaiono anche nei badge e nel JSON pubblico.',
      period: 'Periodo',
      periodDetail: ({ range }: { range: string }) =>
        `${range}. Ogni numero, il calendario, i badge e la scheda coprono gli stessi giorni.`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${shown} elementi pubblici su ${total}`,
      teamUsage: 'Uso del team',
      teamUsageDetail:
        'Mai incluso. L’uso dei posti del team, o di un posto non distinguibile, resta fuori dal tuo profilo.',
      excluded: 'Esclusi',
      searchEngines: 'Motori di ricerca',
      indexTitle: 'Lascia che i motori di ricerca indicizzino la tua pagina',
      indexOff: 'No: ci si arriva solo tramite il suo link',
      indexOn: 'Sì: i motori di ricerca possono elencare la tua pagina',
      pauseOrRemove: 'Metti in pausa o rimuovi',
      pauseTitle: 'Metti in pausa il profilo',
      pauseDetail: 'Mantiene il tuo link e il tuo handle; i visitatori vedono una pagina in pausa finché non riprendi',
      pause: 'Metti in pausa',
      resumeTitle: 'Riprendi il profilo',
      resumeDetail: 'Ricalcola la tua pagina dagli stessi elementi e la mostra di nuovo',
      resume: 'Riprendi',
      unpublishTitle: 'Annulla la pubblicazione',
      unpublishDetail:
        'Elimina il record pubblico. La tua pagina, i badge e l’immagine di anteprima smettono di funzionare alla prossima richiesta; le immagini già pubblicate altrove restano dove sono.',
      unpublishAction: 'Annulla la pubblicazione…',
      restrictedTitle: 'La tua pagina è stata rimossa',
      restrictedBody: ({ reason }: { reason: string }) =>
        `L’operatore di questo servizio ha rimosso la tua pagina: «${reason}». Contattalo per chiedere chiarimenti. Il tuo uso e il tuo nome utente non sono cambiati.`,
      unavailableTitle: 'I profili pubblici non sono disponibili qui',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} non offre profili pubblici. Il tuo uso resta privato.`,
      loadFailedTitle: 'Impossibile caricare il tuo profilo pubblico',
      loadFailedBody: 'Non è cambiato nulla. Riprova tra un momento.',
      retry: 'Riprova',
      actionFailed: 'Non è andata a buon fine. Non è cambiato nulla.',
      actionUncertain: 'Il servizio non ha risposto. La tua pagina qui sotto è ciò che mostra ora.',
      savedRefreshPending: 'Salvato. I numeri della tua pagina si aggiornano alla prossima sincronizzazione.',
      reasons: {
        feature_disabled: 'I profili pubblici sono disattivati su questo servizio.',
        username_required: 'Scegli prima un nome utente.',
        report_contact_unconfigured:
          'Questo servizio non ha ancora impostato un contatto per le segnalazioni, quindi le pagine non possono essere pubblicate. Chiedi al suo operatore.',
        public_ingress_unconfigured:
          'Questo servizio non ha ancora impostato un indirizzo pubblico, quindi le pagine non possono essere pubblicate. Chiedi al suo operatore.',
        not_published: 'La tua pagina non è pubblicata.',
        restricted: 'L’operatore di questo servizio ha rimosso la tua pagina.',
        query_mismatch: 'Il periodo di uso è cambiato. Apri la tua pagina e applicalo di nuovo.',
        invalid_stored_content: 'Impossibile leggere la tua pagina pubblica. Pubblicala di nuovo.',
        asset_unavailable: 'L’immagine della tua pagina non è su questo dispositivo. Scegliila di nuovo.',
        usage_unavailable: 'Il tuo uso non può essere letto su questo dispositivo in questo momento.',
        usage_query_result_invalid: 'Il tuo uso è arrivato incompleto. Riprova.',
        project_visibility_unavailable:
          'Impossibile confermare che un progetto sia pubblico. Resta fuori dalla tua pagina.',
        preparation_unavailable: 'Questo dispositivo non può preparare la tua pagina in questo momento.',
      },
    },
  },
};
