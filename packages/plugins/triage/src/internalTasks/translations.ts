const keys = ['unavailable', 'loading', 'title', 'description', 'personal', 'turnOn', 'existing', 'on', 'setupFailed', 'retry'] as const;
const messages = {
  en: ['This task could not be read', 'Reading task…', 'Happier tasks', 'Keep personal work in your Happier Account.', 'Personal tasks', 'Turn on', 'Your existing tasks and linked Sessions appear in Tasks.', 'On', 'Happier tasks could not be enabled', 'Try again'],
  de: ['Diese Aufgabe konnte nicht gelesen werden', 'Aufgabe wird gelesen…', 'Happier-Aufgaben', 'Behalte persönliche Aufgaben in deinem Happier-Konto.', 'Persönliche Aufgaben', 'Einschalten', 'Deine vorhandenen Aufgaben und verknüpften Sitzungen erscheinen unter Aufgaben.', 'An', 'Happier-Aufgaben konnten nicht aktiviert werden', 'Erneut versuchen'],
  ru: ['Не удалось прочитать задачу', 'Чтение задачи…', 'Задачи Happier', 'Храните личные задачи в своём аккаунте Happier.', 'Личные задачи', 'Включить', 'Существующие задачи и связанные сеансы появятся в разделе задач.', 'Вкл.', 'Не удалось включить задачи Happier', 'Повторить'],
  pl: ['Nie udało się odczytać zadania', 'Odczytywanie zadania…', 'Zadania Happier', 'Przechowuj osobiste zadania na swoim koncie Happier.', 'Osobiste zadania', 'Włącz', 'Istniejące zadania i połączone sesje pojawią się w Zadaniach.', 'Wł.', 'Nie udało się włączyć zadań Happier', 'Spróbuj ponownie'],
  es: ['No se pudo leer esta tarea', 'Leyendo tarea…', 'Tareas de Happier', 'Guarda tu trabajo personal en tu cuenta de Happier.', 'Tareas personales', 'Activar', 'Tus tareas existentes y sesiones vinculadas aparecen en Tareas.', 'Activado', 'No se pudieron activar las tareas de Happier', 'Reintentar'],
  fr: ['Impossible de lire cette tâche', 'Lecture de la tâche…', 'Tâches Happier', 'Gardez vos tâches personnelles dans votre compte Happier.', 'Tâches personnelles', 'Activer', 'Vos tâches existantes et sessions liées apparaissent dans Tâches.', 'Activé', 'Impossible d’activer les tâches Happier', 'Réessayer'],
  it: ['Impossibile leggere questa attività', 'Lettura attività…', 'Attività Happier', 'Conserva il lavoro personale nel tuo account Happier.', 'Attività personali', 'Attiva', 'Le attività esistenti e le sessioni collegate appaiono in Attività.', 'Attivo', 'Impossibile attivare le attività Happier', 'Riprova'],
  pt: ['Não foi possível ler esta tarefa', 'A ler tarefa…', 'Tarefas Happier', 'Guarde o trabalho pessoal na sua conta Happier.', 'Tarefas pessoais', 'Ativar', 'As tarefas existentes e sessões associadas aparecem em Tarefas.', 'Ativado', 'Não foi possível ativar as tarefas Happier', 'Tentar novamente'],
  ca: ['No s’ha pogut llegir aquesta tasca', 'Llegint la tasca…', 'Tasques de Happier', 'Desa la feina personal al teu compte de Happier.', 'Tasques personals', 'Activa', 'Les tasques existents i les sessions enllaçades apareixen a Tasques.', 'Activat', 'No s’han pogut activar les tasques de Happier', 'Torna-ho a provar'],
  'zh-Hans': ['无法读取此任务', '正在读取任务…', 'Happier 任务', '在 Happier 账户中保存个人工作。', '个人任务', '开启', '现有任务和关联会话将显示在任务中。', '已开启', '无法启用 Happier 任务', '重试'],
  'zh-Hant': ['無法讀取此任務', '正在讀取任務…', 'Happier 任務', '在 Happier 帳戶中儲存個人工作。', '個人任務', '開啟', '現有任務和關聯工作階段將顯示在任務中。', '已開啟', '無法啟用 Happier 任務', '重試'],
  ja: ['このタスクを読み取れませんでした', 'タスクを読み込み中…', 'Happier タスク', '個人の作業を Happier アカウントに保存します。', '個人のタスク', 'オンにする', '既存のタスクとリンク済みセッションがタスクに表示されます。', 'オン', 'Happier タスクを有効にできませんでした', '再試行'],
} satisfies Record<string, readonly [string, string, string, string, string, string, string, string, string, string]>;

export function internalTaskMessages(locale: string): Readonly<Record<string, string>> {
  const values = messages[locale as keyof typeof messages] ?? messages.en;
  return Object.fromEntries(keys.map((key, index) => [`plugins.triage.internal.${key}`, values[index]!]));
}
