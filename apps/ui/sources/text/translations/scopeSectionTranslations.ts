// Copy for the "Skills and MCP servers" section a machine page and a project page share (P8 U8.6, lab xs-M/Mp/P/Pp).
// Mounted under `capabilities.scopeSection`. Templates use {name} placeholders; `foundOne` is the singular line.

type Params = Readonly<Record<string, string | number>>;
type Template = (params: Params) => string;

type Words = Readonly<{
  title: string;
  descMachine: string;
  descProject: string;
  descProjectTeam: string;
  skills: string;
  mcp: string;
  allSkills: string;
  allMcp: string;
  foundOne: string;
  foundMany: string;
  foundLink: string;
  onFor: string;
  notFor: string;
  onOn: string;
  notOn: string;
  onIn: string;
  offIn: string;
  onForPlace: string;
  offForPlace: string;
  emptySkills: string;
  addSkill: string;
  emptyMcp: string;
  addMcp: string;
  loadFailed: string;
  whenRunning: string;
  turnedOn: string;
  turnedOff: string;
  migrationNote: string;
  dismiss: string;
}>;

const fill =
  (template: string): Template =>
  (params) =>
    template.replace(/\{(\w+)\}/g, (_, key: string) =>
      String(params[key] ?? ''),
    );

function copy(words: Words) {
  const foundOne = fill(words.foundOne);
  const foundMany = fill(words.foundMany);
  return {
    title: words.title,
    descMachine: fill(words.descMachine) as (
      params: Readonly<{ machine: string }>,
    ) => string,
    descProject: fill(words.descProject) as (
      params: Readonly<{ project: string }>,
    ) => string,
    descProjectTeam: fill(words.descProjectTeam) as (
      params: Readonly<{ project: string; team: string }>,
    ) => string,
    skills: words.skills,
    mcp: words.mcp,
    allSkills: fill(words.allSkills) as (
      params: Readonly<{ count: number }>,
    ) => string,
    allMcp: fill(words.allMcp) as (
      params: Readonly<{ count: number }>,
    ) => string,
    foundMore: (params: Readonly<{ count: number; machine: string }>) =>
      (params.count === 1 ? foundOne : foundMany)(params),
    foundLink: words.foundLink,
    onFor: fill(words.onFor) as (
      params: Readonly<{ agents: string }>,
    ) => string,
    notFor: fill(words.notFor) as (
      params: Readonly<{ agents: string }>,
    ) => string,
    onOn: fill(words.onOn) as (
      params: Readonly<{ machines: string }>,
    ) => string,
    notOn: fill(words.notOn) as (
      params: Readonly<{ machines: string }>,
    ) => string,
    onIn: fill(words.onIn) as (params: Readonly<{ place: string }>) => string,
    offIn: fill(words.offIn) as (params: Readonly<{ place: string }>) => string,
    onForPlace: fill(words.onForPlace) as (
      params: Readonly<{ place: string }>,
    ) => string,
    offForPlace: fill(words.offForPlace) as (
      params: Readonly<{ place: string }>,
    ) => string,
    emptySkills: words.emptySkills,
    addSkill: words.addSkill,
    emptyMcp: words.emptyMcp,
    addMcp: words.addMcp,
    loadFailed: words.loadFailed,
    whenRunning: fill(words.whenRunning) as (
      params: Readonly<{ machine: string }>,
    ) => string,
    turnedOn: fill(words.turnedOn) as (
      params: Readonly<{ name: string; place: string }>,
    ) => string,
    turnedOff: fill(words.turnedOff) as (
      params: Readonly<{ name: string; place: string }>,
    ) => string,
    migrationNote: fill(words.migrationNote) as (
      params: Readonly<{ names: string }>,
    ) => string,
    dismiss: words.dismiss,
  };
}

export const scopeSectionTranslations = {
  en: copy({
    title: 'Skills and MCP servers',
    descMachine:
      'What sessions on {machine} get. A switch here sets a rule for {machine} only; agent exceptions still hold.',
    descProject:
      'Your sessions in {project} get these on every machine. A switch here sets a rule for {project} only; agent exceptions still hold.',
    descProjectTeam:
      'Your sessions in {project} get these on every machine. A switch here sets a rule for {project} only; {team}’s sessions follow their own.',
    skills: 'Skills',
    mcp: 'MCP servers',
    allSkills: 'All {count} skills',
    allMcp: 'All {count} MCP servers',
    foundOne: '1 more skill lives only on {machine}.',
    foundMany: '{count} more skills live only on {machine}.',
    foundLink: 'Found on your machines',
    onFor: 'On for {agents}',
    notFor: 'not {agents}',
    onOn: 'On on {machines}',
    notOn: 'not {machines}',
    onIn: 'On in {place}',
    offIn: 'Off in {place}',
    onForPlace: 'On for {place}',
    offForPlace: 'Off for {place}',
    emptySkills: 'No skills yet',
    addSkill: 'Add a skill',
    emptyMcp: 'No MCP servers yet',
    addMcp: 'Add a server',
    loadFailed: 'Couldn’t load',
    whenRunning: 'Listed once {machine} is running',
    turnedOn: '{name} is on for {place}',
    turnedOff: '{name} is off for {place}',
    migrationNote: '{names} moved here from your older project settings.',
    dismiss: 'Dismiss',
  }),
  ca: copy({
    title: 'Habilitats i servidors MCP',
    descMachine:
      'El que reben les sessions a {machine}. Un interruptor aquí defineix una regla només per a {machine}; les excepcions d’agent continuen vigents.',
    descProject:
      'Les teves sessions a {project} reben això a totes les màquines. Un interruptor aquí defineix una regla només per a {project}; les excepcions d’agent continuen vigents.',
    descProjectTeam:
      'Les teves sessions a {project} reben això a totes les màquines. Un interruptor aquí defineix una regla només per a {project}; les sessions de {team} segueixen les seves.',
    skills: 'Habilitats',
    mcp: 'Servidors MCP',
    allSkills: 'Totes les {count} habilitats',
    allMcp: 'Tots els {count} servidors MCP',
    foundOne: 'Una habilitat més només viu a {machine}.',
    foundMany: '{count} habilitats més només viuen a {machine}.',
    foundLink: 'Trobades a les teves màquines',
    onFor: 'Activat per a {agents}',
    notFor: 'no per a {agents}',
    onOn: 'Activat a {machines}',
    notOn: 'no a {machines}',
    onIn: 'Activat a {place}',
    offIn: 'Desactivat a {place}',
    onForPlace: 'Activat per a {place}',
    offForPlace: 'Desactivat per a {place}',
    emptySkills: 'Encara no hi ha habilitats',
    addSkill: 'Afegeix una habilitat',
    emptyMcp: 'Encara no hi ha servidors MCP',
    addMcp: 'Afegeix un servidor',
    loadFailed: 'No s’ha pogut carregar',
    whenRunning: 'Es mostra quan {machine} estigui en marxa',
    turnedOn: '{name} està activat per a {place}',
    turnedOff: '{name} està desactivat per a {place}',
    migrationNote:
      '{names} s’ha mogut aquí des de la configuració antiga del projecte.',
    dismiss: 'Descarta',
  }),
  de: copy({
    title: 'Skills und MCP-Server',
    descMachine:
      'Was Sitzungen auf {machine} bekommen. Ein Schalter hier setzt eine Regel nur für {machine}; Ausnahmen für Agenten gelten weiter.',
    descProject:
      'Deine Sitzungen in {project} bekommen diese auf jeder Maschine. Ein Schalter hier setzt eine Regel nur für {project}; Ausnahmen für Agenten gelten weiter.',
    descProjectTeam:
      'Deine Sitzungen in {project} bekommen diese auf jeder Maschine. Ein Schalter hier setzt eine Regel nur für {project}; die Sitzungen von {team} folgen ihren eigenen.',
    skills: 'Skills',
    mcp: 'MCP-Server',
    allSkills: 'Alle {count} Skills',
    allMcp: 'Alle {count} MCP-Server',
    foundOne: '1 weiterer Skill liegt nur auf {machine}.',
    foundMany: '{count} weitere Skills liegen nur auf {machine}.',
    foundLink: 'Auf deinen Maschinen gefunden',
    onFor: 'An für {agents}',
    notFor: 'nicht {agents}',
    onOn: 'An auf {machines}',
    notOn: 'nicht {machines}',
    onIn: 'An in {place}',
    offIn: 'Aus in {place}',
    onForPlace: 'An für {place}',
    offForPlace: 'Aus für {place}',
    emptySkills: 'Noch keine Skills',
    addSkill: 'Skill hinzufügen',
    emptyMcp: 'Noch keine MCP-Server',
    addMcp: 'Server hinzufügen',
    loadFailed: 'Konnte nicht geladen werden',
    whenRunning: 'Erscheint, sobald {machine} läuft',
    turnedOn: '{name} ist für {place} an',
    turnedOff: '{name} ist für {place} aus',
    migrationNote:
      '{names} wurde aus den älteren Projekteinstellungen hierher verschoben.',
    dismiss: 'Schließen',
  }),
  es: copy({
    title: 'Habilidades y servidores MCP',
    descMachine:
      'Lo que reciben las sesiones en {machine}. Un interruptor aquí fija una regla solo para {machine}; las excepciones de agente siguen vigentes.',
    descProject:
      'Tus sesiones en {project} reciben esto en todas las máquinas. Un interruptor aquí fija una regla solo para {project}; las excepciones de agente siguen vigentes.',
    descProjectTeam:
      'Tus sesiones en {project} reciben esto en todas las máquinas. Un interruptor aquí fija una regla solo para {project}; las sesiones de {team} siguen las suyas.',
    skills: 'Habilidades',
    mcp: 'Servidores MCP',
    allSkills: 'Las {count} habilidades',
    allMcp: 'Los {count} servidores MCP',
    foundOne: '1 habilidad más vive solo en {machine}.',
    foundMany: '{count} habilidades más viven solo en {machine}.',
    foundLink: 'Encontradas en tus máquinas',
    onFor: 'Activado para {agents}',
    notFor: 'no para {agents}',
    onOn: 'Activado en {machines}',
    notOn: 'no en {machines}',
    onIn: 'Activado en {place}',
    offIn: 'Desactivado en {place}',
    onForPlace: 'Activado para {place}',
    offForPlace: 'Desactivado para {place}',
    emptySkills: 'Aún no hay habilidades',
    addSkill: 'Añadir una habilidad',
    emptyMcp: 'Aún no hay servidores MCP',
    addMcp: 'Añadir un servidor',
    loadFailed: 'No se pudo cargar',
    whenRunning: 'Aparece cuando {machine} esté en marcha',
    turnedOn: '{name} está activado para {place}',
    turnedOff: '{name} está desactivado para {place}',
    migrationNote:
      '{names} se movió aquí desde los ajustes anteriores del proyecto.',
    dismiss: 'Descartar',
  }),
  fr: copy({
    title: 'Compétences et serveurs MCP',
    descMachine:
      'Ce que reçoivent les sessions sur {machine}. Un interrupteur ici définit une règle pour {machine} uniquement ; les exceptions d’agent restent valables.',
    descProject:
      'Vos sessions dans {project} reçoivent ceci sur chaque machine. Un interrupteur ici définit une règle pour {project} uniquement ; les exceptions d’agent restent valables.',
    descProjectTeam:
      'Vos sessions dans {project} reçoivent ceci sur chaque machine. Un interrupteur ici définit une règle pour {project} uniquement ; les sessions de {team} suivent les leurs.',
    skills: 'Compétences',
    mcp: 'Serveurs MCP',
    allSkills: 'Les {count} compétences',
    allMcp: 'Les {count} serveurs MCP',
    foundOne: '1 compétence de plus ne se trouve que sur {machine}.',
    foundMany: '{count} compétences de plus ne se trouvent que sur {machine}.',
    foundLink: 'Trouvées sur vos machines',
    onFor: 'Activé pour {agents}',
    notFor: 'pas pour {agents}',
    onOn: 'Activé sur {machines}',
    notOn: 'pas sur {machines}',
    onIn: 'Activé dans {place}',
    offIn: 'Désactivé dans {place}',
    onForPlace: 'Activé pour {place}',
    offForPlace: 'Désactivé pour {place}',
    emptySkills: 'Aucune compétence pour l’instant',
    addSkill: 'Ajouter une compétence',
    emptyMcp: 'Aucun serveur MCP pour l’instant',
    addMcp: 'Ajouter un serveur',
    loadFailed: 'Chargement impossible',
    whenRunning: 'S’affiche quand {machine} est en marche',
    turnedOn: '{name} est activé pour {place}',
    turnedOff: '{name} est désactivé pour {place}',
    migrationNote:
      '{names} est arrivé ici depuis les anciens réglages du projet.',
    dismiss: 'Ignorer',
  }),
  it: copy({
    title: 'Abilità e server MCP',
    descMachine:
      'Ciò che ricevono le sessioni su {machine}. Un interruttore qui imposta una regola solo per {machine}; le eccezioni per agente restano valide.',
    descProject:
      'Le tue sessioni in {project} ricevono questi su ogni macchina. Un interruttore qui imposta una regola solo per {project}; le eccezioni per agente restano valide.',
    descProjectTeam:
      'Le tue sessioni in {project} ricevono questi su ogni macchina. Un interruttore qui imposta una regola solo per {project}; le sessioni di {team} seguono le proprie.',
    skills: 'Abilità',
    mcp: 'Server MCP',
    allSkills: 'Tutte le {count} abilità',
    allMcp: 'Tutti i {count} server MCP',
    foundOne: '1 abilità in più esiste solo su {machine}.',
    foundMany: '{count} abilità in più esistono solo su {machine}.',
    foundLink: 'Trovate sulle tue macchine',
    onFor: 'Attivo per {agents}',
    notFor: 'non per {agents}',
    onOn: 'Attivo su {machines}',
    notOn: 'non su {machines}',
    onIn: 'Attivo in {place}',
    offIn: 'Disattivo in {place}',
    onForPlace: 'Attivo per {place}',
    offForPlace: 'Disattivo per {place}',
    emptySkills: 'Ancora nessuna abilità',
    addSkill: 'Aggiungi un’abilità',
    emptyMcp: 'Ancora nessun server MCP',
    addMcp: 'Aggiungi un server',
    loadFailed: 'Impossibile caricare',
    whenRunning: 'Compare quando {machine} è in esecuzione',
    turnedOn: '{name} è attivo per {place}',
    turnedOff: '{name} è disattivo per {place}',
    migrationNote:
      '{names} è stato spostato qui dalle vecchie impostazioni del progetto.',
    dismiss: 'Chiudi',
  }),
  ja: copy({
    title: 'スキルと MCP サーバー',
    descMachine:
      '{machine} 上のセッションが受け取るものです。ここのスイッチは {machine} だけのルールを設定し、エージェントごとの例外は引き続き有効です。',
    descProject:
      '{project} のセッションは、どのマシンでもこれらを受け取ります。ここのスイッチは {project} だけのルールを設定し、エージェントごとの例外は引き続き有効です。',
    descProjectTeam:
      '{project} のセッションは、どのマシンでもこれらを受け取ります。ここのスイッチは {project} だけのルールを設定します。{team} のセッションは独自のルールに従います。',
    skills: 'スキル',
    mcp: 'MCP サーバー',
    allSkills: 'すべてのスキル（{count}）',
    allMcp: 'すべての MCP サーバー（{count}）',
    foundOne: '{machine} だけにあるスキルがほかに 1 件あります。',
    foundMany: '{machine} だけにあるスキルがほかに {count} 件あります。',
    foundLink: 'マシンで見つかったもの',
    onFor: '{agents} でオン',
    notFor: '{agents} ではオフ',
    onOn: '{machines} でオン',
    notOn: '{machines} ではオフ',
    onIn: '{place} でオン',
    offIn: '{place} でオフ',
    onForPlace: '{place} でオン',
    offForPlace: '{place} でオフ',
    emptySkills: 'スキルはまだありません',
    addSkill: 'スキルを追加',
    emptyMcp: 'MCP サーバーはまだありません',
    addMcp: 'サーバーを追加',
    loadFailed: '読み込めませんでした',
    whenRunning: '{machine} の実行中に表示されます',
    turnedOn: '{name} は {place} でオンです',
    turnedOff: '{name} は {place} でオフです',
    migrationNote: '{names} は以前のプロジェクト設定からここに移りました。',
    dismiss: '閉じる',
  }),
  pl: copy({
    title: 'Umiejętności i serwery MCP',
    descMachine:
      'To, co dostają sesje na {machine}. Przełącznik tutaj ustawia regułę tylko dla {machine}; wyjątki dla agentów nadal obowiązują.',
    descProject:
      'Twoje sesje w {project} dostają to na każdej maszynie. Przełącznik tutaj ustawia regułę tylko dla {project}; wyjątki dla agentów nadal obowiązują.',
    descProjectTeam:
      'Twoje sesje w {project} dostają to na każdej maszynie. Przełącznik tutaj ustawia regułę tylko dla {project}; sesje zespołu {team} mają własne zasady.',
    skills: 'Umiejętności',
    mcp: 'Serwery MCP',
    allSkills: 'Wszystkie umiejętności ({count})',
    allMcp: 'Wszystkie serwery MCP ({count})',
    foundOne: 'Jeszcze 1 umiejętność jest tylko na {machine}.',
    foundMany: 'Umiejętności tylko na {machine}: {count} więcej.',
    foundLink: 'Znalezione na Twoich maszynach',
    onFor: 'Włączone dla {agents}',
    notFor: 'nie dla {agents}',
    onOn: 'Włączone na {machines}',
    notOn: 'nie na {machines}',
    onIn: 'Włączone w {place}',
    offIn: 'Wyłączone w {place}',
    onForPlace: 'Włączone dla {place}',
    offForPlace: 'Wyłączone dla {place}',
    emptySkills: 'Brak umiejętności',
    addSkill: 'Dodaj umiejętność',
    emptyMcp: 'Brak serwerów MCP',
    addMcp: 'Dodaj serwer',
    loadFailed: 'Nie udało się wczytać',
    whenRunning: 'Pojawi się, gdy {machine} będzie działać',
    turnedOn: '{name} jest włączone dla {place}',
    turnedOff: '{name} jest wyłączone dla {place}',
    migrationNote: '{names} przeniesiono tutaj ze starszych ustawień projektu.',
    dismiss: 'Zamknij',
  }),
  pt: copy({
    title: 'Habilidades e servidores MCP',
    descMachine:
      'O que as sessões em {machine} recebem. Um interruptor aqui define uma regra só para {machine}; as exceções de agente continuam valendo.',
    descProject:
      'Suas sessões em {project} recebem isto em todas as máquinas. Um interruptor aqui define uma regra só para {project}; as exceções de agente continuam valendo.',
    descProjectTeam:
      'Suas sessões em {project} recebem isto em todas as máquinas. Um interruptor aqui define uma regra só para {project}; as sessões de {team} seguem as próprias.',
    skills: 'Habilidades',
    mcp: 'Servidores MCP',
    allSkills: 'Todas as {count} habilidades',
    allMcp: 'Todos os {count} servidores MCP',
    foundOne: 'Mais 1 habilidade existe só em {machine}.',
    foundMany: 'Mais {count} habilidades existem só em {machine}.',
    foundLink: 'Encontradas nas suas máquinas',
    onFor: 'Ativo para {agents}',
    notFor: 'não para {agents}',
    onOn: 'Ativo em {machines}',
    notOn: 'não em {machines}',
    onIn: 'Ativo em {place}',
    offIn: 'Desativado em {place}',
    onForPlace: 'Ativo para {place}',
    offForPlace: 'Desativado para {place}',
    emptySkills: 'Ainda não há habilidades',
    addSkill: 'Adicionar uma habilidade',
    emptyMcp: 'Ainda não há servidores MCP',
    addMcp: 'Adicionar um servidor',
    loadFailed: 'Não foi possível carregar',
    whenRunning: 'Aparece quando {machine} estiver em execução',
    turnedOn: '{name} está ativo para {place}',
    turnedOff: '{name} está desativado para {place}',
    migrationNote:
      '{names} foi movido para cá das configurações antigas do projeto.',
    dismiss: 'Dispensar',
  }),
  ru: copy({
    title: 'Навыки и серверы MCP',
    descMachine:
      'Что получают сессии на {machine}. Переключатель здесь задаёт правило только для {machine}; исключения для агентов по-прежнему действуют.',
    descProject:
      'Ваши сессии в {project} получают это на каждой машине. Переключатель здесь задаёт правило только для {project}; исключения для агентов по-прежнему действуют.',
    descProjectTeam:
      'Ваши сессии в {project} получают это на каждой машине. Переключатель здесь задаёт правило только для {project}; сессии {team} следуют своим правилам.',
    skills: 'Навыки',
    mcp: 'Серверы MCP',
    allSkills: 'Все навыки ({count})',
    allMcp: 'Все серверы MCP ({count})',
    foundOne: 'Ещё 1 навык есть только на {machine}.',
    foundMany: 'Навыки только на {machine}: ещё {count}.',
    foundLink: 'Найдено на ваших машинах',
    onFor: 'Включено для {agents}',
    notFor: 'не для {agents}',
    onOn: 'Включено на {machines}',
    notOn: 'не на {machines}',
    onIn: 'Включено в {place}',
    offIn: 'Выключено в {place}',
    onForPlace: 'Включено для {place}',
    offForPlace: 'Выключено для {place}',
    emptySkills: 'Навыков пока нет',
    addSkill: 'Добавить навык',
    emptyMcp: 'Серверов MCP пока нет',
    addMcp: 'Добавить сервер',
    loadFailed: 'Не удалось загрузить',
    whenRunning: 'Появится, когда {machine} запущена',
    turnedOn: '{name} включён для {place}',
    turnedOff: '{name} выключен для {place}',
    migrationNote: '{names} перенесён сюда из прежних настроек проекта.',
    dismiss: 'Скрыть',
  }),
  zhHans: copy({
    title: '技能与 MCP 服务器',
    descMachine:
      '{machine} 上的会话会获得这些内容。这里的开关只为 {machine} 设置规则；针对智能体的例外仍然有效。',
    descProject:
      '你在 {project} 中的会话在每台机器上都会获得这些内容。这里的开关只为 {project} 设置规则；针对智能体的例外仍然有效。',
    descProjectTeam:
      '你在 {project} 中的会话在每台机器上都会获得这些内容。这里的开关只为 {project} 设置规则；{team} 的会话遵循各自的规则。',
    skills: '技能',
    mcp: 'MCP 服务器',
    allSkills: '全部 {count} 个技能',
    allMcp: '全部 {count} 个 MCP 服务器',
    foundOne: '另有 1 个技能只存在于 {machine}。',
    foundMany: '另有 {count} 个技能只存在于 {machine}。',
    foundLink: '在你的机器上发现',
    onFor: '为 {agents} 开启',
    notFor: '不含 {agents}',
    onOn: '在 {machines} 上开启',
    notOn: '不含 {machines}',
    onIn: '在 {place} 中开启',
    offIn: '在 {place} 中关闭',
    onForPlace: '为 {place} 开启',
    offForPlace: '为 {place} 关闭',
    emptySkills: '还没有技能',
    addSkill: '添加技能',
    emptyMcp: '还没有 MCP 服务器',
    addMcp: '添加服务器',
    loadFailed: '无法加载',
    whenRunning: '{machine} 运行时显示',
    turnedOn: '{name} 已为 {place} 开启',
    turnedOff: '{name} 已为 {place} 关闭',
    migrationNote: '{names} 已从旧的项目设置移到这里。',
    dismiss: '关闭',
  }),
  zhHant: copy({
    title: '技能與 MCP 伺服器',
    descMachine:
      '{machine} 上的工作階段會取得這些內容。這裡的開關只為 {machine} 設定規則；針對代理程式的例外仍然有效。',
    descProject:
      '你在 {project} 中的工作階段在每台機器上都會取得這些內容。這裡的開關只為 {project} 設定規則；針對代理程式的例外仍然有效。',
    descProjectTeam:
      '你在 {project} 中的工作階段在每台機器上都會取得這些內容。這裡的開關只為 {project} 設定規則；{team} 的工作階段遵循各自的規則。',
    skills: '技能',
    mcp: 'MCP 伺服器',
    allSkills: '全部 {count} 個技能',
    allMcp: '全部 {count} 個 MCP 伺服器',
    foundOne: '另有 1 個技能只存在於 {machine}。',
    foundMany: '另有 {count} 個技能只存在於 {machine}。',
    foundLink: '在你的機器上發現',
    onFor: '為 {agents} 開啟',
    notFor: '不含 {agents}',
    onOn: '在 {machines} 上開啟',
    notOn: '不含 {machines}',
    onIn: '在 {place} 中開啟',
    offIn: '在 {place} 中關閉',
    onForPlace: '為 {place} 開啟',
    offForPlace: '為 {place} 關閉',
    emptySkills: '還沒有技能',
    addSkill: '新增技能',
    emptyMcp: '還沒有 MCP 伺服器',
    addMcp: '新增伺服器',
    loadFailed: '無法載入',
    whenRunning: '{machine} 執行時顯示',
    turnedOn: '{name} 已為 {place} 開啟',
    turnedOff: '{name} 已為 {place} 關閉',
    migrationNote: '{names} 已從舊的專案設定移到這裡。',
    dismiss: '關閉',
  }),
} as const;
