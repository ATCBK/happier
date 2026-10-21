import type { PublicIdentityTranslations } from '../publicIdentityTranslations.shared';

export const publicIdentity: PublicIdentityTranslations = {
  publicIdentity: {
    handle: {
      available: ({ username }: { username: string }) => `@${username} jest dostępna`,
      taken: ({ username }: { username: string }) => `@${username} jest zajęta`,
      reserved: ({ username }: { username: string }) => `@${username} jest zarezerwowana w tej usłudze`,
      invalid: 'Ta usługa nie zezwala na taką nazwę użytkownika.',
      suggestions: 'Dostępne zamiast tego',
      checkFailed: 'Nie udało się sprawdzić tej nazwy użytkownika. Twój wybór został zachowany; spróbuj ponownie.',
      renameConsequence: ({ username }: { username: string }) =>
        `Znajomi znajdą Cię pod nową nazwą, a linki lub odznaki używające @${username} przestaną działać.`,
      releaseTitle: 'Zwolnij nazwę użytkownika',
      releaseDetail: ({ username }: { username: string }) =>
        `Znajomi nie znajdą Cię już jako @${username}, a linki do Twojej strony publicznej przestaną działać. Przez 30 dni nikt nie może zająć @${username}, Ty także.`,
      releaseAction: 'Zwolnij',
      releaseFailed: 'Nie udało się zwolnić Twojej nazwy użytkownika. Nic się nie zmieniło.',
    },
    profile: {
      title: 'Profil publiczny',
      entrySubtitle: 'Strona pokazująca, co zbudowali Twoi agenci',
      searchKeywords: 'profil publiczny, strona publiczna, odznaka, README, udostępnij, uchwyt, nazwa użytkownika, opublikuj',
      purposeIntro: 'Strona pokazująca, co zbudowali Twoi agenci, pod wybranym przez Ciebie linkiem.',
      purposePublished: ({ url }: { url: string }) => `Tak inni widzą Twoje użycie agentów pod adresem ${url}.`,
      openPage: 'Otwórz stronę',
      invitationTitle: 'Pokaż, co zbudowali Twoi agenci',
      invitationBody:
        'Sumy, kalendarz aktywności i Twoi agenci na stronie, którą możesz podlinkować z README. Nic nie jest publiczne, dopóki nie opublikujesz, a każde pole wybierasz sam.',
      usernameFirst: 'Twoja strona działa pod Twoją nazwą użytkownika. Wybierz ją, aby zacząć.',
      chooseUsername: 'Wybierz nazwę użytkownika',
      yourPage: 'Twoja strona',
      link: 'Link',
      status: 'Status',
      statusPublished: ({ synced }: { synced: string }) => `Opublikowana · zsynchronizowana ${synced}`,
      statusPaused: 'Wstrzymana · odwiedzający widzą wstrzymaną stronę',
      syncNow: 'Synchronizuj teraz',
      handle: 'Uchwyt',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · to także Twoja nazwa użytkownika dla Znajomych`,
      change: 'Zmień',
      whatsPublic: 'Co jest publiczne',
      whatsPublicDescription:
        'Każdy element wybierasz na samej stronie. Udostępnione elementy pojawiają się też w odznakach i w publicznym JSON.',
      period: 'Okres',
      periodDetail: ({ range }: { range: string }) =>
        `${range}. Każda liczba, kalendarz, odznaki i karta obejmują te same dni.`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${shown} z ${total} elementów publicznych`,
      teamUsage: 'Użycie zespołu',
      teamUsageDetail:
        'Nigdy nie jest uwzględniane. Użycie z miejsc w zespole lub z miejsca, którego nie da się odróżnić, nie trafia do Twojego profilu.',
      excluded: 'Wykluczone',
      searchEngines: 'Wyszukiwarki',
      indexTitle: 'Pozwól wyszukiwarkom indeksować Twoją stronę',
      indexOff: 'Wyłączone: ludzie docierają do niej tylko przez link',
      indexOn: 'Włączone: wyszukiwarki mogą wyświetlać Twoją stronę',
      pauseOrRemove: 'Wstrzymaj lub usuń',
      pauseTitle: 'Wstrzymaj profil',
      pauseDetail: 'Zachowuje Twój link i uchwyt; odwiedzający widzą wstrzymaną stronę do czasu wznowienia',
      pause: 'Wstrzymaj',
      resumeTitle: 'Wznów profil',
      resumeDetail: 'Przelicza Twoją stronę z tych samych elementów i pokazuje ją ponownie',
      resume: 'Wznów',
      unpublishTitle: 'Cofnij publikację',
      unpublishDetail:
        'Usuwa publiczny wpis. Twoja strona, odznaki i obraz podglądu przestaną działać przy następnym żądaniu; obrazy opublikowane już gdzie indziej tam pozostaną.',
      unpublishAction: 'Cofnij publikację…',
      restrictedTitle: 'Twoja strona została usunięta',
      restrictedBody: ({ reason }: { reason: string }) =>
        `Operator tej usługi usunął Twoją stronę: „${reason}”. Skontaktuj się z nim, aby o to zapytać. Twoje użycie i nazwa użytkownika pozostają bez zmian.`,
      unavailableTitle: 'Profile publiczne nie są tu dostępne',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} nie oferuje profili publicznych. Twoje użycie pozostaje prywatne.`,
      loadFailedTitle: 'Nie udało się wczytać Twojego profilu publicznego',
      loadFailedBody: 'Nic się nie zmieniło. Spróbuj ponownie za chwilę.',
      retry: 'Spróbuj ponownie',
      actionFailed: 'To się nie udało. Nic się nie zmieniło.',
      actionUncertain: 'Usługa nie odpowiedziała. Twoja strona poniżej to to, co pokazuje teraz.',
      savedRefreshPending: 'Zapisano. Liczby na Twojej stronie zaktualizują się przy następnej synchronizacji.',
      reasons: {
        feature_disabled: 'Profile publiczne są wyłączone w tej usłudze.',
        username_required: 'Najpierw wybierz nazwę użytkownika.',
        report_contact_unconfigured:
          'Ta usługa nie ustawiła jeszcze kontaktu do zgłoszeń, więc nie można publikować stron. Zapytaj jej operatora.',
        public_ingress_unconfigured:
          'Ta usługa nie ustawiła jeszcze publicznego adresu, więc nie można publikować stron. Zapytaj jej operatora.',
        not_published: 'Twoja strona nie jest opublikowana.',
        restricted: 'Operator tej usługi usunął Twoją stronę.',
        query_mismatch: 'Okres Twojego użycia się zmienił. Otwórz swoją stronę i zastosuj go ponownie.',
        invalid_stored_content: 'Nie udało się odczytać Twojej strony publicznej. Opublikuj ją ponownie.',
        asset_unavailable: 'Obrazu Twojej strony nie ma na tym urządzeniu. Wybierz go ponownie.',
        usage_unavailable: 'Twojego użycia nie można teraz odczytać na tym urządzeniu.',
        usage_query_result_invalid: 'Twoje użycie wróciło niekompletne. Spróbuj ponownie.',
        project_visibility_unavailable:
          'Nie udało się potwierdzić, że projekt jest publiczny. Pozostaje poza Twoją stroną.',
        preparation_unavailable: 'To urządzenie nie może teraz przygotować Twojej strony.',
      },
    },
  },
};
