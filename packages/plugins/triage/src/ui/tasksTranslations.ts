const keys = ['title', 'description', 'audience', 'mine', 'agents', 'everyone', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'unclassified', 'create', 'taskTitle', 'body', 'scope', 'edit', 'save', 'transition', 'write.applied', 'write.uncertain', 'write.refused', 'write.failed', 'myTasks', 'noCreateSource', 'sourcesUnavailable'] as const;
type TranslatedKeys<T extends readonly string[]> = { readonly [Index in keyof T]: string };
const messages = {
  en: ['Tasks', 'Your work, and the agents working with you.', 'Show tasks', 'Mine', 'Agents', 'Everyone', 'Backlog', 'To do', 'In progress', 'Done', 'Canceled', 'Other states', 'Create task', 'Title', 'Notes', 'Repository or project', 'Edit task', 'Save changes', 'Change status', 'Saved at the source', 'The source may have saved this. Check it before creating or saving again.', 'This change is not available for this task.', 'The source could not save this change.', 'My tasks', 'Add a source that supports creating tasks in Sources.', 'Task sources are unavailable'],
  de: ['Aufgaben', 'Deine Arbeit und die Agents an deiner Seite.', 'Aufgaben anzeigen', 'Meine', 'Agents', 'Alle', 'Backlog', 'Zu erledigen', 'In Arbeit', 'Erledigt', 'Abgebrochen', 'Andere Zustände', 'Aufgabe erstellen', 'Titel', 'Notizen', 'Repository oder Projekt', 'Aufgabe bearbeiten', 'Änderungen speichern', 'Status ändern', 'An der Quelle gespeichert', 'Die Quelle hat dies möglicherweise gespeichert. Prüfe es vor einem erneuten Speichern.', 'Diese Änderung ist für diese Aufgabe nicht verfügbar.', 'Die Quelle konnte die Änderung nicht speichern.', 'Meine Aufgaben', 'Füge unter Quellen eine Quelle hinzu, die das Erstellen von Aufgaben unterstützt.', 'Aufgabenquellen sind nicht verfügbar'],
  ru: ['Задачи', 'Ваша работа и помогающие вам агенты.', 'Показать задачи', 'Мои', 'Агенты', 'Все', 'Бэклог', 'К выполнению', 'В работе', 'Готово', 'Отменены', 'Другие состояния', 'Создать задачу', 'Название', 'Заметки', 'Репозиторий или проект', 'Изменить задачу', 'Сохранить изменения', 'Изменить статус', 'Сохранено в источнике', 'Источник мог сохранить изменения. Проверьте перед повторным сохранением.', 'Это изменение недоступно для задачи.', 'Источник не смог сохранить изменение.', 'Мои задачи', 'Добавьте в разделе «Источники» источник, поддерживающий создание задач.', 'Источники задач недоступны'],
  pl: ['Zadania', 'Twoja praca i pomagający Ci agenci.', 'Pokaż zadania', 'Moje', 'Agenci', 'Wszystkie', 'Backlog', 'Do zrobienia', 'W toku', 'Gotowe', 'Anulowane', 'Inne stany', 'Utwórz zadanie', 'Tytuł', 'Notatki', 'Repozytorium lub projekt', 'Edytuj zadanie', 'Zapisz zmiany', 'Zmień status', 'Zapisano w źródle', 'Źródło mogło zapisać zmiany. Sprawdź przed ponownym zapisem.', 'Ta zmiana jest niedostępna dla tego zadania.', 'Źródło nie mogło zapisać zmiany.', 'Moje zadania', 'Dodaj w sekcji Źródła źródło obsługujące tworzenie zadań.', 'Źródła zadań są niedostępne'],
  es: ['Tareas', 'Tu trabajo y los agentes que te ayudan.', 'Mostrar tareas', 'Mías', 'Agentes', 'Todas', 'Pendientes', 'Por hacer', 'En curso', 'Hecho', 'Canceladas', 'Otros estados', 'Crear tarea', 'Título', 'Notas', 'Repositorio o proyecto', 'Editar tarea', 'Guardar cambios', 'Cambiar estado', 'Guardado en el origen', 'El origen puede haber guardado los cambios. Compruébalo antes de guardar de nuevo.', 'Este cambio no está disponible para esta tarea.', 'El origen no pudo guardar este cambio.', 'Mis tareas', 'Añade en Fuentes una fuente que permita crear tareas.', 'Las fuentes de tareas no están disponibles'],
  fr: ['Tâches', 'Votre travail et les agents à vos côtés.', 'Afficher les tâches', 'Les miennes', 'Agents', 'Toutes', 'À prévoir', 'À faire', 'En cours', 'Terminé', 'Annulées', 'Autres états', 'Créer une tâche', 'Titre', 'Notes', 'Dépôt ou projet', 'Modifier la tâche', 'Enregistrer', 'Changer le statut', 'Enregistré à la source', 'La source a peut-être enregistré les modifications. Vérifiez avant de réessayer.', 'Cette modification est indisponible pour cette tâche.', 'La source n’a pas pu enregistrer cette modification.', 'Mes tâches', 'Ajoutez dans Sources une source permettant de créer des tâches.', 'Les sources de tâches sont indisponibles'],
  it: ['Attività', 'Il tuo lavoro e gli agenti al tuo fianco.', 'Mostra attività', 'Mie', 'Agenti', 'Tutte', 'Da pianificare', 'Da fare', 'In corso', 'Fatto', 'Annullate', 'Altri stati', 'Crea attività', 'Titolo', 'Note', 'Repository o progetto', 'Modifica attività', 'Salva modifiche', 'Cambia stato', 'Salvato all’origine', 'L’origine potrebbe aver salvato le modifiche. Verifica prima di riprovare.', 'Questa modifica non è disponibile per questa attività.', 'L’origine non ha potuto salvare la modifica.', 'Le mie attività', 'Aggiungi in Origini un’origine che supporti la creazione di attività.', 'Le origini delle attività non sono disponibili'],
  pt: ['Tarefas', 'Seu trabalho e os agentes ao seu lado.', 'Mostrar tarefas', 'Minhas', 'Agentes', 'Todas', 'A planejar', 'A fazer', 'Em andamento', 'Concluído', 'Canceladas', 'Outros estados', 'Criar tarefa', 'Título', 'Notas', 'Repositório ou projeto', 'Editar tarefa', 'Salvar alterações', 'Alterar estado', 'Salvo na origem', 'A origem pode ter salvo as alterações. Verifique antes de salvar novamente.', 'Esta alteração não está disponível para esta tarefa.', 'A origem não conseguiu salvar esta alteração.', 'Minhas tarefas', 'Adicione em Origens uma origem que permita criar tarefas.', 'As origens das tarefas não estão disponíveis'],
  ca: ['Tasques', 'La teva feina i els agents que t’ajuden.', 'Mostra tasques', 'Meves', 'Agents', 'Totes', 'Pendents', 'Per fer', 'En curs', 'Fet', 'Cancel·lades', 'Altres estats', 'Crea una tasca', 'Títol', 'Notes', 'Repositori o projecte', 'Edita la tasca', 'Desa els canvis', 'Canvia l’estat', 'Desat a l’origen', 'L’origen pot haver desat els canvis. Comprova-ho abans de tornar a desar.', 'Aquest canvi no està disponible per a aquesta tasca.', 'L’origen no ha pogut desar aquest canvi.', 'Les meves tasques', 'Afegeix a Fonts una font que permeti crear tasques.', 'Les fonts de tasques no estan disponibles'],
  'zh-Hans': ['任务', '你的工作，以及与你协作的代理。', '显示任务', '我的', '代理', '全部', '待规划', '待办', '进行中', '已完成', '已取消', '其他状态', '创建任务', '标题', '备注', '仓库或项目', '编辑任务', '保存更改', '更改状态', '已在来源保存', '来源可能已保存。再次创建或保存前请先确认。', '此任务不支持这项更改。', '来源无法保存此更改。', '我的任务', '请在“来源”中添加支持创建任务的来源。', '任务来源不可用'],
  'zh-Hant': ['任務', '你的工作，以及與你協作的代理。', '顯示任務', '我的', '代理', '全部', '待規劃', '待辦', '進行中', '已完成', '已取消', '其他狀態', '建立任務', '標題', '備註', '儲存庫或專案', '編輯任務', '儲存變更', '變更狀態', '已在來源儲存', '來源可能已儲存。再次建立或儲存前請先確認。', '此任務不支援這項變更。', '來源無法儲存此變更。', '我的任務', '請在「來源」中新增支援建立任務的來源。', '任務來源無法使用'],
  ja: ['タスク', 'あなたの仕事と、一緒に働くエージェント。', 'タスクを表示', '自分', 'エージェント', 'すべて', '未計画', '未着手', '進行中', '完了', 'キャンセル', 'その他の状態', 'タスクを作成', 'タイトル', 'メモ', 'リポジトリまたはプロジェクト', 'タスクを編集', '変更を保存', '状態を変更', '作成元に保存しました', '作成元に保存されている可能性があります。再作成や再保存の前に確認してください。', 'このタスクではこの変更を利用できません。', '作成元で変更を保存できませんでした。', '自分のタスク', '「取得元」でタスクの作成に対応した取得元を追加してください。', 'タスクの作成元を利用できません'],
} satisfies Record<string, TranslatedKeys<typeof keys>>;

const emptyKeys = ['empty.title', 'empty.description', 'empty.pending'] as const;
const emptyMessages = {
  en: ['No tasks here', 'Try another task lens or create a task.', 'No tasks read so far are in this lens. More sources may still answer.'],
  de: ['Hier sind keine Aufgaben', 'Wähle eine andere Aufgabenansicht oder erstelle eine Aufgabe.', 'Bisher passt keine gelesene Aufgabe in diese Ansicht. Weitere Quellen können noch antworten.'],
  ru: ['Здесь нет задач', 'Выберите другой вид задач или создайте задачу.', 'Пока ни одна прочитанная задача не подходит. Другие источники ещё могут ответить.'],
  pl: ['Nie ma tu zadań', 'Wybierz inny widok zadań lub utwórz zadanie.', 'Dotąd żadne odczytane zadanie nie pasuje do tego widoku. Inne źródła mogą jeszcze odpowiedzieć.'],
  es: ['No hay tareas aquí', 'Prueba otra vista o crea una tarea.', 'Ninguna tarea leída hasta ahora está en esta vista. Otras fuentes aún pueden responder.'],
  fr: ['Aucune tâche ici', 'Essayez une autre vue ou créez une tâche.', 'Aucune tâche lue ne correspond à cette vue. D’autres sources peuvent encore répondre.'],
  it: ['Nessuna attività qui', 'Prova un’altra vista o crea un’attività.', 'Nessuna attività letta finora appartiene a questa vista. Altre origini potrebbero ancora rispondere.'],
  pt: ['Não há tarefas aqui', 'Tente outra vista ou crie uma tarefa.', 'Nenhuma tarefa lida até agora está nesta vista. Outras origens ainda podem responder.'],
  ca: ['No hi ha tasques aquí', 'Prova una altra vista o crea una tasca.', 'Cap tasca llegida fins ara és en aquesta vista. Altres fonts encara poden respondre.'],
  'zh-Hans': ['此处没有任务', '尝试其他任务视图或创建任务。', '目前读取的任务都不在此视图中。其他来源可能仍会返回结果。'],
  'zh-Hant': ['此處沒有任務', '嘗試其他任務檢視或建立任務。', '目前讀取的任務都不在此檢視中。其他來源可能仍會傳回結果。'],
  ja: ['ここにタスクはありません', '別のタスク表示を試すか、タスクを作成してください。', 'これまでに読み込んだタスクはこの表示に含まれません。ほかの作成元から結果が届く場合があります。'],
} satisfies Record<keyof typeof messages, TranslatedKeys<typeof emptyKeys>>;

const pageKeys = ['new', 'search', 'column.task', 'column.status', 'column.progress', 'progress.blocked', 'progress.subtasks', 'progress.done', 'progress.subtask', 'editValuesUnavailable', 'invalidField', 'complete', 'column.due', 'due.today', 'due.overdue', 'thisWeek', 'showDone', 'hideDone'] as const;
const pageMessages = {
  en: ['New task', 'Search tasks', 'Task', 'Status', 'Progress', 'Blocked', '{total} sub-tasks', '{completed} of {total}', 'Sub-task', 'Some current task values could not be loaded. Only fully loaded fields can be edited.', 'Check this value before saving.', 'Mark as done', 'Due', 'Today', 'Overdue · {date}', 'This week', 'Show', 'Hide'],
  de: ['Neue Aufgabe', 'Aufgaben suchen', 'Aufgabe', 'Status', 'Fortschritt', 'Blockiert', '{total} Unteraufgaben', '{completed} von {total}', 'Unteraufgabe', 'Einige aktuelle Werte der Aufgabe konnten nicht geladen werden. Nur vollständig geladene Felder können bearbeitet werden.', 'Prüfe diesen Wert vor dem Speichern.', 'Als erledigt markieren', 'Fällig', 'Heute', 'Überfällig · {date}', 'Diese Woche', 'Anzeigen', 'Ausblenden'],
  ru: ['Новая задача', 'Поиск задач', 'Задача', 'Статус', 'Прогресс', 'Заблокирована', 'Подзадач: {total}', '{completed} из {total}', 'Подзадача', 'Не удалось загрузить некоторые текущие значения задачи. Изменять можно только полностью загруженные поля.', 'Проверьте это значение перед сохранением.', 'Отметить готовой', 'Срок', 'Сегодня', 'Просрочена · {date}', 'На этой неделе', 'Показать', 'Скрыть'],
  pl: ['Nowe zadanie', 'Szukaj zadań', 'Zadanie', 'Status', 'Postęp', 'Zablokowane', 'Podzadania: {total}', '{completed} z {total}', 'Podzadanie', 'Nie udało się wczytać niektórych bieżących wartości zadania. Edytować można tylko w pełni wczytane pola.', 'Sprawdź tę wartość przed zapisaniem.', 'Oznacz jako gotowe', 'Termin', 'Dziś', 'Po terminie · {date}', 'W tym tygodniu', 'Pokaż', 'Ukryj'],
  es: ['Nueva tarea', 'Buscar tareas', 'Tarea', 'Estado', 'Progreso', 'Bloqueada', '{total} subtareas', '{completed} de {total}', 'Subtarea', 'No se pudieron cargar algunos valores actuales de la tarea. Solo se pueden editar los campos cargados por completo.', 'Revisa este valor antes de guardar.', 'Marcar como hecha', 'Vence', 'Hoy', 'Vencida · {date}', 'Esta semana', 'Mostrar', 'Ocultar'],
  fr: ['Nouvelle tâche', 'Rechercher des tâches', 'Tâche', 'Statut', 'Progression', 'Bloquée', '{total} sous-tâches', '{completed} sur {total}', 'Sous-tâche', 'Certaines valeurs actuelles de la tâche n’ont pas pu être chargées. Seuls les champs entièrement chargés sont modifiables.', 'Vérifiez cette valeur avant d’enregistrer.', 'Marquer comme terminée', 'Échéance', 'Aujourd’hui', 'En retard · {date}', 'Cette semaine', 'Afficher', 'Masquer'],
  it: ['Nuova attività', 'Cerca attività', 'Attività', 'Stato', 'Avanzamento', 'Bloccata', '{total} sotto-attività', '{completed} di {total}', 'Sotto-attività', 'Non è stato possibile caricare alcuni valori attuali dell’attività. Si possono modificare solo i campi caricati del tutto.', 'Controlla questo valore prima di salvare.', 'Segna come fatta', 'Scadenza', 'Oggi', 'Scaduta · {date}', 'Questa settimana', 'Mostra', 'Nascondi'],
  pt: ['Nova tarefa', 'Pesquisar tarefas', 'Tarefa', 'Estado', 'Progresso', 'Bloqueada', '{total} subtarefas', '{completed} de {total}', 'Subtarefa', 'Não foi possível carregar alguns valores atuais da tarefa. Só é possível editar os campos carregados por completo.', 'Verifique este valor antes de salvar.', 'Marcar como concluída', 'Prazo', 'Hoje', 'Atrasada · {date}', 'Esta semana', 'Mostrar', 'Ocultar'],
  ca: ['Tasca nova', 'Cerca tasques', 'Tasca', 'Estat', 'Progrés', 'Bloquejada', '{total} subtasques', '{completed} de {total}', 'Subtasca', 'No s’han pogut carregar alguns valors actuals de la tasca. Només es poden editar els camps carregats del tot.', 'Revisa aquest valor abans de desar.', 'Marca com a feta', 'Venciment', 'Avui', 'Vençuda · {date}', 'Aquesta setmana', 'Mostra', 'Amaga'],
  'zh-Hans': ['新建任务', '搜索任务', '任务', '状态', '进度', '已阻塞', '{total} 个子任务', '{completed}/{total}', '子任务', '部分当前任务值无法加载。只能编辑已完整加载的字段。', '保存前请检查此值。', '标记为已完成', '截止', '今天', '已逾期 · {date}', '本周', '显示', '隐藏'],
  'zh-Hant': ['新增任務', '搜尋任務', '任務', '狀態', '進度', '已封鎖', '{total} 個子任務', '{completed}/{total}', '子任務', '部分目前任務值無法載入。只能編輯已完整載入的欄位。', '儲存前請檢查此值。', '標記為已完成', '截止', '今天', '已逾期 · {date}', '本週', '顯示', '隱藏'],
  ja: ['新しいタスク', 'タスクを検索', 'タスク', '状態', '進捗', 'ブロック中', 'サブタスク {total} 件', '{completed}/{total}', 'サブタスク', 'タスクの現在の値の一部を読み込めませんでした。完全に読み込まれた項目のみ編集できます。', '保存する前にこの値を確認してください。', '完了にする', '期限', '今日', '期限切れ · {date}', '今週', '表示', '非表示'],
} satisfies Record<keyof typeof messages, TranslatedKeys<typeof pageKeys>>;

const placeKeys = ['where.purpose', 'where.cannotCreate', 'where.change'] as const;
const placeMessages = {
  en: ['Where does it belong? It’s created there and stays there.', 'Tasks can’t be created here', 'Change'],
  de: ['Wohin gehört sie? Sie wird dort erstellt und bleibt dort.', 'Hier können keine Aufgaben erstellt werden', 'Ändern'],
  ru: ['Где она должна быть? Задача создаётся там и там остаётся.', 'Здесь нельзя создавать задачи', 'Изменить'],
  pl: ['Gdzie ma trafić? Zostanie tam utworzone i tam zostanie.', 'Tutaj nie można tworzyć zadań', 'Zmień'],
  es: ['¿Dónde va? Se crea allí y allí se queda.', 'Aquí no se pueden crear tareas', 'Cambiar'],
  fr: ['Où la placer ? Elle y est créée et y reste.', 'Impossible de créer des tâches ici', 'Changer'],
  it: ['Dove va? Viene creata lì e lì rimane.', 'Qui non si possono creare attività', 'Cambia'],
  pt: ['Onde ela fica? É criada lá e permanece lá.', 'Não é possível criar tarefas aqui', 'Alterar'],
  ca: ['On va? Es crea allà i s’hi queda.', 'Aquí no es poden crear tasques', 'Canvia'],
  'zh-Hans': ['它属于哪里？任务会在那里创建并保留在那里。', '无法在此处创建任务', '更改'],
  'zh-Hant': ['它屬於哪裡？任務會在那裡建立並保留在那裡。', '無法在此處建立任務', '變更'],
  ja: ['どこに置きますか？タスクはそこで作成され、そこに残ります。', 'ここではタスクを作成できません', '変更'],
} satisfies Record<keyof typeof messages, TranslatedKeys<typeof placeKeys>>;

const draftUnavailable = {
  en: 'This task draft is no longer available. Open it again from the message or action.',
  de: 'Dieser Aufgabenentwurf ist nicht mehr verfügbar. Öffne ihn erneut über die Nachricht oder Aktion.',
  ru: 'Этот черновик задачи больше недоступен. Откройте его снова из сообщения или действия.',
  pl: 'Ten szkic zadania nie jest już dostępny. Otwórz go ponownie z wiadomości lub akcji.',
  es: 'Este borrador de tarea ya no está disponible. Ábrelo de nuevo desde el mensaje o la acción.',
  fr: 'Ce brouillon de tâche n’est plus disponible. Ouvrez-le à nouveau depuis le message ou l’action.',
  it: 'Questa bozza di attività non è più disponibile. Riaprila dal messaggio o dall’azione.',
  pt: 'Este rascunho de tarefa não está mais disponível. Abra-o novamente pela mensagem ou ação.',
  ca: 'Aquest esborrany de tasca ja no està disponible. Torna a obrir-lo des del missatge o l’acció.',
  'zh-Hans': '此任务草稿已不可用。请从消息或操作中重新打开。',
  'zh-Hant': '此任務草稿已無法使用。請從訊息或操作中重新開啟。',
  ja: 'このタスクの下書きは利用できなくなりました。メッセージまたはアクションからもう一度開いてください。',
} satisfies Record<keyof typeof messages, string>;

export const TRIAGE_TASK_UI_TRANSLATIONS = Object.fromEntries(Object.entries(messages).map(([locale, values]) => [locale,
  Object.fromEntries([
    ...keys.map((key, index) => [`plugins.triage.tasks.${key}`, values[index]!]),
    ['plugins.triage.tasks.draftUnavailable', draftUnavailable[locale as keyof typeof messages]],
    ...emptyKeys.map((key, index) => [`plugins.triage.tasks.${key}`, emptyMessages[locale as keyof typeof emptyMessages][index]!]),
    ...pageKeys.map((key, index) => [`plugins.triage.tasks.${key}`, pageMessages[locale as keyof typeof pageMessages][index]!]),
    ...placeKeys.map((key, index) => [`plugins.triage.tasks.${key}`, placeMessages[locale as keyof typeof placeMessages][index]!]),
  ]),
])) as Readonly<Record<keyof typeof messages, Readonly<Record<string, string>>>>;
