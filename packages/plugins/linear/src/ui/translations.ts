const keys = ["detail.unavailable","detail.loading","detail.retry","detail.more","detail.overview","detail.labels","detail.children","detail.blocks","detail.blockedBy","detail.comments","detail.transitions","detail.empty","detail.truncated","settings.issues","settings.mine","settings.assignee","settings.author","settings.subscribed","settings.everyone","settings.save","settings.cancel"] as const;
type TranslatedKeys<T extends readonly string[]> = { readonly [Index in keyof T]: string };
const messages = {
  "en": [
    "Linear issue details are unavailable on this surface.", // detail.unavailable
    "Reading this Linear issue…", // detail.loading
    "Try again", // detail.retry
    "Load more", // detail.more
    "Description", // detail.overview
    "Labels", // detail.labels
    "Sub-issues", // detail.children
    "Blocks", // detail.blocks
    "Blocked by", // detail.blockedBy
    "Comments", // detail.comments
    "Workflow states", // detail.transitions
    "Linear has no entries in this section.", // detail.empty
    "This response is incomplete. Open the issue in Linear for the full content.", // detail.truncated
    "Issues", // settings.issues
    "My issues", // settings.mine
    "Assigned to me", // settings.assignee
    "Created by me", // settings.author
    "Subscribed", // settings.subscribed
    "All team issues", // settings.everyone
    "Save", // settings.save
    "Cancel", // settings.cancel
  ],
  "de": [
    "Details zu diesem Linear-Issue sind auf dieser Oberfläche nicht verfügbar.", // detail.unavailable
    "Dieses Linear-Issue wird gelesen…", // detail.loading
    "Erneut versuchen", // detail.retry
    "Mehr laden", // detail.more
    "Beschreibung", // detail.overview
    "Labels", // detail.labels
    "Untergeordnete Issues", // detail.children
    "Blockiert", // detail.blocks
    "Blockiert durch", // detail.blockedBy
    "Kommentare", // detail.comments
    "Workflow-Status", // detail.transitions
    "Linear hat keine Einträge in diesem Abschnitt.", // detail.empty
    "Diese Antwort ist unvollständig. Öffne das Issue in Linear, um den vollständigen Inhalt zu sehen.", // detail.truncated
    "Issues", // settings.issues
    "Meine Issues", // settings.mine
    "Mir zugewiesen", // settings.assignee
    "Von mir erstellt", // settings.author
    "Abonniert", // settings.subscribed
    "Alle Issues des Teams", // settings.everyone
    "Speichern", // settings.save
    "Abbrechen", // settings.cancel
  ],
  "ru": [
    "Подробности задачи Linear недоступны на этом экране.", // detail.unavailable
    "Читаем задачу Linear…", // detail.loading
    "Повторить попытку", // detail.retry
    "Загрузить ещё", // detail.more
    "Описание", // detail.overview
    "Метки", // detail.labels
    "Подзадачи", // detail.children
    "Блокирует", // detail.blocks
    "Заблокирована", // detail.blockedBy
    "Комментарии", // detail.comments
    "Состояния рабочего процесса", // detail.transitions
    "В этом разделе Linear нет записей.", // detail.empty
    "Ответ неполный. Откройте задачу в Linear, чтобы увидеть всё содержимое.", // detail.truncated
    "Задачи", // settings.issues
    "Мои задачи", // settings.mine
    "Назначены мне", // settings.assignee
    "Созданы мной", // settings.author
    "На которые я подписан", // settings.subscribed
    "Все задачи команды", // settings.everyone
    "Сохранить", // settings.save
    "Отмена", // settings.cancel
  ],
  "pl": [
    "Szczegóły zgłoszenia Linear są niedostępne na tym ekranie.", // detail.unavailable
    "Odczytywanie zgłoszenia Linear…", // detail.loading
    "Spróbuj ponownie", // detail.retry
    "Załaduj więcej", // detail.more
    "Opis", // detail.overview
    "Etykiety", // detail.labels
    "Podzgłoszenia", // detail.children
    "Blokuje", // detail.blocks
    "Blokowane przez", // detail.blockedBy
    "Komentarze", // detail.comments
    "Stany przepływu pracy", // detail.transitions
    "Linear nie ma wpisów w tej sekcji.", // detail.empty
    "Ta odpowiedź jest niepełna. Otwórz zgłoszenie w Linear, aby zobaczyć całą treść.", // detail.truncated
    "Zgłoszenia", // settings.issues
    "Moje zgłoszenia", // settings.mine
    "Przypisane do mnie", // settings.assignee
    "Utworzone przeze mnie", // settings.author
    "Subskrybowane", // settings.subscribed
    "Wszystkie zgłoszenia zespołu", // settings.everyone
    "Zapisz", // settings.save
    "Anuluj", // settings.cancel
  ],
  "es": [
    "Los detalles de esta incidencia de Linear no están disponibles en esta pantalla.", // detail.unavailable
    "Leyendo esta incidencia de Linear…", // detail.loading
    "Volver a intentar", // detail.retry
    "Cargar más", // detail.more
    "Descripción", // detail.overview
    "Etiquetas", // detail.labels
    "Subincidencias", // detail.children
    "Bloquea", // detail.blocks
    "Bloqueada por", // detail.blockedBy
    "Comentarios", // detail.comments
    "Estados del flujo de trabajo", // detail.transitions
    "Linear no tiene entradas en esta sección.", // detail.empty
    "Esta respuesta está incompleta. Abre la incidencia en Linear para ver todo el contenido.", // detail.truncated
    "Incidencias", // settings.issues
    "Mis incidencias", // settings.mine
    "Asignadas a mí", // settings.assignee
    "Creadas por mí", // settings.author
    "Suscritas", // settings.subscribed
    "Todas las incidencias del equipo", // settings.everyone
    "Guardar", // settings.save
    "Cancelar", // settings.cancel
  ],
  "fr": [
    "Les détails de ce ticket Linear sont indisponibles sur cet écran.", // detail.unavailable
    "Lecture de ce ticket Linear…", // detail.loading
    "Réessayer", // detail.retry
    "Charger plus", // detail.more
    "Description", // detail.overview
    "Étiquettes", // detail.labels
    "Sous-tickets", // detail.children
    "Bloque", // detail.blocks
    "Bloqué par", // detail.blockedBy
    "Commentaires", // detail.comments
    "États du workflow", // detail.transitions
    "Linear ne contient aucune entrée dans cette section.", // detail.empty
    "Cette réponse est incomplète. Ouvrez le ticket dans Linear pour voir tout le contenu.", // detail.truncated
    "Tickets", // settings.issues
    "Mes tickets", // settings.mine
    "Qui me sont assignés", // settings.assignee
    "Créés par moi", // settings.author
    "Suivis", // settings.subscribed
    "Tous les tickets de l’équipe", // settings.everyone
    "Enregistrer", // settings.save
    "Annuler", // settings.cancel
  ],
  "it": [
    "I dettagli di questa issue di Linear non sono disponibili in questa schermata.", // detail.unavailable
    "Lettura di questa issue di Linear…", // detail.loading
    "Riprova", // detail.retry
    "Carica altro", // detail.more
    "Descrizione", // detail.overview
    "Etichette", // detail.labels
    "Sotto-issue", // detail.children
    "Blocca", // detail.blocks
    "Bloccata da", // detail.blockedBy
    "Commenti", // detail.comments
    "Stati del flusso di lavoro", // detail.transitions
    "Linear non ha voci in questa sezione.", // detail.empty
    "Questa risposta è incompleta. Apri la issue in Linear per vedere tutto il contenuto.", // detail.truncated
    "Issue", // settings.issues
    "Le mie issue", // settings.mine
    "Assegnate a me", // settings.assignee
    "Create da me", // settings.author
    "Seguite", // settings.subscribed
    "Tutte le issue del team", // settings.everyone
    "Salva", // settings.save
    "Annulla", // settings.cancel
  ],
  "pt": [
    "Os detalhes desta issue do Linear não estão disponíveis nesta tela.", // detail.unavailable
    "Lendo esta issue do Linear…", // detail.loading
    "Tentar novamente", // detail.retry
    "Carregar mais", // detail.more
    "Descrição", // detail.overview
    "Etiquetas", // detail.labels
    "Sub-issues", // detail.children
    "Bloqueia", // detail.blocks
    "Bloqueada por", // detail.blockedBy
    "Comentários", // detail.comments
    "Estados do fluxo de trabalho", // detail.transitions
    "O Linear não tem entradas nesta seção.", // detail.empty
    "Esta resposta está incompleta. Abra a issue no Linear para ver todo o conteúdo.", // detail.truncated
    "Issues", // settings.issues
    "Minhas issues", // settings.mine
    "Atribuídas a mim", // settings.assignee
    "Criadas por mim", // settings.author
    "Acompanhadas", // settings.subscribed
    "Todas as issues da equipe", // settings.everyone
    "Salvar", // settings.save
    "Cancelar", // settings.cancel
  ],
  "ca": [
    "Els detalls d’aquesta incidència de Linear no estan disponibles en aquesta pantalla.", // detail.unavailable
    "S’està llegint aquesta incidència de Linear…", // detail.loading
    "Torna-ho a provar", // detail.retry
    "Carrega’n més", // detail.more
    "Descripció", // detail.overview
    "Etiquetes", // detail.labels
    "Subincidències", // detail.children
    "Bloqueja", // detail.blocks
    "Bloquejada per", // detail.blockedBy
    "Comentaris", // detail.comments
    "Estats del flux de treball", // detail.transitions
    "Linear no té entrades en aquesta secció.", // detail.empty
    "Aquesta resposta és incompleta. Obre la incidència a Linear per veure’n tot el contingut.", // detail.truncated
    "Incidències", // settings.issues
    "Les meves incidències", // settings.mine
    "Assignades a mi", // settings.assignee
    "Creades per mi", // settings.author
    "Amb subscripció", // settings.subscribed
    "Totes les incidències de l’equip", // settings.everyone
    "Desa", // settings.save
    "Cancel·la", // settings.cancel
  ],
  "zh-Hans": [
    "此界面无法显示 Linear 议题详情。", // detail.unavailable
    "正在读取此 Linear 议题…", // detail.loading
    "重试", // detail.retry
    "加载更多", // detail.more
    "描述", // detail.overview
    "标签", // detail.labels
    "子议题", // detail.children
    "阻塞", // detail.blocks
    "阻塞来源", // detail.blockedBy
    "评论", // detail.comments
    "工作流状态", // detail.transitions
    "Linear 的此部分没有条目。", // detail.empty
    "此响应不完整。请在 Linear 中打开议题以查看完整内容。", // detail.truncated
    "议题", // settings.issues
    "我的议题", // settings.mine
    "分配给我的", // settings.assignee
    "由我创建的", // settings.author
    "已订阅的", // settings.subscribed
    "团队的所有议题", // settings.everyone
    "保存", // settings.save
    "取消", // settings.cancel
  ],
  "zh-Hant": [
    "此介面無法顯示 Linear 議題詳情。", // detail.unavailable
    "正在讀取此 Linear 議題…", // detail.loading
    "重試", // detail.retry
    "載入更多", // detail.more
    "描述", // detail.overview
    "標籤", // detail.labels
    "子議題", // detail.children
    "阻擋", // detail.blocks
    "受阻於", // detail.blockedBy
    "留言", // detail.comments
    "工作流程狀態", // detail.transitions
    "Linear 的此區段沒有項目。", // detail.empty
    "此回應不完整。請在 Linear 中開啟議題以查看完整內容。", // detail.truncated
    "議題", // settings.issues
    "我的議題", // settings.mine
    "指派給我的", // settings.assignee
    "由我建立的", // settings.author
    "已訂閱的", // settings.subscribed
    "團隊的所有議題", // settings.everyone
    "儲存", // settings.save
    "取消", // settings.cancel
  ],
  "ja": [
    "この画面では Linear イシューの詳細を表示できません。", // detail.unavailable
    "この Linear イシューを読み込み中…", // detail.loading
    "再試行", // detail.retry
    "さらに読み込む", // detail.more
    "説明", // detail.overview
    "ラベル", // detail.labels
    "サブイシュー", // detail.children
    "ブロックしているイシュー", // detail.blocks
    "ブロック元", // detail.blockedBy
    "コメント", // detail.comments
    "ワークフローの状態", // detail.transitions
    "Linear のこのセクションには項目がありません。", // detail.empty
    "この応答は不完全です。全文を確認するには Linear でイシューを開いてください。", // detail.truncated
    "イシュー", // settings.issues
    "自分のイシュー", // settings.mine
    "自分に割り当て", // settings.assignee
    "自分が作成", // settings.author
    "購読中", // settings.subscribed
    "チームのすべてのイシュー", // settings.everyone
    "保存", // settings.save
    "キャンセル", // settings.cancel
  ],
} satisfies Record<string, TranslatedKeys<typeof keys>>;

export const LINEAR_UI_TRANSLATIONS = Object.entries(messages).map(([locale, values]) => ({
  locale,
  messages: Object.fromEntries(keys.map((key, index) => [
    `plugins.linear.${key}`, values[index]!,
  ])),
}));

