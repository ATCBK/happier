import type { PublicIdentityTranslations } from '../publicIdentityTranslations.shared';

export const publicIdentity: PublicIdentityTranslations = {
  publicIdentity: {
    handle: {
      available: ({ username }: { username: string }) => `@${username} está disponible`,
      taken: ({ username }: { username: string }) => `@${username} ya está en uso`,
      reserved: ({ username }: { username: string }) => `@${username} está reservado en este servicio`,
      invalid: 'Este servicio no permite ese nombre de usuario.',
      suggestions: 'Disponibles en su lugar',
      checkFailed: 'No se pudo comprobar este nombre de usuario. Tu elección se conserva; inténtalo de nuevo.',
      renameConsequence: ({ username }: { username: string }) =>
        `Tus amigos te encuentran con el nuevo nombre, y los enlaces o insignias que usan @${username} dejan de funcionar.`,
      releaseTitle: 'Liberar nombre de usuario',
      releaseDetail: ({ username }: { username: string }) =>
        `Tus amigos dejarán de encontrarte como @${username} y los enlaces a tu página pública dejarán de funcionar. Nadie podrá reclamar @${username} durante 30 días, tú incluido.`,
      releaseAction: 'Liberar',
      releaseFailed: 'No se pudo liberar tu nombre de usuario. No cambió nada.',
    },
    profile: {
      title: 'Perfil público',
      entrySubtitle: 'Una página que muestra lo que construyeron tus agentes',
      searchKeywords: 'perfil público, página pública, insignia, README, compartir, identificador, nombre de usuario, publicar',
      purposeIntro: 'Una página que muestra lo que construyeron tus agentes, en un enlace que eliges.',
      purposePublished: ({ url }: { url: string }) => `Así ven otros tu uso de agentes en ${url}.`,
      openPage: 'Abrir página',
      invitationTitle: 'Muestra lo que construyeron tus agentes',
      invitationBody:
        'Totales, tu calendario de actividad y tus agentes, en una página que puedes enlazar desde tu README. Nada es público hasta que publiques, y tú eliges cada campo.',
      usernameFirst: 'Tu página vive en tu nombre de usuario. Elige uno para empezar.',
      chooseUsername: 'Elegir un nombre de usuario',
      yourPage: 'Tu página',
      link: 'Enlace',
      status: 'Estado',
      statusPublished: ({ synced }: { synced: string }) => `Publicada · sincronizada ${synced}`,
      statusPaused: 'En pausa · los visitantes ven una página en pausa',
      syncNow: 'Sincronizar ahora',
      handle: 'Identificador',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · también tu nombre de usuario para Amigos`,
      change: 'Cambiar',
      whatsPublic: 'Qué es público',
      whatsPublicDescription:
        'Eliges cada elemento en la propia página. Los elementos que compartes también aparecen en las insignias y en el JSON público.',
      period: 'Periodo',
      periodDetail: ({ range }: { range: string }) =>
        `${range}. Cada cifra, el calendario, las insignias y la tarjeta cubren los mismos días.`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${shown} de ${total} elementos públicos`,
      teamUsage: 'Uso del equipo',
      teamUsageDetail:
        'Nunca se incluye. El uso de plazas de equipo, o de una plaza que no se puede distinguir, queda fuera de tu perfil.',
      excluded: 'Excluido',
      searchEngines: 'Motores de búsqueda',
      indexTitle: 'Permitir que los motores de búsqueda indexen tu página',
      indexOff: 'Desactivado: solo se llega a ella por su enlace',
      indexOn: 'Activado: los motores de búsqueda pueden listar tu página',
      pauseOrRemove: 'Pausar o eliminar',
      pauseTitle: 'Pausar perfil',
      pauseDetail: 'Conserva tu enlace e identificador; los visitantes ven una página en pausa hasta que reanudes',
      pause: 'Pausar',
      resumeTitle: 'Reanudar perfil',
      resumeDetail: 'Recalcula tu página con los mismos elementos y la muestra de nuevo',
      resume: 'Reanudar',
      unpublishTitle: 'Despublicar',
      unpublishDetail:
        'Elimina el registro público. Tu página, insignias e imagen de vista previa dejan de funcionar la próxima vez que se soliciten; las imágenes ya publicadas en otros sitios se quedan donde están.',
      unpublishAction: 'Despublicar…',
      restrictedTitle: 'Se eliminó tu página',
      restrictedBody: ({ reason }: { reason: string }) =>
        `El operador de este servicio eliminó tu página: «${reason}». Ponte en contacto con él para consultarlo. Tu uso y tu nombre de usuario no han cambiado.`,
      unavailableTitle: 'Los perfiles públicos no están disponibles aquí',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} no ofrece perfiles públicos. Tu uso sigue siendo privado.`,
      loadFailedTitle: 'No se pudo cargar tu perfil público',
      loadFailedBody: 'No cambió nada. Inténtalo de nuevo en un momento.',
      retry: 'Reintentar',
      actionFailed: 'No se completó. No cambió nada.',
      actionUncertain: 'El servicio no respondió. Tu página de abajo es lo que muestra ahora.',
      savedRefreshPending: 'Guardado. Las cifras de tu página se actualizan en la próxima sincronización.',
      reasons: {
        feature_disabled: 'Los perfiles públicos están desactivados en este servicio.',
        username_required: 'Elige primero un nombre de usuario.',
        report_contact_unconfigured:
          'Este servicio aún no ha definido un contacto para denuncias, así que no se pueden publicar páginas. Consulta con su operador.',
        public_ingress_unconfigured:
          'Este servicio aún no ha definido una dirección pública, así que no se pueden publicar páginas. Consulta con su operador.',
        not_published: 'Tu página no está publicada.',
        restricted: 'El operador de este servicio eliminó tu página.',
        query_mismatch: 'Cambió tu periodo de uso. Abre tu página y vuelve a aplicarlo.',
        invalid_stored_content: 'No se pudo leer tu página pública. Vuelve a publicarla.',
        asset_unavailable: 'La imagen de tu página no está en este dispositivo. Elígela de nuevo.',
        usage_unavailable: 'Tu uso no se puede leer en este dispositivo ahora mismo.',
        usage_query_result_invalid: 'Tu uso llegó incompleto. Inténtalo de nuevo.',
        project_visibility_unavailable:
          'No se pudo confirmar que un proyecto es público. Se queda fuera de tu página.',
        preparation_unavailable: 'Este dispositivo no puede preparar tu página ahora mismo.',
      },
    },
  },
};
