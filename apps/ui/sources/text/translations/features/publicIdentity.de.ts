import type { PublicIdentityTranslations } from '../publicIdentityTranslations.shared';

export const publicIdentity: PublicIdentityTranslations = {
  publicIdentity: {
    handle: {
      available: ({ username }: { username: string }) => `@${username} ist verfügbar`,
      taken: ({ username }: { username: string }) => `@${username} ist vergeben`,
      reserved: ({ username }: { username: string }) => `@${username} ist auf diesem Dienst reserviert`,
      invalid: 'Dieser Dienst erlaubt diesen Benutzernamen nicht.',
      suggestions: 'Stattdessen verfügbar',
      checkFailed: 'Dieser Benutzername konnte nicht geprüft werden. Deine Wahl bleibt erhalten; versuche es erneut.',
      renameConsequence: ({ username }: { username: string }) =>
        `Freunde finden dich unter dem neuen Namen, und Links oder Badges mit @${username} funktionieren nicht mehr.`,
      releaseTitle: 'Benutzernamen freigeben',
      releaseDetail: ({ username }: { username: string }) =>
        `Freunde finden dich nicht mehr als @${username}, und Links zu deiner öffentlichen Seite funktionieren nicht mehr. 30 Tage lang kann niemand @${username} beanspruchen, auch du nicht.`,
      releaseAction: 'Freigeben',
      releaseFailed: 'Dein Benutzername konnte nicht freigegeben werden. Es hat sich nichts geändert.',
    },
    profile: {
      title: 'Öffentliches Profil',
      entrySubtitle: 'Eine Seite, die zeigt, was deine Agenten gebaut haben',
      searchKeywords: 'öffentliches Profil, öffentliche Seite, Badge, README, teilen, Handle, Benutzername, veröffentlichen',
      purposeIntro: 'Eine Seite, die zeigt, was deine Agenten gebaut haben, unter einem Link deiner Wahl.',
      purposePublished: ({ url }: { url: string }) => `So sehen andere deine Agentennutzung unter ${url}.`,
      openPage: 'Seite öffnen',
      invitationTitle: 'Zeig, was deine Agenten gebaut haben',
      invitationBody:
        'Summen, dein Aktivitätskalender und deine Agenten auf einer Seite, die du aus deiner README verlinken kannst. Nichts ist öffentlich, bis du veröffentlichst, und du wählst jedes Feld selbst.',
      usernameFirst: 'Deine Seite liegt unter deinem Benutzernamen. Wähle einen, um zu beginnen.',
      chooseUsername: 'Benutzernamen wählen',
      yourPage: 'Deine Seite',
      link: 'Link',
      status: 'Status',
      statusPublished: ({ synced }: { synced: string }) => `Veröffentlicht · synchronisiert ${synced}`,
      statusPaused: 'Pausiert · Besucher sehen eine pausierte Seite',
      syncNow: 'Jetzt synchronisieren',
      handle: 'Handle',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · auch dein Benutzername für Freunde`,
      change: 'Ändern',
      whatsPublic: 'Was öffentlich ist',
      whatsPublicDescription:
        'Du wählst jedes Element direkt auf der Seite. Geteilte Elemente erscheinen auch in Badges und im öffentlichen JSON.',
      period: 'Zeitraum',
      periodDetail: ({ range }: { range: string }) =>
        `${range}. Jede Zahl, der Kalender, die Badges und die Karte decken dieselben Tage ab.`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${shown} von ${total} Elementen öffentlich`,
      teamUsage: 'Team-Nutzung',
      teamUsageDetail:
        'Nie enthalten. Nutzung über Team-Plätze oder über einen nicht unterscheidbaren Platz bleibt aus deinem Profil heraus.',
      excluded: 'Ausgeschlossen',
      searchEngines: 'Suchmaschinen',
      indexTitle: 'Suchmaschinen deine Seite indexieren lassen',
      indexOff: 'Aus: Leute erreichen sie nur über ihren Link',
      indexOn: 'An: Suchmaschinen dürfen deine Seite listen',
      pauseOrRemove: 'Pausieren oder entfernen',
      pauseTitle: 'Profil pausieren',
      pauseDetail: 'Behält deinen Link und dein Handle; Besucher sehen eine pausierte Seite, bis du fortsetzt',
      pause: 'Pausieren',
      resumeTitle: 'Profil fortsetzen',
      resumeDetail: 'Berechnet deine Seite aus denselben Elementen neu und zeigt sie wieder an',
      resume: 'Fortsetzen',
      unpublishTitle: 'Veröffentlichung aufheben',
      unpublishDetail:
        'Löscht den öffentlichen Eintrag. Deine Seite, Badges und das Vorschaubild funktionieren beim nächsten Abruf nicht mehr; anderswo bereits geteilte Bilder bleiben dort.',
      unpublishAction: 'Veröffentlichung aufheben…',
      restrictedTitle: 'Deine Seite wurde entfernt',
      restrictedBody: ({ reason }: { reason: string }) =>
        `Der Betreiber dieses Dienstes hat deine Seite entfernt: „${reason}“. Wende dich an ihn, um nachzufragen. Deine Nutzung und dein Benutzername bleiben unverändert.`,
      unavailableTitle: 'Öffentliche Profile sind hier nicht verfügbar',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} bietet keine öffentlichen Profile an. Deine Nutzung bleibt privat.`,
      loadFailedTitle: 'Dein öffentliches Profil konnte nicht geladen werden',
      loadFailedBody: 'Es hat sich nichts geändert. Versuche es gleich noch einmal.',
      retry: 'Erneut versuchen',
      actionFailed: 'Das hat nicht geklappt. Es hat sich nichts geändert.',
      actionUncertain: 'Der Dienst hat nicht geantwortet. Deine Seite unten zeigt den aktuellen Stand.',
      savedRefreshPending: 'Gespeichert. Die Zahlen auf deiner Seite werden bei der nächsten Synchronisierung aktualisiert.',
      reasons: {
        feature_disabled: 'Öffentliche Profile sind auf diesem Dienst ausgeschaltet.',
        username_required: 'Wähle zuerst einen Benutzernamen.',
        report_contact_unconfigured:
          'Dieser Dienst hat noch keinen Kontakt für Meldungen festgelegt, daher können keine Seiten veröffentlicht werden. Frag den Betreiber.',
        public_ingress_unconfigured:
          'Dieser Dienst hat noch keine öffentliche Adresse festgelegt, daher können keine Seiten veröffentlicht werden. Frag den Betreiber.',
        not_published: 'Deine Seite ist nicht veröffentlicht.',
        restricted: 'Der Betreiber dieses Dienstes hat deine Seite entfernt.',
        query_mismatch: 'Dein Nutzungszeitraum hat sich geändert. Öffne deine Seite und wende ihn erneut an.',
        invalid_stored_content: 'Deine öffentliche Seite konnte nicht gelesen werden. Veröffentliche sie erneut.',
        asset_unavailable: 'Das Bild deiner Seite ist nicht auf diesem Gerät. Wähle es erneut aus.',
        usage_unavailable: 'Deine Nutzung kann auf diesem Gerät gerade nicht gelesen werden.',
        usage_query_result_invalid: 'Deine Nutzung kam unvollständig zurück. Versuche es erneut.',
        project_visibility_unavailable:
          'Es ließ sich nicht bestätigen, dass ein Projekt öffentlich ist. Es bleibt von deiner Seite ausgeschlossen.',
        preparation_unavailable: 'Dieses Gerät kann deine Seite gerade nicht vorbereiten.',
      },
    },
  },
};
