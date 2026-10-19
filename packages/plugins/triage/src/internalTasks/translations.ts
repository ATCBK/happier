const keys = ['unavailable', 'loading', 'title', 'description', 'personal', 'use', 'existing', 'ready', 'setupFailed'] as const;
const messages = {
  en: ['This task could not be read', 'Reading task…', 'Happier tasks', 'Keep personal work in your Happier Account.', 'Personal tasks', 'Use Happier tasks', 'Your existing tasks and linked Sessions appear in Tasks.', 'Ready', 'Happier tasks could not be enabled'],
  de: ['Diese Aufgabe konnte nicht gelesen werden', 'Aufgabe wird gelesen…', 'Happier-Aufgaben', 'Behalte persönliche Aufgaben in deinem Happier-Konto.', 'Persönliche Aufgaben', 'Happier-Aufgaben verwenden', 'Deine vorhandenen Aufgaben und verknüpften Sitzungen erscheinen unter Aufgaben.', 'Bereit', 'Happier-Aufgaben konnten nicht aktiviert werden'],
  ru: ['Не удалось прочитать задачу', 'Чтение задачи…', 'Задачи Happier', 'Храните личные задачи в своём аккаунте Happier.', 'Личные задачи', 'Использовать задачи Happier', 'Существующие задачи и связанные сеансы появятся в разделе задач.', 'Готово', 'Не удалось включить задачи Happier'],
  pl: ['Nie udało się odczytać zadania', 'Odczytywanie zadania…', 'Zadania Happier', 'Przechowuj osobiste zadania na swoim koncie Happier.', 'Osobiste zadania', 'Używaj zadań Happier', 'Istniejące zadania i połączone sesje pojawią się w Zadaniach.', 'Gotowe', 'Nie udało się włączyć zadań Happier'],
  es: ['No se pudo leer esta tarea', 'Leyendo tarea…', 'Tareas de Happier', 'Guarda tu trabajo personal en tu cuenta de Happier.', 'Tareas personales', 'Usar tareas de Happier', 'Tus tareas existentes y sesiones vinculadas aparecen en Tareas.', 'Listo', 'No se pudieron activar las tareas de Happier'],
  fr: ['Impossible de lire cette tâche', 'Lecture de la tâche…', 'Tâches Happier', 'Gardez vos tâches personnelles dans votre compte Happier.', 'Tâches personnelles', 'Utiliser les tâches Happier', 'Vos tâches existantes et sessions liées apparaissent dans Tâches.', 'Prêt', 'Impossible d’activer les tâches Happier'],
  it: ['Impossibile leggere questa attività', 'Lettura attività…', 'Attività Happier', 'Conserva il lavoro personale nel tuo account Happier.', 'Attività personali', 'Usa le attività Happier', 'Le attività esistenti e le sessioni collegate appaiono in Attività.', 'Pronto', 'Impossibile attivare le attività Happier'],
  pt: ['Não foi possível ler esta tarefa', 'A ler tarefa…', 'Tarefas Happier', 'Guarde o trabalho pessoal na sua conta Happier.', 'Tarefas pessoais', 'Usar tarefas Happier', 'As tarefas existentes e sessões associadas aparecem em Tarefas.', 'Pronto', 'Não foi possível ativar as tarefas Happier'],
  ca: ['No s’ha pogut llegir aquesta tasca', 'Llegint la tasca…', 'Tasques de Happier', 'Desa la feina personal al teu compte de Happier.', 'Tasques personals', 'Utilitza les tasques de Happier', 'Les tasques existents i les sessions enllaçades apareixen a Tasques.', 'A punt', 'No s’han pogut activar les tasques de Happier'],
  'zh-Hans': ['无法读取此任务', '正在读取任务…', 'Happier 任务', '在 Happier 账户中保存个人工作。', '个人任务', '使用 Happier 任务', '现有任务和关联会话将显示在任务中。', '已就绪', '无法启用 Happier 任务'],
  'zh-Hant': ['無法讀取此任務', '正在讀取任務…', 'Happier 任務', '在 Happier 帳戶中儲存個人工作。', '個人任務', '使用 Happier 任務', '現有任務和關聯工作階段將顯示在任務中。', '已就緒', '無法啟用 Happier 任務'],
  ja: ['このタスクを読み取れませんでした', 'タスクを読み込み中…', 'Happier タスク', '個人の作業を Happier アカウントに保存します。', '個人のタスク', 'Happier タスクを使う', '既存のタスクとリンク済みセッションがタスクに表示されます。', '準備完了', 'Happier タスクを有効にできませんでした'],
} satisfies Record<string, readonly [string, string, string, string, string, string, string, string, string]>;

export function internalTaskMessages(locale: string): Readonly<Record<string, string>> {
  const values = messages[locale as keyof typeof messages] ?? messages.en;
  return Object.fromEntries(keys.map((key, index) => [`plugins.triage.internal.${key}`, values[index]!]));
}
