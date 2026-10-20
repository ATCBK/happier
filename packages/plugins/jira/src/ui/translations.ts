const keys = ["detail.loading","detail.noDescription","detail.retry","detail.unavailable","settings.all","settings.assignee","settings.author","settings.cancel","settings.invalid","settings.issues","settings.mine","settings.retry","settings.save","settings.subscribed","settings.type","settings.typeDescription","settings.typeNone","settings.typesLoading","settings.typesUnavailable"] as const;
type TranslatedKeys<T extends readonly string[]> = { readonly [Index in keyof T]: string };
const messages = {
  "en": [
    "Reading Jira issue", // detail.loading
    "No description", // detail.noDescription
    "Retry", // detail.retry
    "Jira issue unavailable", // detail.unavailable
    "All project issues", // settings.all
    "Assigned to me", // settings.assignee
    "Created by me", // settings.author
    "Cancel", // settings.cancel
    "Jira configuration unavailable", // settings.invalid
    "Issues", // settings.issues
    "My issues", // settings.mine
    "Retry", // settings.retry
    "Save", // settings.save
    "Subscribed", // settings.subscribed
    "Issue type for new issues", // settings.type
    "Choose a native issue type to enable creation in this project.", // settings.typeDescription
    "Not selected", // settings.typeNone
    "Reading Jira issue types", // settings.typesLoading
    "Jira issue types unavailable", // settings.typesUnavailable
  ],
  "de": [
    "Jira-Vorgang wird gelesen", // detail.loading
    "Keine Beschreibung", // detail.noDescription
    "Erneut versuchen", // detail.retry
    "Jira-Vorgang nicht verfügbar", // detail.unavailable
    "Alle Vorgänge des Projekts", // settings.all
    "Mir zugewiesen", // settings.assignee
    "Von mir erstellt", // settings.author
    "Abbrechen", // settings.cancel
    "Jira-Konfiguration nicht verfügbar", // settings.invalid
    "Vorgänge", // settings.issues
    "Meine Vorgänge", // settings.mine
    "Erneut versuchen", // settings.retry
    "Speichern", // settings.save
    "Abonniert", // settings.subscribed
    "Vorgangstyp für neue Vorgänge", // settings.type
    "Wähle einen Vorgangstyp aus Jira, um Vorgänge in diesem Projekt zu erstellen.", // settings.typeDescription
    "Nicht ausgewählt", // settings.typeNone
    "Jira-Vorgangstypen werden gelesen", // settings.typesLoading
    "Jira-Vorgangstypen nicht verfügbar", // settings.typesUnavailable
  ],
  "ru": [
    "Читаем задачу Jira", // detail.loading
    "Нет описания", // detail.noDescription
    "Повторить", // detail.retry
    "Задача Jira недоступна", // detail.unavailable
    "Все задачи проекта", // settings.all
    "Назначены мне", // settings.assignee
    "Созданы мной", // settings.author
    "Отмена", // settings.cancel
    "Настройки Jira недоступны", // settings.invalid
    "Задачи", // settings.issues
    "Мои задачи", // settings.mine
    "Повторить", // settings.retry
    "Сохранить", // settings.save
    "На которые я подписан", // settings.subscribed
    "Тип новых задач", // settings.type
    "Выберите тип задачи Jira, чтобы создавать задачи в этом проекте.", // settings.typeDescription
    "Не выбран", // settings.typeNone
    "Читаем типы задач Jira", // settings.typesLoading
    "Типы задач Jira недоступны", // settings.typesUnavailable
  ],
  "pl": [
    "Odczytywanie zgłoszenia Jira", // detail.loading
    "Brak opisu", // detail.noDescription
    "Spróbuj ponownie", // detail.retry
    "Zgłoszenie Jira niedostępne", // detail.unavailable
    "Wszystkie zgłoszenia projektu", // settings.all
    "Przypisane do mnie", // settings.assignee
    "Utworzone przeze mnie", // settings.author
    "Anuluj", // settings.cancel
    "Konfiguracja Jira niedostępna", // settings.invalid
    "Zgłoszenia", // settings.issues
    "Moje zgłoszenia", // settings.mine
    "Spróbuj ponownie", // settings.retry
    "Zapisz", // settings.save
    "Subskrybowane", // settings.subscribed
    "Typ nowych zgłoszeń", // settings.type
    "Wybierz typ zgłoszenia Jira, aby umożliwić tworzenie zgłoszeń w tym projekcie.", // settings.typeDescription
    "Nie wybrano", // settings.typeNone
    "Odczytywanie typów zgłoszeń Jira", // settings.typesLoading
    "Typy zgłoszeń Jira niedostępne", // settings.typesUnavailable
  ],
  "es": [
    "Leyendo la incidencia de Jira", // detail.loading
    "Sin descripción", // detail.noDescription
    "Reintentar", // detail.retry
    "Incidencia de Jira no disponible", // detail.unavailable
    "Todas las incidencias del proyecto", // settings.all
    "Asignadas a mí", // settings.assignee
    "Creadas por mí", // settings.author
    "Cancelar", // settings.cancel
    "Configuración de Jira no disponible", // settings.invalid
    "Incidencias", // settings.issues
    "Mis incidencias", // settings.mine
    "Reintentar", // settings.retry
    "Guardar", // settings.save
    "Suscritas", // settings.subscribed
    "Tipo de las nuevas incidencias", // settings.type
    "Elige un tipo de incidencia de Jira para poder crear incidencias en este proyecto.", // settings.typeDescription
    "Sin seleccionar", // settings.typeNone
    "Leyendo los tipos de incidencia de Jira", // settings.typesLoading
    "Tipos de incidencia de Jira no disponibles", // settings.typesUnavailable
  ],
  "fr": [
    "Lecture du ticket Jira", // detail.loading
    "Aucune description", // detail.noDescription
    "Réessayer", // detail.retry
    "Ticket Jira indisponible", // detail.unavailable
    "Tous les tickets du projet", // settings.all
    "Qui me sont assignés", // settings.assignee
    "Créés par moi", // settings.author
    "Annuler", // settings.cancel
    "Configuration Jira indisponible", // settings.invalid
    "Tickets", // settings.issues
    "Mes tickets", // settings.mine
    "Réessayer", // settings.retry
    "Enregistrer", // settings.save
    "Suivis", // settings.subscribed
    "Type des nouveaux tickets", // settings.type
    "Choisissez un type de ticket Jira pour permettre la création de tickets dans ce projet.", // settings.typeDescription
    "Non sélectionné", // settings.typeNone
    "Lecture des types de ticket Jira", // settings.typesLoading
    "Types de ticket Jira indisponibles", // settings.typesUnavailable
  ],
  "it": [
    "Lettura della issue di Jira", // detail.loading
    "Nessuna descrizione", // detail.noDescription
    "Riprova", // detail.retry
    "Issue di Jira non disponibile", // detail.unavailable
    "Tutte le issue del progetto", // settings.all
    "Assegnate a me", // settings.assignee
    "Create da me", // settings.author
    "Annulla", // settings.cancel
    "Configurazione di Jira non disponibile", // settings.invalid
    "Issue", // settings.issues
    "Le mie issue", // settings.mine
    "Riprova", // settings.retry
    "Salva", // settings.save
    "Seguite", // settings.subscribed
    "Tipo per le nuove issue", // settings.type
    "Scegli un tipo di issue di Jira per abilitarne la creazione in questo progetto.", // settings.typeDescription
    "Non selezionato", // settings.typeNone
    "Lettura dei tipi di issue di Jira", // settings.typesLoading
    "Tipi di issue di Jira non disponibili", // settings.typesUnavailable
  ],
  "pt": [
    "Lendo a issue do Jira", // detail.loading
    "Sem descrição", // detail.noDescription
    "Tentar novamente", // detail.retry
    "Issue do Jira indisponível", // detail.unavailable
    "Todas as issues do projeto", // settings.all
    "Atribuídas a mim", // settings.assignee
    "Criadas por mim", // settings.author
    "Cancelar", // settings.cancel
    "Configuração do Jira indisponível", // settings.invalid
    "Issues", // settings.issues
    "Minhas issues", // settings.mine
    "Tentar novamente", // settings.retry
    "Salvar", // settings.save
    "Acompanhadas", // settings.subscribed
    "Tipo das novas issues", // settings.type
    "Escolha um tipo de issue do Jira para permitir a criação de issues neste projeto.", // settings.typeDescription
    "Não selecionado", // settings.typeNone
    "Lendo os tipos de issue do Jira", // settings.typesLoading
    "Tipos de issue do Jira indisponíveis", // settings.typesUnavailable
  ],
  "ca": [
    "S’està llegint la incidència de Jira", // detail.loading
    "Sense descripció", // detail.noDescription
    "Torna-ho a provar", // detail.retry
    "Incidència de Jira no disponible", // detail.unavailable
    "Totes les incidències del projecte", // settings.all
    "Assignades a mi", // settings.assignee
    "Creades per mi", // settings.author
    "Cancel·la", // settings.cancel
    "Configuració de Jira no disponible", // settings.invalid
    "Incidències", // settings.issues
    "Les meves incidències", // settings.mine
    "Torna-ho a provar", // settings.retry
    "Desa", // settings.save
    "Amb subscripció", // settings.subscribed
    "Tipus de les incidències noves", // settings.type
    "Tria un tipus d’incidència de Jira per poder crear incidències en aquest projecte.", // settings.typeDescription
    "Sense seleccionar", // settings.typeNone
    "S’estan llegint els tipus d’incidència de Jira", // settings.typesLoading
    "Tipus d’incidència de Jira no disponibles", // settings.typesUnavailable
  ],
  "zh-Hans": [
    "正在读取 Jira 事项", // detail.loading
    "无描述", // detail.noDescription
    "重试", // detail.retry
    "Jira 事项不可用", // detail.unavailable
    "项目的所有事项", // settings.all
    "分配给我的", // settings.assignee
    "由我创建的", // settings.author
    "取消", // settings.cancel
    "Jira 配置不可用", // settings.invalid
    "事项", // settings.issues
    "我的事项", // settings.mine
    "重试", // settings.retry
    "保存", // settings.save
    "已订阅的", // settings.subscribed
    "新事项的类型", // settings.type
    "请选择 Jira 事项类型，以便在此项目中创建事项。", // settings.typeDescription
    "未选择", // settings.typeNone
    "正在读取 Jira 事项类型", // settings.typesLoading
    "Jira 事项类型不可用", // settings.typesUnavailable
  ],
  "zh-Hant": [
    "正在讀取 Jira 工作項目", // detail.loading
    "無描述", // detail.noDescription
    "重試", // detail.retry
    "Jira 工作項目無法使用", // detail.unavailable
    "專案的所有工作項目", // settings.all
    "指派給我的", // settings.assignee
    "由我建立的", // settings.author
    "取消", // settings.cancel
    "Jira 設定無法使用", // settings.invalid
    "工作項目", // settings.issues
    "我的工作項目", // settings.mine
    "重試", // settings.retry
    "儲存", // settings.save
    "已訂閱的", // settings.subscribed
    "新工作項目的類型", // settings.type
    "請選擇 Jira 工作項目類型，以便在此專案中建立工作項目。", // settings.typeDescription
    "未選取", // settings.typeNone
    "正在讀取 Jira 工作項目類型", // settings.typesLoading
    "Jira 工作項目類型無法使用", // settings.typesUnavailable
  ],
  "ja": [
    "Jira 課題を読み込み中", // detail.loading
    "説明なし", // detail.noDescription
    "再試行", // detail.retry
    "Jira 課題を利用できません", // detail.unavailable
    "プロジェクトのすべての課題", // settings.all
    "自分に割り当て", // settings.assignee
    "自分が作成", // settings.author
    "キャンセル", // settings.cancel
    "Jira 設定を利用できません", // settings.invalid
    "課題", // settings.issues
    "自分の課題", // settings.mine
    "再試行", // settings.retry
    "保存", // settings.save
    "購読中", // settings.subscribed
    "新しい課題の課題タイプ", // settings.type
    "このプロジェクトで課題を作成するには、Jira の課題タイプを選択してください。", // settings.typeDescription
    "未選択", // settings.typeNone
    "Jira の課題タイプを読み込み中", // settings.typesLoading
    "Jira の課題タイプを利用できません", // settings.typesUnavailable
  ],
} satisfies Record<string, TranslatedKeys<typeof keys>>;

export const JIRA_UI_TRANSLATIONS = Object.entries(messages).map(([locale, values]) => ({
  locale,
  messages: Object.fromEntries(keys.map((key, index) => [
    `plugins.jira.${key}`, values[index]!,
  ])),
}));

