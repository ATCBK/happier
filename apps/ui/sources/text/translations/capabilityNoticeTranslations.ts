// Transcript capability notice copy (P1 U7): one quiet line when an MCP server or skill was left out of a Session.
// Mounted under `capabilities.notice`; the reason words cover the producer's known codes, anything else is shown as stored.

type Name = Readonly<{ name: string }>;
type Words = readonly [
  mcpTitle: string,
  skillTitle: string,
  missing: string,
  signIn: string,
  signInMismatch: string,
  bridge: string,
  skillLaunch: string,
  openMcp: string,
  openSkills: string,
];

function copy(words: Words) {
  const named = (text: string) => ({ name }: Name) => text.replace('{name}', name);
  return {
    couldntStart: named(words[0]),
    couldntLoad: named(words[1]),
    missing: ({ key }: Readonly<{ key: string }>) => words[2].replace('{key}', key),
    signIn: words[3],
    signInMismatch: words[4],
    bridge: words[5],
    skillLaunch: words[6],
    openMcp: words[7],
    openSkills: words[8],
  };
}

export const capabilityNoticeTranslations = {
  en: copy(['{name} couldn’t start', '{name} couldn’t load', 'missing {key}', 'needs sign-in', 'sign-in is for another address',
    'remote bridge unavailable', 'this agent can’t take skills this way', 'MCP servers', 'Skills']),
  ca: copy(['{name} no s’ha pogut iniciar', '{name} no s’ha pogut carregar', 'falta {key}', 'cal iniciar la sessió', 'l’inici de sessió és per a una altra adreça',
    'el pont remot no està disponible', 'aquest agent no pot rebre habilitats d’aquesta manera', 'Servidors MCP', 'Habilitats']),
  de: copy(['{name} konnte nicht starten', '{name} konnte nicht geladen werden', '{key} fehlt', 'Anmeldung erforderlich', 'die Anmeldung gilt für eine andere Adresse',
    'Remote-Bridge nicht verfügbar', 'dieser Agent kann Skills so nicht übernehmen', 'MCP-Server', 'Skills']),
  es: copy(['{name} no pudo iniciarse', '{name} no pudo cargarse', 'falta {key}', 'requiere iniciar sesión', 'el inicio de sesión es de otra dirección',
    'el puente remoto no está disponible', 'este agente no puede recibir habilidades así', 'Servidores MCP', 'Habilidades']),
  fr: copy(['{name} n’a pas pu démarrer', '{name} n’a pas pu se charger', '{key} manquant', 'connexion requise', 'la connexion correspond à une autre adresse',
    'pont distant indisponible', 'cet agent ne peut pas recevoir de compétences ainsi', 'Serveurs MCP', 'Compétences']),
  it: copy(['{name} non è riuscito ad avviarsi', '{name} non è stato caricato', 'manca {key}', 'serve l’accesso', 'l’accesso è per un altro indirizzo',
    'bridge remoto non disponibile', 'questo agente non può ricevere abilità così', 'Server MCP', 'Abilità']),
  ja: copy(['{name} を起動できませんでした', '{name} を読み込めませんでした', '{key} がありません', 'サインインが必要です', 'サインインは別のアドレス用です',
    'リモートブリッジを利用できません', 'このエージェントはこの方法でスキルを受け取れません', 'MCP サーバー', 'スキル']),
  pl: copy(['{name} nie uruchomił się', '{name} nie został załadowany', 'brak {key}', 'wymaga logowania', 'logowanie dotyczy innego adresu',
    'zdalny most niedostępny', 'ten agent nie może przyjąć umiejętności w ten sposób', 'Serwery MCP', 'Umiejętności']),
  pt: copy(['{name} não conseguiu iniciar', '{name} não pôde ser carregado', 'falta {key}', 'requer login', 'o login é de outro endereço',
    'ponte remota indisponível', 'este agente não pode receber habilidades assim', 'Servidores MCP', 'Habilidades']),
  ru: copy(['{name} не удалось запустить', '{name} не удалось загрузить', 'нет {key}', 'нужен вход', 'вход выполнен для другого адреса',
    'удалённый мост недоступен', 'этот агент не может получить навыки таким способом', 'Серверы MCP', 'Навыки']),
  zhHans: copy(['{name} 无法启动', '{name} 无法加载', '缺少 {key}', '需要登录', '登录对应的是另一个地址',
    '远程桥接不可用', '此智能体无法以这种方式接收技能', 'MCP 服务器', '技能']),
  zhHant: copy(['{name} 無法啟動', '{name} 無法載入', '缺少 {key}', '需要登入', '登入對應的是另一個位址',
    '遠端橋接無法使用', '此代理程式無法以這種方式接收技能', 'MCP 伺服器', '技能']),
} as const;
