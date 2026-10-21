import type { PublicIdentityTranslations } from '../publicIdentityTranslations.shared';

export const publicIdentity: PublicIdentityTranslations = {
  publicIdentity: {
    handle: {
      available: ({ username }: { username: string }) => `@${username} está disponível`,
      taken: ({ username }: { username: string }) => `@${username} já está em uso`,
      reserved: ({ username }: { username: string }) => `@${username} está reservado neste serviço`,
      invalid: 'Este serviço não permite esse nome de usuário.',
      suggestions: 'Disponíveis em vez disso',
      checkFailed: 'Não foi possível verificar este nome de usuário. Sua escolha foi mantida; tente de novo.',
      renameConsequence: ({ username }: { username: string }) =>
        `Seus amigos encontram você pelo novo nome, e links ou selos que usam @${username} param de funcionar.`,
      releaseTitle: 'Liberar nome de usuário',
      releaseDetail: ({ username }: { username: string }) =>
        `Seus amigos deixam de encontrar você como @${username} e os links para sua página pública param de funcionar. Ninguém poderá reivindicar @${username} por 30 dias, nem você.`,
      releaseAction: 'Liberar',
      releaseFailed: 'Não foi possível liberar seu nome de usuário. Nada mudou.',
    },
    profile: {
      title: 'Perfil público',
      entrySubtitle: 'Uma página que mostra o que seus agentes construíram',
      searchKeywords: 'perfil público, página pública, selo, README, compartilhar, identificador, nome de usuário, publicar',
      purposeIntro: 'Uma página que mostra o que seus agentes construíram, em um link que você escolhe.',
      purposePublished: ({ url }: { url: string }) => `É assim que os outros veem seu uso de agentes em ${url}.`,
      openPage: 'Abrir página',
      invitationTitle: 'Mostre o que seus agentes construíram',
      invitationBody:
        'Totais, seu calendário de atividade e seus agentes, em uma página que você pode linkar do seu README. Nada é público até você publicar, e você escolhe cada campo.',
      usernameFirst: 'Sua página fica no seu nome de usuário. Escolha um para começar.',
      chooseUsername: 'Escolher um nome de usuário',
      yourPage: 'Sua página',
      link: 'Link',
      status: 'Status',
      statusPublished: ({ synced }: { synced: string }) => `Publicada · sincronizada ${synced}`,
      statusPaused: 'Pausada · os visitantes veem uma página pausada',
      syncNow: 'Sincronizar agora',
      handle: 'Identificador',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · também seu nome de usuário para Amigos`,
      change: 'Alterar',
      whatsPublic: 'O que é público',
      whatsPublicDescription:
        'Você escolhe cada item na própria página. Os itens que você compartilha também aparecem nos selos e no JSON público.',
      period: 'Período',
      periodDetail: ({ range }: { range: string }) =>
        `${range}. Cada número, o calendário, os selos e o cartão cobrem os mesmos dias.`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${shown} de ${total} itens públicos`,
      teamUsage: 'Uso da equipe',
      teamUsageDetail:
        'Nunca incluído. O uso de vagas da equipe, ou de uma vaga que não dá para distinguir, fica fora do seu perfil.',
      excluded: 'Excluídos',
      searchEngines: 'Mecanismos de busca',
      indexTitle: 'Permitir que mecanismos de busca indexem sua página',
      indexOff: 'Desligado: as pessoas só chegam a ela pelo link',
      indexOn: 'Ligado: mecanismos de busca podem listar sua página',
      pauseOrRemove: 'Pausar ou remover',
      pauseTitle: 'Pausar perfil',
      pauseDetail: 'Mantém seu link e identificador; os visitantes veem uma página pausada até você retomar',
      pause: 'Pausar',
      resumeTitle: 'Retomar perfil',
      resumeDetail: 'Recalcula sua página a partir dos mesmos itens e a mostra de novo',
      resume: 'Retomar',
      unpublishTitle: 'Despublicar',
      unpublishDetail:
        'Exclui o registro público. Sua página, selos e imagem de pré-visualização param de funcionar na próxima vez que forem solicitados; imagens já publicadas em outros lugares continuam lá.',
      unpublishAction: 'Despublicar…',
      restrictedTitle: 'Sua página foi removida',
      restrictedBody: ({ reason }: { reason: string }) =>
        `O operador deste serviço removeu sua página: “${reason}”. Entre em contato com ele para saber mais. Seu uso e seu nome de usuário não mudaram.`,
      unavailableTitle: 'Perfis públicos não estão disponíveis aqui',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} não oferece perfis públicos. Seu uso continua privado.`,
      loadFailedTitle: 'Não foi possível carregar seu perfil público',
      loadFailedBody: 'Nada mudou. Tente de novo em instantes.',
      retry: 'Tentar de novo',
      actionFailed: 'Isso não deu certo. Nada mudou.',
      actionUncertain: 'O serviço não respondeu. Sua página abaixo é o que ele mostra agora.',
      savedRefreshPending: 'Salvo. Os números da sua página são atualizados na próxima sincronização.',
      reasons: {
        feature_disabled: 'Perfis públicos estão desativados neste serviço.',
        username_required: 'Escolha um nome de usuário primeiro.',
        report_contact_unconfigured:
          'Este serviço ainda não definiu um contato para denúncias, então as páginas não podem ser publicadas. Fale com o operador.',
        public_ingress_unconfigured:
          'Este serviço ainda não definiu um endereço público, então as páginas não podem ser publicadas. Fale com o operador.',
        not_published: 'Sua página não está publicada.',
        restricted: 'O operador deste serviço removeu sua página.',
        query_mismatch: 'Seu período de uso mudou. Abra sua página e aplique-o de novo.',
        invalid_stored_content: 'Não foi possível ler sua página pública. Publique-a de novo.',
        asset_unavailable: 'A imagem da sua página não está neste dispositivo. Escolha-a de novo.',
        usage_unavailable: 'Seu uso não pode ser lido neste dispositivo agora.',
        usage_query_result_invalid: 'Seu uso voltou incompleto. Tente de novo.',
        project_visibility_unavailable:
          'Não foi possível confirmar que um projeto é público. Ele fica fora da sua página.',
        preparation_unavailable: 'Este dispositivo não consegue preparar sua página agora.',
      },
    },
  },
};
