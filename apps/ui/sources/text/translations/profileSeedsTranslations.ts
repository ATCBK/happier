// "Skills this Profile adds" in the Profile editor (P6 U6.12): mounted under `capabilities.profileSeeds`.

export type ProfileSeedsTranslation = Readonly<{
  title: string;
  description: string;
  add: string;
  /** Names the picker (the phone sheet's title). */
  addTitle: string;
  searchPlaceholder: string;
  nothingToAdd: string;
  empty: string;
  emptyLibrary: string;
  openSkills: string;
  missing: string;
  /** The row of a seed whose library has not answered: never the raw id. */
  pending: string;
  /** A seed the library knows but cannot open right now: named, never called missing. */
  unreadableItem: string;
  remove: ({ skill }: { skill: string }) => string;
  reading: string;
  unreadable: string;
  tryAgain: string;
}>;

const en: ProfileSeedsTranslation = {
  title: 'Skills this Profile adds',
  description: 'Added for sessions with this Profile, on top of what your rules give.',
  add: 'Add',
  addTitle: 'Add a skill',
  searchPlaceholder: 'Search your skills',
  nothingToAdd: 'Every skill in your library is already added.',
  empty: 'None yet. Sessions with this Profile get what your rules give.',
  emptyLibrary: 'Your library has no skills yet.',
  openSkills: 'Open Skills',
  missing: 'Not in your library',
  pending: 'Skill',
  unreadableItem: 'Can’t be read right now',
  remove: ({ skill }) => `Remove ${skill}`,
  reading: 'Reading your skills…',
  unreadable: 'Couldn’t read your skills',
  tryAgain: 'Try again',
};
const ca: ProfileSeedsTranslation = {
  title: 'Habilitats que afegeix aquest perfil',
  description: 'S’afegeixen a les sessions amb aquest perfil, a sobre del que donen les teves regles.',
  add: 'Afegeix',
  addTitle: 'Afegeix una habilitat',
  searchPlaceholder: 'Cerca a les teves habilitats',
  nothingToAdd: 'Totes les habilitats de la teva biblioteca ja s’han afegit.',
  empty: 'Encara cap. Les sessions amb aquest perfil reben el que donen les teves regles.',
  emptyLibrary: 'La teva biblioteca encara no té habilitats.',
  openSkills: 'Obre Habilitats',
  missing: 'No és a la teva biblioteca',
  pending: 'Habilitat',
  unreadableItem: 'Ara no es pot llegir',
  remove: ({ skill }) => `Treu ${skill}`,
  reading: 'Llegint les teves habilitats…',
  unreadable: 'No s’han pogut llegir les teves habilitats',
  tryAgain: 'Torna-ho a provar',
};
const de: ProfileSeedsTranslation = {
  title: 'Skills, die dieses Profil hinzufügt',
  description: 'Für Sitzungen mit diesem Profil hinzugefügt, zusätzlich zu dem, was deine Regeln geben.',
  add: 'Hinzufügen',
  addTitle: 'Skill hinzufügen',
  searchPlaceholder: 'Deine Skills durchsuchen',
  nothingToAdd: 'Alle Skills deiner Bibliothek sind schon hinzugefügt.',
  empty: 'Noch keine. Sitzungen mit diesem Profil erhalten, was deine Regeln geben.',
  emptyLibrary: 'Deine Bibliothek enthält noch keine Skills.',
  openSkills: 'Skills öffnen',
  missing: 'Nicht in deiner Bibliothek',
  pending: 'Skill',
  unreadableItem: 'Lässt sich gerade nicht lesen',
  remove: ({ skill }) => `${skill} entfernen`,
  reading: 'Deine Skills werden gelesen …',
  unreadable: 'Deine Skills konnten nicht gelesen werden',
  tryAgain: 'Erneut versuchen',
};
const es: ProfileSeedsTranslation = {
  title: 'Skills que añade este perfil',
  description: 'Se añaden a las sesiones con este perfil, además de lo que dan tus reglas.',
  add: 'Añadir',
  addTitle: 'Añadir un skill',
  searchPlaceholder: 'Buscar en tus skills',
  nothingToAdd: 'Todos los skills de tu biblioteca ya están añadidos.',
  empty: 'Ninguno todavía. Las sesiones con este perfil reciben lo que dan tus reglas.',
  emptyLibrary: 'Tu biblioteca aún no tiene skills.',
  openSkills: 'Abrir Skills',
  missing: 'No está en tu biblioteca',
  pending: 'Skill',
  unreadableItem: 'No se puede leer ahora',
  remove: ({ skill }) => `Quitar ${skill}`,
  reading: 'Leyendo tus skills…',
  unreadable: 'No se pudieron leer tus skills',
  tryAgain: 'Reintentar',
};
const fr: ProfileSeedsTranslation = {
  title: 'Skills ajoutés par ce profil',
  description: 'Ajoutés aux sessions avec ce profil, en plus de ce que donnent vos règles.',
  add: 'Ajouter',
  addTitle: 'Ajouter un skill',
  searchPlaceholder: 'Rechercher dans vos skills',
  nothingToAdd: 'Tous les skills de votre bibliothèque sont déjà ajoutés.',
  empty: 'Aucun pour l’instant. Les sessions avec ce profil reçoivent ce que donnent vos règles.',
  emptyLibrary: 'Votre bibliothèque ne contient pas encore de skills.',
  openSkills: 'Ouvrir Skills',
  missing: 'Absent de votre bibliothèque',
  pending: 'Skill',
  unreadableItem: 'Illisible pour le moment',
  remove: ({ skill }) => `Retirer ${skill}`,
  reading: 'Lecture de vos skills…',
  unreadable: 'Impossible de lire vos skills',
  tryAgain: 'Réessayer',
};
const it: ProfileSeedsTranslation = {
  title: 'Skill aggiunte da questo profilo',
  description: 'Aggiunte alle sessioni con questo profilo, oltre a ciò che danno le tue regole.',
  add: 'Aggiungi',
  addTitle: 'Aggiungi una skill',
  searchPlaceholder: 'Cerca tra le tue skill',
  nothingToAdd: 'Tutte le skill della tua libreria sono già aggiunte.',
  empty: 'Nessuna per ora. Le sessioni con questo profilo ricevono ciò che danno le tue regole.',
  emptyLibrary: 'La tua libreria non ha ancora skill.',
  openSkills: 'Apri Skill',
  missing: 'Non è nella tua libreria',
  pending: 'Skill',
  unreadableItem: 'Al momento non si può leggere',
  remove: ({ skill }) => `Rimuovi ${skill}`,
  reading: 'Lettura delle tue skill…',
  unreadable: 'Impossibile leggere le tue skill',
  tryAgain: 'Riprova',
};
const ja: ProfileSeedsTranslation = {
  title: 'このプロファイルが追加するスキル',
  description: 'このプロファイルのセッションに、ルールで決まる内容に加えて追加されます。',
  add: '追加',
  addTitle: 'スキルを追加',
  searchPlaceholder: 'スキルを検索',
  nothingToAdd: 'ライブラリのスキルはすべて追加済みです。',
  empty: 'まだありません。このプロファイルのセッションには、ルールで決まる内容が適用されます。',
  emptyLibrary: 'ライブラリにはまだスキルがありません。',
  openSkills: 'スキルを開く',
  missing: 'ライブラリにありません',
  pending: 'スキル',
  unreadableItem: 'いまは読み込めません',
  remove: ({ skill }) => `${skill} を削除`,
  reading: 'スキルを読み込み中…',
  unreadable: 'スキルを読み込めませんでした',
  tryAgain: '再試行',
};
const pl: ProfileSeedsTranslation = {
  title: 'Umiejętności dodawane przez ten profil',
  description: 'Dodawane do sesji z tym profilem, oprócz tego, co dają twoje reguły.',
  add: 'Dodaj',
  addTitle: 'Dodaj umiejętność',
  searchPlaceholder: 'Szukaj w swoich umiejętnościach',
  nothingToAdd: 'Wszystkie umiejętności z twojej biblioteki są już dodane.',
  empty: 'Na razie brak. Sesje z tym profilem dostają to, co dają twoje reguły.',
  emptyLibrary: 'Twoja biblioteka nie ma jeszcze umiejętności.',
  openSkills: 'Otwórz Umiejętności',
  missing: 'Brak w twojej bibliotece',
  pending: 'Umiejętność',
  unreadableItem: 'Teraz nie można go odczytać',
  remove: ({ skill }) => `Usuń ${skill}`,
  reading: 'Wczytywanie twoich umiejętności…',
  unreadable: 'Nie udało się wczytać twoich umiejętności',
  tryAgain: 'Spróbuj ponownie',
};
const pt: ProfileSeedsTranslation = {
  title: 'Skills que este perfil adiciona',
  description: 'Adicionadas às sessões com este perfil, além do que as suas regras dão.',
  add: 'Adicionar',
  addTitle: 'Adicionar uma skill',
  searchPlaceholder: 'Pesquisar nas suas skills',
  nothingToAdd: 'Todas as skills da sua biblioteca já foram adicionadas.',
  empty: 'Nenhuma ainda. As sessões com este perfil recebem o que as suas regras dão.',
  emptyLibrary: 'A sua biblioteca ainda não tem skills.',
  openSkills: 'Abrir Skills',
  missing: 'Não está na sua biblioteca',
  pending: 'Skill',
  unreadableItem: 'Não é possível ler agora',
  remove: ({ skill }) => `Remover ${skill}`,
  reading: 'A ler as suas skills…',
  unreadable: 'Não foi possível ler as suas skills',
  tryAgain: 'Tentar novamente',
};
const ru: ProfileSeedsTranslation = {
  title: 'Навыки, которые добавляет этот профиль',
  description: 'Добавляются в сессии с этим профилем сверх того, что дают ваши правила.',
  add: 'Добавить',
  addTitle: 'Добавить навык',
  searchPlaceholder: 'Поиск по вашим навыкам',
  nothingToAdd: 'Все навыки из вашей библиотеки уже добавлены.',
  empty: 'Пока нет. Сессии с этим профилем получают то, что дают ваши правила.',
  emptyLibrary: 'В вашей библиотеке пока нет навыков.',
  openSkills: 'Открыть навыки',
  missing: 'Нет в вашей библиотеке',
  pending: 'Навык',
  unreadableItem: 'Сейчас не удаётся прочитать',
  remove: ({ skill }) => `Убрать ${skill}`,
  reading: 'Чтение ваших навыков…',
  unreadable: 'Не удалось прочитать ваши навыки',
  tryAgain: 'Повторить',
};
const zhHans: ProfileSeedsTranslation = {
  title: '此配置添加的技能',
  description: '在使用此配置的会话中添加，叠加在你的规则所提供的内容之上。',
  add: '添加',
  addTitle: '添加技能',
  searchPlaceholder: '搜索你的技能',
  nothingToAdd: '你库中的所有技能都已添加。',
  empty: '暂无。使用此配置的会话会获得你的规则所提供的内容。',
  emptyLibrary: '你的库中还没有技能。',
  openSkills: '打开技能',
  missing: '不在你的库中',
  pending: '技能',
  unreadableItem: '暂时无法读取',
  remove: ({ skill }) => `移除 ${skill}`,
  reading: '正在读取你的技能…',
  unreadable: '无法读取你的技能',
  tryAgain: '重试',
};
const zhHant: ProfileSeedsTranslation = {
  title: '此設定檔新增的技能',
  description: '新增至使用此設定檔的工作階段，疊加在你的規則所提供的內容之上。',
  add: '新增',
  addTitle: '新增技能',
  searchPlaceholder: '搜尋你的技能',
  nothingToAdd: '你資料庫中的所有技能都已新增。',
  empty: '尚無。使用此設定檔的工作階段會獲得你的規則所提供的內容。',
  emptyLibrary: '你的資料庫中還沒有技能。',
  openSkills: '開啟技能',
  missing: '不在你的資料庫中',
  pending: '技能',
  unreadableItem: '暫時無法讀取',
  remove: ({ skill }) => `移除 ${skill}`,
  reading: '正在讀取你的技能…',
  unreadable: '無法讀取你的技能',
  tryAgain: '重試',
};

export const profileSeedsTranslations = { en, ca, de, es, fr, it, ja, pl, pt, ru, zhHans, zhHant } as const;
