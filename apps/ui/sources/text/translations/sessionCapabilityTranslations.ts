type ApplyParams = Readonly<{ item: string; machine: string }>;
type ApplyWords = readonly [string, string, string, string, string, string, string, string, string, string, string, string];
function copy(words: ApplyWords, appliedNow: string, always: string, alwaysFor: string, wants: string, sheet: readonly [string, string, string, string, string, string]) {
    const format = (text: string) => ({ item, machine }: ApplyParams) => text.replace('{item}', () => item).replace('{machine}', () => machine);
    return {
        thisSession: sheet[0], loadedWhenUsed: sheet[1], mcpServers: sheet[2], toolsEveryTurn: sheet[3], costUnknown: sheet[4],
        counts: ({ skills, mcp }: Readonly<{ skills: number; mcp: number }>) =>
            [skills || !mcp ? `${skills} ${sheet[5]}` : '', mcp ? `${mcp} MCP` : ''].filter(Boolean).join(' · '),
        apply: { addedNow: format(words[0]), removedNow: format(words[1]), appliedNow: format(appliedNow), joinsNextTurn: format(words[2]), leavesNextTurn: format(words[3]),
            pendingNextTurn: format(words[4]), newSessionsOnly: format(words[5]), offline: format(words[6]), restart: format(words[7]),
            restartTerminal: format(words[8]), cannotResume: format(words[9]), nextStart: format(words[10]), saved: format(words[11]) },
        always: ({ place }: Readonly<{ place: string }>) => always.replace('{place}', () => place),
        alwaysFor: ({ agent, place }: Readonly<{ agent: string; place: string }>) => alwaysFor.replace('{agent}', () => agent).replace('{place}', () => place),
        wants: ({ agent, item }: Readonly<{ agent: string; item: string }>) => wants.replace('{agent}', () => agent).replace('{item}', () => item),
    };
}
const base = {
    en: copy(['{item} added · applied now', '{item} turned off · applied now', '{item} joins at the next turn', '{item} leaves at the next turn',
        'Changes apply at the next turn', 'Applies to new sessions', 'Applies when {machine} is back', 'Restart to apply',
        'Restart to apply · restart it from its terminal', "Couldn't apply · this session can't resume", 'Applies on the next start', 'Change saved'],
        'Changes applied now', 'Always in {place}', 'Always for {agent} in {place}', '{agent} wants {item} for this session',
        ['This session', 'Loaded when used', 'MCP servers', 'Tools · tokens every turn', 'Cost unknown', 'skills']),
    ca: copy(['{item} afegit · aplicat ara', '{item} desactivat · aplicat ara', '{item} s’afegeix al torn següent', '{item} es treu al torn següent',
        'Els canvis s’apliquen al torn següent', 'S’aplica a sessions noves', 'S’aplica quan {machine} torni', 'Reinicia per aplicar',
        'Reinicia per aplicar · reinicia des del terminal', 'No s’ha pogut aplicar · la sessió no es pot reprendre', 'S’aplica al pròxim inici', 'Canvi desat'],
        'Canvis aplicats ara', 'Sempre a {place}', 'Sempre per a {agent} a {place}', '{agent} vol {item} per a aquesta sessió',
        ['Aquesta sessió', 'Es carreguen quan s’utilitzen', 'Servidors MCP', 'Eines · tokens cada torn', 'Cost desconegut', 'habilitats']),
    de: copy(['{item} hinzugefügt · jetzt angewendet', '{item} ausgeschaltet · jetzt angewendet', '{item} kommt im nächsten Zug hinzu', '{item} entfällt im nächsten Zug',
        'Änderungen gelten ab dem nächsten Zug', 'Gilt für neue Sitzungen', 'Gilt, sobald {machine} wieder da ist', 'Zum Anwenden neu starten',
        'Zum Anwenden neu starten · im Terminal neu starten', 'Anwenden fehlgeschlagen · diese Sitzung kann nicht fortgesetzt werden', 'Gilt beim nächsten Start', 'Änderung gespeichert'],
        'Änderungen jetzt angewendet', 'Immer in {place}', 'Immer für {agent} in {place}', '{agent} möchte {item} für diese Sitzung',
        ['Diese Sitzung', 'Bei Bedarf geladen', 'MCP-Server', 'Tools · Tokens pro Zug', 'Kosten unbekannt', 'Skills']),
    es: copy(['{item} añadido · aplicado ahora', '{item} desactivado · aplicado ahora', '{item} se añade en el siguiente turno', '{item} se quita en el siguiente turno',
        'Los cambios se aplican en el siguiente turno', 'Se aplica a sesiones nuevas', 'Se aplica cuando {machine} vuelva', 'Reinicia para aplicar',
        'Reinicia para aplicar · reinicia desde su terminal', 'No se pudo aplicar · esta sesión no puede reanudarse', 'Se aplica en el siguiente inicio', 'Cambio guardado'],
        'Cambios aplicados ahora', 'Siempre en {place}', 'Siempre para {agent} en {place}', '{agent} quiere {item} para esta sesión',
        ['Esta sesión', 'Se cargan al usarse', 'Servidores MCP', 'Herramientas · tokens cada turno', 'Coste desconocido', 'habilidades']),
    fr: copy(['{item} ajouté · appliqué maintenant', '{item} désactivé · appliqué maintenant', '{item} rejoint au prochain tour', '{item} est retiré au prochain tour',
        'Les modifications s’appliquent au prochain tour', 'S’applique aux nouvelles sessions', 'S’applique au retour de {machine}', 'Redémarrer pour appliquer',
        'Redémarrer pour appliquer · depuis son terminal', 'Application impossible · cette session ne peut pas reprendre', 'S’applique au prochain démarrage', 'Modification enregistrée'],
        'Modifications appliquées maintenant', 'Toujours dans {place}', 'Toujours pour {agent} dans {place}', '{agent} souhaite {item} pour cette session',
        ['Cette session', 'Chargées à l’utilisation', 'Serveurs MCP', 'Outils · tokens à chaque tour', 'Coût inconnu', 'compétences']),
    it: copy(['{item} aggiunto · applicato ora', '{item} disattivato · applicato ora', '{item} si aggiunge al prossimo turno', '{item} viene rimosso al prossimo turno',
        'Le modifiche si applicano al prossimo turno', 'Si applica alle nuove sessioni', 'Si applica quando {machine} torna', 'Riavvia per applicare',
        'Riavvia per applicare · dal suo terminale', 'Impossibile applicare · questa sessione non può riprendere', 'Si applica al prossimo avvio', 'Modifica salvata'],
        'Modifiche applicate ora', 'Sempre in {place}', 'Sempre per {agent} in {place}', '{agent} vuole {item} per questa sessione',
        ['Questa sessione', 'Caricate quando usate', 'Server MCP', 'Strumenti · token a ogni turno', 'Costo sconosciuto', 'abilità']),
    ja: copy(['{item} を追加 · 適用済み', '{item} をオフ · 適用済み', '{item} は次のターンで追加されます', '{item} は次のターンで外れます',
        '変更は次のターンで適用されます', '新しいセッションに適用', '{machine} が戻ると適用', '再起動して適用',
        '再起動して適用 · ターミナルから再起動してください', '適用できません · このセッションは再開できません', '次の起動時に適用', '変更を保存しました'],
        '変更を適用しました', '{place} で常に許可', '{place} で {agent} に常に許可', '{agent} がこのセッションで {item} を使いたいと要求しています',
        ['このセッション', '使用時に読み込み', 'MCP サーバー', 'ツール · 毎ターンのトークン', 'コスト不明', 'スキル']),
    pl: copy(['{item} dodano · zastosowano', '{item} wyłączono · zastosowano', '{item} zostanie dodane w następnej turze', '{item} zostanie usunięte w następnej turze',
        'Zmiany zostaną zastosowane w następnej turze', 'Dotyczy nowych sesji', 'Zostanie zastosowane, gdy {machine} wróci', 'Uruchom ponownie, aby zastosować',
        'Uruchom ponownie, aby zastosować · ze swojego terminala', 'Nie można zastosować · tej sesji nie można wznowić', 'Dotyczy następnego uruchomienia', 'Zmiana zapisana'],
        'Zmiany zastosowane', 'Zawsze w {place}', 'Zawsze dla {agent} w {place}', '{agent} chce {item} w tej sesji',
        ['Ta sesja', 'Ładowane przy użyciu', 'Serwery MCP', 'Narzędzia · tokeny w każdej turze', 'Koszt nieznany', 'umiejętności']),
    pt: copy(['{item} adicionado · aplicado agora', '{item} desativado · aplicado agora', '{item} entra no próximo turno', '{item} sai no próximo turno',
        'As alterações aplicam-se no próximo turno', 'Aplica-se a novas sessões', 'Aplica-se quando {machine} voltar', 'Reinicie para aplicar',
        'Reinicie para aplicar · a partir do terminal', 'Não foi possível aplicar · esta sessão não pode ser retomada', 'Aplica-se na próxima inicialização', 'Alteração salva'],
        'Alterações aplicadas agora', 'Sempre em {place}', 'Sempre para {agent} em {place}', '{agent} quer {item} para esta sessão',
        ['Esta sessão', 'Carregadas quando usadas', 'Servidores MCP', 'Ferramentas · tokens a cada turno', 'Custo desconhecido', 'habilidades']),
    ru: copy(['{item} добавлено · применено', '{item} отключено · применено', '{item} добавится на следующем ходе', '{item} отключится на следующем ходе',
        'Изменения применятся на следующем ходе', 'Применяется к новым сессиям', 'Применится, когда {machine} вернётся', 'Перезапустите для применения',
        'Перезапустите для применения · из терминала сессии', 'Не удалось применить · эту сессию нельзя возобновить', 'Применится при следующем запуске', 'Изменение сохранено'],
        'Изменения применены', 'Всегда в {place}', 'Всегда для {agent} в {place}', '{agent} хочет использовать {item} в этой сессии',
        ['Эта сессия', 'Загружаются при использовании', 'Серверы MCP', 'Инструменты · токены на каждом ходе', 'Стоимость неизвестна', 'навыков']),
    zhHans: copy(['已添加 {item} · 已立即应用', '已关闭 {item} · 已立即应用', '{item} 将在下一轮加入', '{item} 将在下一轮移除',
        '更改将在下一轮应用', '应用于新会话', '{machine} 恢复后应用', '重启以应用', '重启以应用 · 请从会话终端重启', '无法应用 · 此会话无法恢复', '下次启动时应用', '更改已保存'],
        '更改已立即应用', '在 {place} 中始终允许', '在 {place} 中始终允许 {agent}', '{agent} 希望在此会话中使用 {item}',
        ['此会话', '使用时加载', 'MCP 服务器', '工具 · 每轮 token', '费用未知', '技能']),
    zhHant: copy(['已新增 {item} · 已立即套用', '已關閉 {item} · 已立即套用', '{item} 將在下一輪加入', '{item} 將在下一輪移除',
        '變更將在下一輪套用', '套用於新工作階段', '{machine} 恢復後套用', '重新啟動以套用', '重新啟動以套用 · 請從工作階段終端重新啟動', '無法套用 · 此工作階段無法繼續', '下次啟動時套用', '變更已儲存'],
        '變更已立即套用', '在 {place} 中永遠允許', '在 {place} 中永遠允許 {agent}', '{agent} 希望在此工作階段中使用 {item}',
        ['此工作階段', '使用時載入', 'MCP 伺服器', '工具 · 每輪 token', '費用未知', '技能']),
} as const;

type SheetWords = readonly [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];
function sheet(w: SheetWords) {
    const fill = (text: string, params: Readonly<Record<string, string | number>>) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ''));
    return { title: w[0], added: w[1], turnedOff: w[2], add: w[3], search: w[4], noMatch: ({ query }: Readonly<{ query: string }>) => fill(w[5], { query }),
        nothingToAdd: w[6], noSkills: w[7], noServers: w[8], browse: w[9], checking: w[10], checkFailed: w[11],
        offline: ({ machine }: Readonly<{ machine: string }>) => fill(w[12], { machine }),
        nativeFound: ({ count, machine }: Readonly<{ count: number; machine: string }>) => fill(w[13], { count, machine }),
        nativeCantTurnOff: ({ agent }: Readonly<{ agent: string }>) => fill(w[14], { agent }),
        removeLabel: ({ item }: Readonly<{ item: string }>) => fill(w[15], { item }),
        turnOnLabel: ({ item }: Readonly<{ item: string }>) => fill(w[16], { item }) };
}
/** The D34 Restart line's own states (the idle words are `apply.restart`). */
function restart(restarting: string, failed: string) {
    return { restarting, failed };
}
/** P8 owns the apply and sheet words; every surface consumes this same locale projection. */
export const sessionCapabilityTranslations = {
    en: { ...base.en, sheet: sheet(['This session gets', 'Added for this session', 'Off for this session', 'Add a skill or MCP server', 'Search skills and MCP servers', 'Nothing matches “{query}”', 'Everything available is already on', 'No skills for this session', 'No MCP servers yet', 'Browse', 'Checking what this session gets…', 'Couldn’t check what this session gets', '{machine} is offline', 'Also {count} skills found on {machine}', '{agent} can’t turn these off per session', 'Turn {item} off for this session', 'Turn {item} on for this session']), restart: restart('Restarting…', "Couldn't restart · Try again") },
    ca: { ...base.ca, sheet: sheet(['Aquesta sessió té', 'Afegit per a aquesta sessió', 'Desactivat per a aquesta sessió', 'Afegeix una habilitat o un servidor MCP', 'Cerca habilitats i servidors MCP', 'Res no coincideix amb «{query}»', 'Tot el que hi ha disponible ja està activat', 'Cap habilitat per a aquesta sessió', 'Encara no hi ha servidors MCP', 'Explora', 'Comprovant què té aquesta sessió…', 'No s’ha pogut comprovar què té aquesta sessió', '{machine} està fora de línia', 'També {count} habilitats trobades a {machine}', '{agent} no les pot desactivar per sessió', 'Desactiva {item} per a aquesta sessió', 'Activa {item} per a aquesta sessió']), restart: restart('Reiniciant…', 'No s’ha pogut reiniciar · Torna-ho a provar') },
    de: { ...base.de, sheet: sheet(['Diese Sitzung bekommt', 'Für diese Sitzung hinzugefügt', 'Für diese Sitzung aus', 'Skill oder MCP-Server hinzufügen', 'Skills und MCP-Server suchen', 'Nichts passt zu „{query}“', 'Alles Verfügbare ist schon an', 'Keine Skills für diese Sitzung', 'Noch keine MCP-Server', 'Durchsuchen', 'Prüfe, was diese Sitzung bekommt…', 'Konnte nicht prüfen, was diese Sitzung bekommt', '{machine} ist offline', 'Außerdem {count} Skills auf {machine} gefunden', '{agent} kann diese nicht pro Sitzung ausschalten', '{item} für diese Sitzung ausschalten', '{item} für diese Sitzung einschalten']), restart: restart('Wird neu gestartet…', 'Neustart fehlgeschlagen · Erneut versuchen') },
    es: { ...base.es, sheet: sheet(['Esta sesión tiene', 'Añadido para esta sesión', 'Desactivado para esta sesión', 'Añadir una habilidad o un servidor MCP', 'Buscar habilidades y servidores MCP', 'Nada coincide con «{query}»', 'Todo lo disponible ya está activado', 'Ninguna habilidad para esta sesión', 'Aún no hay servidores MCP', 'Explorar', 'Comprobando qué tiene esta sesión…', 'No se pudo comprobar qué tiene esta sesión', '{machine} está sin conexión', 'También {count} habilidades encontradas en {machine}', '{agent} no puede desactivarlas por sesión', 'Desactivar {item} para esta sesión', 'Activar {item} para esta sesión']), restart: restart('Reiniciando…', 'No se pudo reiniciar · Reintentar') },
    fr: { ...base.fr, sheet: sheet(['Cette session obtient', 'Ajouté pour cette session', 'Désactivé pour cette session', 'Ajouter une compétence ou un serveur MCP', 'Rechercher des compétences et serveurs MCP', 'Rien ne correspond à « {query} »', 'Tout ce qui est disponible est déjà activé', 'Aucune compétence pour cette session', 'Aucun serveur MCP pour l’instant', 'Parcourir', 'Vérification de ce que cette session obtient…', 'Impossible de vérifier ce que cette session obtient', '{machine} est hors ligne', 'Aussi {count} compétences trouvées sur {machine}', '{agent} ne peut pas les désactiver par session', 'Désactiver {item} pour cette session', 'Activer {item} pour cette session']), restart: restart('Redémarrage…', 'Impossible de redémarrer · Réessayer') },
    it: { ...base.it, sheet: sheet(['Questa sessione ottiene', 'Aggiunto per questa sessione', 'Disattivato per questa sessione', 'Aggiungi un’abilità o un server MCP', 'Cerca abilità e server MCP', 'Nessun risultato per «{query}»', 'Tutto ciò che è disponibile è già attivo', 'Nessuna abilità per questa sessione', 'Ancora nessun server MCP', 'Sfoglia', 'Verifica di cosa ottiene questa sessione…', 'Impossibile verificare cosa ottiene questa sessione', '{machine} è offline', 'Anche {count} abilità trovate su {machine}', '{agent} non può disattivarle per sessione', 'Disattiva {item} per questa sessione', 'Attiva {item} per questa sessione']), restart: restart('Riavvio…', 'Impossibile riavviare · Riprova') },
    ja: { ...base.ja, sheet: sheet(['このセッションで使えるもの', 'このセッションに追加', 'このセッションではオフ', 'スキルまたは MCP サーバーを追加', 'スキルと MCP サーバーを検索', '「{query}」に一致するものはありません', '利用できるものはすべてオンです', 'このセッションのスキルはありません', 'MCP サーバーはまだありません', '見る', 'このセッションの内容を確認中…', 'このセッションの内容を確認できませんでした', '{machine} はオフラインです', '{machine} で見つかったスキルがさらに {count} 件', '{agent} はセッションごとにオフにできません', 'このセッションで {item} をオフにする', 'このセッションで {item} をオンにする']), restart: restart('再起動中…', '再起動できませんでした · 再試行') },
    pl: { ...base.pl, sheet: sheet(['Ta sesja otrzymuje', 'Dodano dla tej sesji', 'Wyłączone dla tej sesji', 'Dodaj umiejętność lub serwer MCP', 'Szukaj umiejętności i serwerów MCP', 'Nic nie pasuje do „{query}”', 'Wszystko, co dostępne, jest już włączone', 'Brak umiejętności dla tej sesji', 'Nie ma jeszcze serwerów MCP', 'Przeglądaj', 'Sprawdzanie, co otrzymuje ta sesja…', 'Nie udało się sprawdzić, co otrzymuje ta sesja', '{machine} jest offline', 'Także {count} umiejętności znalezionych na {machine}', '{agent} nie może ich wyłączać dla sesji', 'Wyłącz {item} dla tej sesji', 'Włącz {item} dla tej sesji']), restart: restart('Ponowne uruchamianie…', 'Nie udało się uruchomić ponownie · Spróbuj ponownie') },
    pt: { ...base.pt, sheet: sheet(['Esta sessão recebe', 'Adicionado para esta sessão', 'Desativado para esta sessão', 'Adicionar uma habilidade ou servidor MCP', 'Pesquisar habilidades e servidores MCP', 'Nada corresponde a «{query}»', 'Tudo o que está disponível já está ativo', 'Nenhuma habilidade para esta sessão', 'Ainda não há servidores MCP', 'Explorar', 'A verificar o que esta sessão recebe…', 'Não foi possível verificar o que esta sessão recebe', '{machine} está offline', 'Mais {count} habilidades encontradas em {machine}', '{agent} não as pode desativar por sessão', 'Desativar {item} para esta sessão', 'Ativar {item} para esta sessão']), restart: restart('A reiniciar…', 'Não foi possível reiniciar · Tentar novamente') },
    ru: { ...base.ru, sheet: sheet(['Эта сессия получает', 'Добавлено для этой сессии', 'Отключено для этой сессии', 'Добавить навык или сервер MCP', 'Искать навыки и серверы MCP', 'Ничего не найдено по запросу «{query}»', 'Всё доступное уже включено', 'Нет навыков для этой сессии', 'Серверов MCP пока нет', 'Обзор', 'Проверяем, что получает эта сессия…', 'Не удалось проверить, что получает эта сессия', '{machine} не в сети', 'Ещё {count} навыков найдено на {machine}', '{agent} не может отключать их для сессии', 'Отключить {item} для этой сессии', 'Включить {item} для этой сессии']), restart: restart('Перезапуск…', 'Не удалось перезапустить · Повторить') },
    zhHans: { ...base.zhHans, sheet: sheet(['此会话可用', '已为此会话添加', '此会话中已关闭', '添加技能或 MCP 服务器', '搜索技能和 MCP 服务器', '没有与“{query}”匹配的内容', '可用的都已开启', '此会话没有技能', '还没有 MCP 服务器', '浏览', '正在检查此会话可用的内容…', '无法检查此会话可用的内容', '{machine} 已离线', '另在 {machine} 上找到 {count} 个技能', '{agent} 无法按会话关闭这些技能', '在此会话中关闭 {item}', '在此会话中开启 {item}']), restart: restart('正在重启…', '无法重启 · 重试') },
    zhHant: { ...base.zhHant, sheet: sheet(['此工作階段可用', '已為此工作階段新增', '此工作階段中已關閉', '新增技能或 MCP 伺服器', '搜尋技能和 MCP 伺服器', '沒有與「{query}」相符的內容', '可用的都已開啟', '此工作階段沒有技能', '還沒有 MCP 伺服器', '瀏覽', '正在檢查此工作階段可用的內容…', '無法檢查此工作階段可用的內容', '{machine} 已離線', '另在 {machine} 上找到 {count} 個技能', '{agent} 無法依工作階段關閉這些技能', '在此工作階段中關閉 {item}', '在此工作階段中開啟 {item}']), restart: restart('正在重新啟動…', '無法重新啟動 · 重試') },
} as const;
