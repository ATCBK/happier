// Skills homepage destinations (P6 U6.6/U6.7 and the registries shelf): Updates with its per-file
// choices, first-run "Choose what's on", and "From your registries". Mounted under `capabilities.skillsUpdates`.

type Count = Readonly<{ count: number }>;

export type SkillsUpdatesTranslation = Readonly<{
  updates: Readonly<{
    title: string;
    purpose: string;
    checkNow: string;
    checking: string;
    readyTitle: string;
    readyBody: string;
    choiceTitle: string;
    choiceBody: (params: Readonly<{ name: string }>) => string;
    refChange: (params: Readonly<{ from: string; to: string }>) => string;
    newerWaiting: string;
    linesChanged: (params: Readonly<{ count: number; file: string }>) => string;
    filesChanged: (params: Count) => string;
    viewChanges: string;
    hideChanges: string;
    update: string;
    fileDiffers: (params: Count) => string;
    fileTheirsOnly: string;
    fileMineOnly: string;
    fileUnchanged: string;
    nothingToChoose: string;
    keepNote: (params: Readonly<{ name: string }>) => string;
    notNow: string;
    applyChoices: string;
    upToDate: string;
    noSources: string;
    updatedTitle: string;
    checkedAt: (params: Readonly<{ time: string }>) => string;
    checkFailed: string;
    diffFailed: string;
    applyFailed: string;
    applied: (params: Readonly<{ ref: string }>) => string;
    tryAgain: string;
  }>;
  choose: Readonly<{
    purpose: (params: Readonly<{ total: number; off: number }>) => string;
    purposeIdle: string;
    migratedTitle: (params: Count) => string;
    migratedBody: (params: Readonly<{ names: string }>) => string;
    listTitle: string;
    selectAll: string;
    selectNone: string;
    usedOn: (params: Readonly<{ date: string }>) => string;
    selected: (params: Count) => string;
    turnOn: (params: Count) => string;
    failed: string;
    nothingWaits: string;
  }>;
  shelf: Readonly<{
    title: string;
    titleNew: string;
    browseAll: string;
    fromSource: (params: Readonly<{ source: string }>) => string;
    add: string;
    inLibrary: string;
    addFailed: string;
  }>;
}>;

const en: SkillsUpdatesTranslation = {
  updates: {
    title: 'Updates',
    purpose:
      'Newer versions from the places your skills came from. Nothing changes until you choose.',
    checkNow: 'Check now',
    checking: 'Checking…',
    readyTitle: 'Ready to update',
    readyBody: 'You haven’t changed these, so taking the update is safe.',
    choiceTitle: 'Needs your choice',
    choiceBody: ({ name }) =>
      `You edited ${name}, and its source has a newer version. Choose per file; both sides are shown.`,
    refChange: ({ from, to }) => `from ${from} to ${to}`,
    newerWaiting: 'A newer version is waiting',
    linesChanged: ({ count, file }) =>
      `${count} ${count === 1 ? 'line' : 'lines'} changed in ${file}`,
    filesChanged: ({ count }) =>
      `${count} ${count === 1 ? 'file' : 'files'} changed`,
    viewChanges: 'View changes',
    hideChanges: 'Hide changes',
    update: 'Update',
    fileDiffers: ({ count }) =>
      `Yours and theirs differ · ${count} ${count === 1 ? 'line' : 'lines'}`,
    fileTheirsOnly: 'New in theirs',
    fileMineOnly: 'Only in yours',
    fileUnchanged: 'Unchanged',
    nothingToChoose: 'Nothing to choose',
    keepNote: ({ name }) =>
      `Keeping any file of yours keeps ${name} marked Modified, so later updates still ask.`,
    notNow: 'Not now',
    applyChoices: 'Apply choices',
    upToDate: 'Everything is up to date',
    noSources: 'None of your skills come from a source that updates. Skills you add from GitHub or a registry show their newer versions here.',
    updatedTitle: 'Updated',
    checkedAt: ({ time }) => `Checked ${time}`,
    checkFailed: 'Couldn’t check for updates.',
    diffFailed: 'Couldn’t load the changes.',
    applyFailed: 'Couldn’t update it.',
    applied: ({ ref }) => `Updated to ${ref}`,
    tryAgain: 'Try again',
  },
  choose: {
    purpose: ({ total, off }) =>
      `You have ${total} skills in your library. ${off} stay off until you choose, so your sessions don’t change yet.`,
    purposeIdle: 'Decide which of your skills your agents get.',
    migratedTitle: ({ count }) =>
      `${count} ${count === 1 ? 'is' : 'are'} already on, where you used ${count === 1 ? 'it' : 'them'}`,
    migratedBody: ({ names }) =>
      `${names} came from your Account or project context, so they stay on where you used them.`,
    listTitle: 'Choose what your agents get',
    selectAll: 'Select all',
    selectNone: 'Select none',
    usedOn: ({ date }) => `Used ${date}`,
    selected: ({ count }) => `${count} selected`,
    turnOn: ({ count }) => `Turn on ${count} everywhere`,
    failed: 'Couldn’t turn them on. Your choices are kept.',
    nothingWaits:
      'Every skill already has a place. Turn one on or narrow it from its own page.',
  },
  shelf: {
    title: 'From your registries',
    titleNew: 'Start with one of these',
    browseAll: 'Browse all',
    fromSource: ({ source }) => `New and popular on ${source}.`,
    add: 'Add',
    inLibrary: 'In your library',
    addFailed: 'Couldn’t add it',
  },
};

const de: SkillsUpdatesTranslation = {
  updates: {
    title: 'Updates',
    purpose:
      'Neuere Versionen von dort, woher deine Skills stammen. Nichts ändert sich, bis du entscheidest.',
    checkNow: 'Jetzt prüfen',
    checking: 'Wird geprüft…',
    readyTitle: 'Bereit zum Aktualisieren',
    readyBody: 'Du hast diese nicht geändert, das Update ist also sicher.',
    choiceTitle: 'Deine Wahl nötig',
    choiceBody: ({ name }) =>
      `Du hast ${name} bearbeitet, und die Quelle hat eine neuere Version. Wähle pro Datei; beide Seiten werden gezeigt.`,
    refChange: ({ from, to }) => `von ${from} zu ${to}`,
    newerWaiting: 'Eine neuere Version wartet',
    linesChanged: ({ count, file }) =>
      `${count} ${count === 1 ? 'Zeile' : 'Zeilen'} in ${file} geändert`,
    filesChanged: ({ count }) =>
      `${count} ${count === 1 ? 'Datei' : 'Dateien'} geändert`,
    viewChanges: 'Änderungen ansehen',
    hideChanges: 'Änderungen ausblenden',
    update: 'Aktualisieren',
    fileDiffers: ({ count }) =>
      `Deine und ihre unterscheiden sich · ${count} ${count === 1 ? 'Zeile' : 'Zeilen'}`,
    fileTheirsOnly: 'Neu in ihrer Version',
    fileMineOnly: 'Nur in deiner',
    fileUnchanged: 'Unverändert',
    nothingToChoose: 'Nichts zu wählen',
    keepNote: ({ name }) =>
      `Behältst du eine deiner Dateien, bleibt ${name} als geändert markiert, und spätere Updates fragen weiter.`,
    notNow: 'Nicht jetzt',
    applyChoices: 'Auswahl anwenden',
    upToDate: 'Alles ist aktuell',
    noSources: 'Keiner deiner Skills stammt aus einer Quelle mit Updates. Skills, die du von GitHub oder aus einer Registry hinzufügst, zeigen ihre neueren Versionen hier.',
    updatedTitle: 'Aktualisiert',
    checkedAt: ({ time }) => `Geprüft ${time}`,
    checkFailed: 'Updates konnten nicht geprüft werden.',
    diffFailed: 'Die Änderungen konnten nicht geladen werden.',
    applyFailed: 'Konnte nicht aktualisiert werden.',
    applied: ({ ref }) => `Aktualisiert auf ${ref}`,
    tryAgain: 'Erneut versuchen',
  },
  choose: {
    purpose: ({ total, off }) =>
      `Deine Bibliothek hat ${total} Skills. ${off} bleiben aus, bis du wählst, deine Sitzungen ändern sich also noch nicht.`,
    purposeIdle: 'Entscheide, welche deiner Skills deine Agents bekommen.',
    migratedTitle: ({ count }) =>
      `${count} ${count === 1 ? 'ist' : 'sind'} schon dort an, wo du sie genutzt hast`,
    migratedBody: ({ names }) =>
      `${names} kamen aus deinem Konto- oder Projektkontext und bleiben dort an, wo du sie genutzt hast.`,
    listTitle: 'Wähle, was deine Agents bekommen',
    selectAll: 'Alle auswählen',
    selectNone: 'Keine auswählen',
    usedOn: ({ date }) => `Genutzt ${date}`,
    selected: ({ count }) => `${count} ausgewählt`,
    turnOn: ({ count }) => `${count} überall einschalten`,
    failed:
      'Konnten nicht eingeschaltet werden. Deine Auswahl bleibt erhalten.',
    nothingWaits:
      'Jeder Skill hat schon einen Platz. Schalte einen auf seiner eigenen Seite ein oder grenze ihn ein.',
  },
  shelf: {
    title: 'Aus deinen Registries',
    titleNew: 'Fang mit einem davon an',
    browseAll: 'Alle durchsuchen',
    fromSource: ({ source }) => `Neu und beliebt auf ${source}.`,
    add: 'Hinzufügen',
    inLibrary: 'In deiner Bibliothek',
    addFailed: 'Konnte nicht hinzugefügt werden',
  },
};

const fr: SkillsUpdatesTranslation = {
  updates: {
    title: 'Mises à jour',
    purpose:
      'Des versions plus récentes, depuis l’origine de vos skills. Rien ne change tant que vous n’avez pas choisi.',
    checkNow: 'Vérifier',
    checking: 'Vérification…',
    readyTitle: 'Prêtes à installer',
    readyBody:
      'Vous ne les avez pas modifiées, la mise à jour est donc sans risque.',
    choiceTitle: 'À vous de choisir',
    choiceBody: ({ name }) =>
      `Vous avez modifié ${name}, et sa source a une version plus récente. Choisissez fichier par fichier ; les deux côtés sont affichés.`,
    refChange: ({ from, to }) => `de ${from} à ${to}`,
    newerWaiting: 'Une version plus récente attend',
    linesChanged: ({ count, file }) =>
      `${count} ${count === 1 ? 'ligne modifiée' : 'lignes modifiées'} dans ${file}`,
    filesChanged: ({ count }) =>
      `${count} ${count === 1 ? 'fichier modifié' : 'fichiers modifiés'}`,
    viewChanges: 'Voir les changements',
    hideChanges: 'Masquer les changements',
    update: 'Mettre à jour',
    fileDiffers: ({ count }) =>
      `Votre version et la leur diffèrent · ${count} ${count === 1 ? 'ligne' : 'lignes'}`,
    fileTheirsOnly: 'Nouveau dans la leur',
    fileMineOnly: 'Seulement dans la vôtre',
    fileUnchanged: 'Inchangé',
    nothingToChoose: 'Rien à choisir',
    keepNote: ({ name }) =>
      `Garder un de vos fichiers laisse ${name} marqué Modifié : les prochaines mises à jour demanderont encore.`,
    notNow: 'Plus tard',
    applyChoices: 'Appliquer les choix',
    upToDate: 'Tout est à jour',
    noSources: 'Aucun de vos skills ne vient d’une source qui se met à jour. Les skills ajoutés depuis GitHub ou un registre montrent ici leurs nouvelles versions.',
    updatedTitle: 'Mis à jour',
    checkedAt: ({ time }) => `Vérifié à ${time}`,
    checkFailed: 'Impossible de vérifier les mises à jour.',
    diffFailed: 'Impossible de charger les changements.',
    applyFailed: 'Impossible de mettre à jour.',
    applied: ({ ref }) => `Mis à jour vers ${ref}`,
    tryAgain: 'Réessayer',
  },
  choose: {
    purpose: ({ total, off }) =>
      `Votre bibliothèque compte ${total} skills. ${off} restent désactivés jusqu’à votre choix : vos sessions ne changent pas encore.`,
    purposeIdle: 'Choisissez quels skills vos agents reçoivent.',
    migratedTitle: ({ count }) =>
      `${count} ${count === 1 ? 'est déjà activé' : 'sont déjà activés'}, là où vous ${count === 1 ? 'l’avez utilisé' : 'les avez utilisés'}`,
    migratedBody: ({ names }) =>
      `${names} venaient de votre contexte de compte ou de projet : ils restent activés là où vous les utilisiez.`,
    listTitle: 'Choisissez ce que reçoivent vos agents',
    selectAll: 'Tout sélectionner',
    selectNone: 'Ne rien sélectionner',
    usedOn: ({ date }) => `Utilisé le ${date}`,
    selected: ({ count }) =>
      `${count} ${count === 1 ? 'sélectionné' : 'sélectionnés'}`,
    turnOn: ({ count }) => `Activer ${count} partout`,
    failed: 'Impossible de les activer. Vos choix sont conservés.',
    nothingWaits:
      'Chaque skill a déjà sa place. Activez-en ou restreignez-en un depuis sa page.',
  },
  shelf: {
    title: 'Depuis vos registres',
    titleNew: 'Commencez par l’un de ceux-ci',
    browseAll: 'Tout parcourir',
    fromSource: ({ source }) => `Nouveautés et favoris sur ${source}.`,
    add: 'Ajouter',
    inLibrary: 'Dans votre bibliothèque',
    addFailed: 'Impossible de l’ajouter',
  },
};

const es: SkillsUpdatesTranslation = {
  updates: {
    title: 'Actualizaciones',
    purpose:
      'Versiones más nuevas de donde vinieron tus habilidades. Nada cambia hasta que elijas.',
    checkNow: 'Comprobar ahora',
    checking: 'Comprobando…',
    readyTitle: 'Listas para actualizar',
    readyBody: 'No las cambiaste, así que actualizar es seguro.',
    choiceTitle: 'Necesitan tu elección',
    choiceBody: ({ name }) =>
      `Editaste ${name} y su origen tiene una versión más nueva. Elige archivo por archivo; se muestran ambos lados.`,
    refChange: ({ from, to }) => `de ${from} a ${to}`,
    newerWaiting: 'Hay una versión más nueva',
    linesChanged: ({ count, file }) =>
      `${count} ${count === 1 ? 'línea cambiada' : 'líneas cambiadas'} en ${file}`,
    filesChanged: ({ count }) =>
      `${count} ${count === 1 ? 'archivo cambiado' : 'archivos cambiados'}`,
    viewChanges: 'Ver cambios',
    hideChanges: 'Ocultar cambios',
    update: 'Actualizar',
    fileDiffers: ({ count }) =>
      `La tuya y la suya difieren · ${count} ${count === 1 ? 'línea' : 'líneas'}`,
    fileTheirsOnly: 'Nuevo en la suya',
    fileMineOnly: 'Solo en la tuya',
    fileUnchanged: 'Sin cambios',
    nothingToChoose: 'Nada que elegir',
    keepNote: ({ name }) =>
      `Si conservas algún archivo tuyo, ${name} sigue marcada como modificada y las próximas actualizaciones volverán a preguntar.`,
    notNow: 'Ahora no',
    applyChoices: 'Aplicar elecciones',
    upToDate: 'Todo está al día',
    noSources: 'Ninguna de tus skills viene de una fuente que se actualice. Las skills que añadas desde GitHub o un registro muestran aquí sus versiones nuevas.',
    updatedTitle: 'Actualizadas',
    checkedAt: ({ time }) => `Comprobado ${time}`,
    checkFailed: 'No se pudieron comprobar las actualizaciones.',
    diffFailed: 'No se pudieron cargar los cambios.',
    applyFailed: 'No se pudo actualizar.',
    applied: ({ ref }) => `Actualizada a ${ref}`,
    tryAgain: 'Reintentar',
  },
  choose: {
    purpose: ({ total, off }) =>
      `Tienes ${total} habilidades en tu biblioteca. ${off} siguen desactivadas hasta que elijas, así que tus sesiones aún no cambian.`,
    purposeIdle: 'Decide qué habilidades reciben tus agentes.',
    migratedTitle: ({ count }) =>
      `${count} ya ${count === 1 ? 'está activada' : 'están activadas'} donde las usabas`,
    migratedBody: ({ names }) =>
      `${names} venían del contexto de tu cuenta o proyecto, así que siguen activas donde las usabas.`,
    listTitle: 'Elige qué reciben tus agentes',
    selectAll: 'Seleccionar todo',
    selectNone: 'No seleccionar ninguna',
    usedOn: ({ date }) => `Usada el ${date}`,
    selected: ({ count }) =>
      `${count} ${count === 1 ? 'seleccionada' : 'seleccionadas'}`,
    turnOn: ({ count }) => `Activar ${count} en todas partes`,
    failed: 'No se pudieron activar. Tus elecciones se conservan.',
    nothingWaits:
      'Cada habilidad ya tiene su lugar. Activa o limita una desde su propia página.',
  },
  shelf: {
    title: 'De tus registros',
    titleNew: 'Empieza con una de estas',
    browseAll: 'Explorar todo',
    fromSource: ({ source }) => `Nuevas y populares en ${source}.`,
    add: 'Añadir',
    inLibrary: 'En tu biblioteca',
    addFailed: 'No se pudo añadir',
  },
};

const ca: SkillsUpdatesTranslation = {
  updates: {
    title: 'Actualitzacions',
    purpose:
      'Versions més noves d’on van venir les teves habilitats. No canvia res fins que triïs.',
    checkNow: 'Comprova ara',
    checking: 'Comprovant…',
    readyTitle: 'A punt per actualitzar',
    readyBody: 'No les has canviat, així que actualitzar és segur.',
    choiceTitle: 'Cal que triïs',
    choiceBody: ({ name }) =>
      `Has editat ${name} i el seu origen té una versió més nova. Tria fitxer per fitxer; es mostren tots dos costats.`,
    refChange: ({ from, to }) => `de ${from} a ${to}`,
    newerWaiting: 'Hi ha una versió més nova',
    linesChanged: ({ count, file }) =>
      `${count} ${count === 1 ? 'línia canviada' : 'línies canviades'} a ${file}`,
    filesChanged: ({ count }) =>
      `${count} ${count === 1 ? 'fitxer canviat' : 'fitxers canviats'}`,
    viewChanges: 'Mostra els canvis',
    hideChanges: 'Amaga els canvis',
    update: 'Actualitza',
    fileDiffers: ({ count }) =>
      `La teva i la seva difereixen · ${count} ${count === 1 ? 'línia' : 'línies'}`,
    fileTheirsOnly: 'Nou a la seva',
    fileMineOnly: 'Només a la teva',
    fileUnchanged: 'Sense canvis',
    nothingToChoose: 'Res a triar',
    keepNote: ({ name }) =>
      `Si conserves algun fitxer teu, ${name} continua marcada com a modificada i les properes actualitzacions tornaran a preguntar.`,
    notNow: 'Ara no',
    applyChoices: 'Aplica les tries',
    upToDate: 'Tot està al dia',
    noSources: 'Cap de les teves skills ve d’una font que s’actualitzi. Les skills que afegeixis des de GitHub o un registre mostren aquí les versions noves.',
    updatedTitle: 'Actualitzades',
    checkedAt: ({ time }) => `Comprovat ${time}`,
    checkFailed: 'No s’han pogut comprovar les actualitzacions.',
    diffFailed: 'No s’han pogut carregar els canvis.',
    applyFailed: 'No s’ha pogut actualitzar.',
    applied: ({ ref }) => `Actualitzada a ${ref}`,
    tryAgain: 'Torna-ho a provar',
  },
  choose: {
    purpose: ({ total, off }) =>
      `Tens ${total} habilitats a la biblioteca. ${off} continuen desactivades fins que triïs, així que les sessions encara no canvien.`,
    purposeIdle: 'Decideix quines habilitats reben els teus agents.',
    migratedTitle: ({ count }) =>
      `${count} ja ${count === 1 ? 'està activada' : 'estan activades'} on les feies servir`,
    migratedBody: ({ names }) =>
      `${names} venien del context del compte o del projecte, així que continuen actives on les feies servir.`,
    listTitle: 'Tria què reben els teus agents',
    selectAll: 'Selecciona-ho tot',
    selectNone: 'No en seleccionis cap',
    usedOn: ({ date }) => `Usada el ${date}`,
    selected: ({ count }) =>
      `${count} ${count === 1 ? 'seleccionada' : 'seleccionades'}`,
    turnOn: ({ count }) => `Activa’n ${count} a tot arreu`,
    failed: 'No s’han pogut activar. Les teves tries es conserven.',
    nothingWaits:
      'Cada habilitat ja té el seu lloc. Activa’n o limita’n una des de la seva pàgina.',
  },
  shelf: {
    title: 'Dels teus registres',
    titleNew: 'Comença amb una d’aquestes',
    browseAll: 'Explora-ho tot',
    fromSource: ({ source }) => `Novetats i populars a ${source}.`,
    add: 'Afegeix',
    inLibrary: 'A la teva biblioteca',
    addFailed: 'No s’ha pogut afegir',
  },
};

const it: SkillsUpdatesTranslation = {
  updates: {
    title: 'Aggiornamenti',
    purpose:
      'Versioni più recenti dai luoghi da cui provengono le tue skill. Nulla cambia finché non scegli.',
    checkNow: 'Controlla ora',
    checking: 'Controllo…',
    readyTitle: 'Pronte da aggiornare',
    readyBody: 'Non le hai modificate, quindi aggiornarle è sicuro.',
    choiceTitle: 'Serve la tua scelta',
    choiceBody: ({ name }) =>
      `Hai modificato ${name} e la sua fonte ha una versione più recente. Scegli file per file; sono mostrati entrambi i lati.`,
    refChange: ({ from, to }) => `da ${from} a ${to}`,
    newerWaiting: 'C’è una versione più recente',
    linesChanged: ({ count, file }) =>
      `${count} ${count === 1 ? 'riga modificata' : 'righe modificate'} in ${file}`,
    filesChanged: ({ count }) =>
      `${count} ${count === 1 ? 'file modificato' : 'file modificati'}`,
    viewChanges: 'Vedi modifiche',
    hideChanges: 'Nascondi modifiche',
    update: 'Aggiorna',
    fileDiffers: ({ count }) =>
      `La tua e la loro differiscono · ${count} ${count === 1 ? 'riga' : 'righe'}`,
    fileTheirsOnly: 'Nuovo nella loro',
    fileMineOnly: 'Solo nella tua',
    fileUnchanged: 'Invariato',
    nothingToChoose: 'Niente da scegliere',
    keepNote: ({ name }) =>
      `Se tieni un tuo file, ${name} resta segnata come modificata e i prossimi aggiornamenti chiederanno ancora.`,
    notNow: 'Non ora',
    applyChoices: 'Applica le scelte',
    upToDate: 'È tutto aggiornato',
    noSources: 'Nessuna delle tue skill viene da una fonte che si aggiorna. Le skill aggiunte da GitHub o da un registro mostrano qui le versioni più recenti.',
    updatedTitle: 'Aggiornate',
    checkedAt: ({ time }) => `Controllato ${time}`,
    checkFailed: 'Impossibile controllare gli aggiornamenti.',
    diffFailed: 'Impossibile caricare le modifiche.',
    applyFailed: 'Impossibile aggiornare.',
    applied: ({ ref }) => `Aggiornata a ${ref}`,
    tryAgain: 'Riprova',
  },
  choose: {
    purpose: ({ total, off }) =>
      `Hai ${total} skill nella libreria. ${off} restano disattivate finché non scegli, quindi le tue sessioni non cambiano ancora.`,
    purposeIdle: 'Scegli quali skill ricevono i tuoi agenti.',
    migratedTitle: ({ count }) =>
      `${count} ${count === 1 ? 'è già attiva' : 'sono già attive'} dove le usavi`,
    migratedBody: ({ names }) =>
      `${names} venivano dal contesto dell’account o del progetto, quindi restano attive dove le usavi.`,
    listTitle: 'Scegli cosa ricevono i tuoi agenti',
    selectAll: 'Seleziona tutto',
    selectNone: 'Nessuna',
    usedOn: ({ date }) => `Usata il ${date}`,
    selected: ({ count }) =>
      `${count} ${count === 1 ? 'selezionata' : 'selezionate'}`,
    turnOn: ({ count }) => `Attiva ${count} ovunque`,
    failed: 'Impossibile attivarle. Le tue scelte restano.',
    nothingWaits:
      'Ogni skill ha già il suo posto. Attivane o restringine una dalla sua pagina.',
  },
  shelf: {
    title: 'Dai tuoi registri',
    titleNew: 'Inizia con una di queste',
    browseAll: 'Sfoglia tutto',
    fromSource: ({ source }) => `Novità e più popolari su ${source}.`,
    add: 'Aggiungi',
    inLibrary: 'Nella tua libreria',
    addFailed: 'Impossibile aggiungere',
  },
};

const pt: SkillsUpdatesTranslation = {
  updates: {
    title: 'Atualizações',
    purpose:
      'Versões mais novas de onde suas habilidades vieram. Nada muda até você escolher.',
    checkNow: 'Verificar agora',
    checking: 'Verificando…',
    readyTitle: 'Prontas para atualizar',
    readyBody: 'Você não as alterou, então atualizar é seguro.',
    choiceTitle: 'Precisam da sua escolha',
    choiceBody: ({ name }) =>
      `Você editou ${name} e a origem tem uma versão mais nova. Escolha por arquivo; os dois lados aparecem.`,
    refChange: ({ from, to }) => `de ${from} para ${to}`,
    newerWaiting: 'Há uma versão mais nova',
    linesChanged: ({ count, file }) =>
      `${count} ${count === 1 ? 'linha alterada' : 'linhas alteradas'} em ${file}`,
    filesChanged: ({ count }) =>
      `${count} ${count === 1 ? 'arquivo alterado' : 'arquivos alterados'}`,
    viewChanges: 'Ver alterações',
    hideChanges: 'Ocultar alterações',
    update: 'Atualizar',
    fileDiffers: ({ count }) =>
      `A sua e a deles diferem · ${count} ${count === 1 ? 'linha' : 'linhas'}`,
    fileTheirsOnly: 'Novo na deles',
    fileMineOnly: 'Só na sua',
    fileUnchanged: 'Sem alterações',
    nothingToChoose: 'Nada a escolher',
    keepNote: ({ name }) =>
      `Manter qualquer arquivo seu deixa ${name} marcada como modificada, e as próximas atualizações ainda vão perguntar.`,
    notNow: 'Agora não',
    applyChoices: 'Aplicar escolhas',
    upToDate: 'Tudo está atualizado',
    noSources: 'Nenhuma das suas skills vem de uma fonte que se atualiza. Skills adicionadas do GitHub ou de um registro mostram aqui as versões novas.',
    updatedTitle: 'Atualizadas',
    checkedAt: ({ time }) => `Verificado ${time}`,
    checkFailed: 'Não foi possível verificar atualizações.',
    diffFailed: 'Não foi possível carregar as alterações.',
    applyFailed: 'Não foi possível atualizar.',
    applied: ({ ref }) => `Atualizada para ${ref}`,
    tryAgain: 'Tentar de novo',
  },
  choose: {
    purpose: ({ total, off }) =>
      `Você tem ${total} habilidades na biblioteca. ${off} ficam desativadas até você escolher, então suas sessões ainda não mudam.`,
    purposeIdle: 'Escolha quais habilidades seus agentes recebem.',
    migratedTitle: ({ count }) =>
      `${count} já ${count === 1 ? 'está ativada' : 'estão ativadas'} onde você as usava`,
    migratedBody: ({ names }) =>
      `${names} vieram do contexto da conta ou do projeto, então continuam ativas onde você as usava.`,
    listTitle: 'Escolha o que seus agentes recebem',
    selectAll: 'Selecionar tudo',
    selectNone: 'Nenhuma',
    usedOn: ({ date }) => `Usada em ${date}`,
    selected: ({ count }) =>
      `${count} ${count === 1 ? 'selecionada' : 'selecionadas'}`,
    turnOn: ({ count }) => `Ativar ${count} em todo lugar`,
    failed: 'Não foi possível ativá-las. Suas escolhas foram mantidas.',
    nothingWaits:
      'Cada habilidade já tem seu lugar. Ative ou restrinja uma pela página dela.',
  },
  shelf: {
    title: 'Dos seus registros',
    titleNew: 'Comece com uma destas',
    browseAll: 'Ver tudo',
    fromSource: ({ source }) => `Novas e populares em ${source}.`,
    add: 'Adicionar',
    inLibrary: 'Na sua biblioteca',
    addFailed: 'Não foi possível adicionar',
  },
};

const pl: SkillsUpdatesTranslation = {
  updates: {
    title: 'Aktualizacje',
    purpose:
      'Nowsze wersje ze źródeł Twoich umiejętności. Nic się nie zmieni, dopóki nie wybierzesz.',
    checkNow: 'Sprawdź teraz',
    checking: 'Sprawdzanie…',
    readyTitle: 'Gotowe do aktualizacji',
    readyBody: 'Nie zmieniałeś ich, więc aktualizacja jest bezpieczna.',
    choiceTitle: 'Wymagają Twojego wyboru',
    choiceBody: ({ name }) =>
      `Edytowałeś ${name}, a jej źródło ma nowszą wersję. Wybierz dla każdego pliku; pokazane są obie strony.`,
    refChange: ({ from, to }) => `z ${from} na ${to}`,
    newerWaiting: 'Czeka nowsza wersja',
    linesChanged: ({ count, file }) => `Zmienione linie w ${file}: ${count}`,
    filesChanged: ({ count }) => `Zmienione pliki: ${count}`,
    viewChanges: 'Pokaż zmiany',
    hideChanges: 'Ukryj zmiany',
    update: 'Aktualizuj',
    fileDiffers: ({ count }) =>
      `Twoja i ich wersja się różnią · linie: ${count}`,
    fileTheirsOnly: 'Nowy w ich wersji',
    fileMineOnly: 'Tylko w Twojej',
    fileUnchanged: 'Bez zmian',
    nothingToChoose: 'Nie ma czego wybierać',
    keepNote: ({ name }) =>
      `Zachowanie któregokolwiek Twojego pliku pozostawia ${name} jako zmienioną, więc kolejne aktualizacje nadal zapytają.`,
    notNow: 'Nie teraz',
    applyChoices: 'Zastosuj wybory',
    upToDate: 'Wszystko jest aktualne',
    noSources: 'Żadna z Twoich umiejętności nie pochodzi ze źródła z aktualizacjami. Umiejętności dodane z GitHuba lub rejestru pokażą tu nowsze wersje.',
    updatedTitle: 'Zaktualizowane',
    checkedAt: ({ time }) =>
      `Sprawdzono ${time}`,
    checkFailed: 'Nie udało się sprawdzić aktualizacji.',
    diffFailed: 'Nie udało się wczytać zmian.',
    applyFailed: 'Nie udało się zaktualizować.',
    applied: ({ ref }) => `Zaktualizowano do ${ref}`,
    tryAgain: 'Spróbuj ponownie',
  },
  choose: {
    purpose: ({ total, off }) =>
      `Masz w bibliotece ${total} umiejętności. ${off} pozostaje wyłączonych, dopóki nie wybierzesz, więc Twoje sesje jeszcze się nie zmieniają.`,
    purposeIdle: 'Wybierz, które umiejętności dostają Twoi agenci.',
    migratedTitle: ({ count }) =>
      `Już włączone tam, gdzie ich używałeś: ${count}`,
    migratedBody: ({ names }) =>
      `${names} pochodziły z kontekstu konta lub projektu, więc pozostają włączone tam, gdzie ich używałeś.`,
    listTitle: 'Wybierz, co dostaną Twoi agenci',
    selectAll: 'Zaznacz wszystko',
    selectNone: 'Odznacz wszystko',
    usedOn: ({ date }) => `Użyto ${date}`,
    selected: ({ count }) => `Zaznaczono: ${count}`,
    turnOn: ({ count }) => `Włącz wszędzie (${count})`,
    failed: 'Nie udało się ich włączyć. Twoje wybory zostały zachowane.',
    nothingWaits:
      'Każda umiejętność ma już swoje miejsce. Włącz lub zawęź ją na jej stronie.',
  },
  shelf: {
    title: 'Z Twoich rejestrów',
    titleNew: 'Zacznij od jednej z tych',
    browseAll: 'Przeglądaj wszystko',
    fromSource: ({ source }) => `Nowe i popularne w ${source}.`,
    add: 'Dodaj',
    inLibrary: 'W Twojej bibliotece',
    addFailed: 'Nie udało się dodać',
  },
};

const ru: SkillsUpdatesTranslation = {
  updates: {
    title: 'Обновления',
    purpose:
      'Более новые версии оттуда, откуда пришли ваши навыки. Ничего не изменится, пока вы не выберете.',
    checkNow: 'Проверить',
    checking: 'Проверка…',
    readyTitle: 'Готовы к обновлению',
    readyBody: 'Вы их не меняли, поэтому обновление безопасно.',
    choiceTitle: 'Нужен ваш выбор',
    choiceBody: ({ name }) =>
      `Вы изменили ${name}, а у источника есть более новая версия. Выберите для каждого файла; показаны обе стороны.`,
    refChange: ({ from, to }) => `с ${from} на ${to}`,
    newerWaiting: 'Ждёт более новая версия',
    linesChanged: ({ count, file }) => `Изменено строк в ${file}: ${count}`,
    filesChanged: ({ count }) => `Изменено файлов: ${count}`,
    viewChanges: 'Показать изменения',
    hideChanges: 'Скрыть изменения',
    update: 'Обновить',
    fileDiffers: ({ count }) =>
      `Ваша и их версии различаются · строк: ${count}`,
    fileTheirsOnly: 'Новый в их версии',
    fileMineOnly: 'Только в вашей',
    fileUnchanged: 'Без изменений',
    nothingToChoose: 'Нечего выбирать',
    keepNote: ({ name }) =>
      `Если оставить хотя бы один ваш файл, ${name} останется отмеченным как изменённый, и следующие обновления снова спросят.`,
    notNow: 'Не сейчас',
    applyChoices: 'Применить выбор',
    upToDate: 'Всё актуально',
    noSources: 'Ни один ваш навык не пришёл из источника с обновлениями. Навыки из GitHub или реестра показывают здесь новые версии.',
    updatedTitle: 'Обновлены',
    checkedAt: ({ time }) => `Проверено ${time}`,
    checkFailed: 'Не удалось проверить обновления.',
    diffFailed: 'Не удалось загрузить изменения.',
    applyFailed: 'Не удалось обновить.',
    applied: ({ ref }) => `Обновлено до ${ref}`,
    tryAgain: 'Повторить',
  },
  choose: {
    purpose: ({ total, off }) =>
      `В вашей библиотеке ${total} навыков. ${off} остаются выключенными, пока вы не выберете, поэтому ваши сессии пока не меняются.`,
    purposeIdle: 'Выберите, какие скиллы получают ваши агенты.',
    migratedTitle: ({ count }) =>
      `Уже включены там, где вы их использовали: ${count}`,
    migratedBody: ({ names }) =>
      `${names} пришли из контекста аккаунта или проекта, поэтому остаются включёнными там, где вы их использовали.`,
    listTitle: 'Выберите, что получат ваши агенты',
    selectAll: 'Выбрать все',
    selectNone: 'Снять выбор',
    usedOn: ({ date }) => `Использован ${date}`,
    selected: ({ count }) => `Выбрано: ${count}`,
    turnOn: ({ count }) => `Включить везде (${count})`,
    failed: 'Не удалось включить. Ваш выбор сохранён.',
    nothingWaits:
      'У каждого навыка уже есть место. Включите или сузьте навык на его странице.',
  },
  shelf: {
    title: 'Из ваших реестров',
    titleNew: 'Начните с одного из этих',
    browseAll: 'Смотреть все',
    fromSource: ({ source }) => `Новое и популярное на ${source}.`,
    add: 'Добавить',
    inLibrary: 'В вашей библиотеке',
    addFailed: 'Не удалось добавить',
  },
};

const ja: SkillsUpdatesTranslation = {
  updates: {
    title: 'アップデート',
    purpose:
      'スキルの入手元にある新しいバージョンです。選ぶまで何も変わりません。',
    checkNow: '今すぐ確認',
    checking: '確認中…',
    readyTitle: '更新できます',
    readyBody: '変更していないので、安全に更新できます。',
    choiceTitle: '選択が必要です',
    choiceBody: ({ name }) =>
      `${name} を編集しており、入手元に新しいバージョンがあります。ファイルごとに選んでください。両方の内容を表示しています。`,
    refChange: ({ from, to }) => `${from} から ${to} へ`,
    newerWaiting: '新しいバージョンがあります',
    linesChanged: ({ count, file }) => `${file} の ${count} 行が変更`,
    filesChanged: ({ count }) => `${count} 個のファイルが変更`,
    viewChanges: '変更を表示',
    hideChanges: '変更を隠す',
    update: '更新',
    fileDiffers: ({ count }) =>
      `あなたの版と相手の版が異なります · ${count} 行`,
    fileTheirsOnly: '相手の版で追加',
    fileMineOnly: 'あなたの版のみ',
    fileUnchanged: '変更なし',
    nothingToChoose: '選ぶものはありません',
    keepNote: ({ name }) =>
      `自分のファイルを一つでも残すと ${name} は変更済みのままになり、今後の更新でも確認されます。`,
    notNow: '後で',
    applyChoices: '選択を適用',
    upToDate: 'すべて最新です',
    noSources: '更新元のあるスキルはありません。GitHub やレジストリから追加したスキルは、新しいバージョンがここに表示されます。',
    updatedTitle: '更新済み',
    checkedAt: ({ time }) => `${time} に確認`,
    checkFailed: 'アップデートを確認できませんでした。',
    diffFailed: '変更を読み込めませんでした。',
    applyFailed: '更新できませんでした。',
    applied: ({ ref }) => `${ref} に更新しました`,
    tryAgain: '再試行',
  },
  choose: {
    purpose: ({ total, off }) =>
      `ライブラリには ${total} 個のスキルがあります。選ぶまで ${off} 個はオフのままなので、セッションはまだ変わりません。`,
    purposeIdle: 'エージェントに渡すスキルを選びます。',
    migratedTitle: ({ count }) => `${count} 個は使っていた場所ですでにオンです`,
    migratedBody: ({ names }) =>
      `${names} はアカウントまたはプロジェクトのコンテキストから来たため、使っていた場所でオンのままです。`,
    listTitle: 'エージェントに渡すものを選ぶ',
    selectAll: 'すべて選択',
    selectNone: '選択を解除',
    usedOn: ({ date }) => `${date} に使用`,
    selected: ({ count }) => `${count} 個を選択`,
    turnOn: ({ count }) => `${count} 個をどこでもオン`,
    failed: 'オンにできませんでした。選択はそのままです。',
    nothingWaits:
      'どのスキルにもすでに場所があります。各スキルのページでオンにしたり範囲を絞ったりできます。',
  },
  shelf: {
    title: 'あなたのレジストリから',
    titleNew: 'まずはこちらから',
    browseAll: 'すべて見る',
    fromSource: ({ source }) => `${source} の新着と人気。`,
    add: '追加',
    inLibrary: 'ライブラリにあります',
    addFailed: '追加できませんでした',
  },
};

const zhHans: SkillsUpdatesTranslation = {
  updates: {
    title: '更新',
    purpose: '来自技能来源处的新版本。在你选择之前，什么都不会改变。',
    checkNow: '立即检查',
    checking: '正在检查…',
    readyTitle: '可以更新',
    readyBody: '你没有改动过这些，所以更新是安全的。',
    choiceTitle: '需要你来选择',
    choiceBody: ({ name }) =>
      `你编辑过 ${name}，而它的来源有了新版本。请逐个文件选择；两边的内容都会显示。`,
    refChange: ({ from, to }) => `从 ${from} 到 ${to}`,
    newerWaiting: '有新版本可用',
    linesChanged: ({ count, file }) => `${file} 中有 ${count} 行改动`,
    filesChanged: ({ count }) => `${count} 个文件有改动`,
    viewChanges: '查看改动',
    hideChanges: '隐藏改动',
    update: '更新',
    fileDiffers: ({ count }) => `你的和他们的不同 · ${count} 行`,
    fileTheirsOnly: '他们的版本新增',
    fileMineOnly: '仅在你的版本中',
    fileUnchanged: '未改动',
    nothingToChoose: '无需选择',
    keepNote: ({ name }) =>
      `保留任何一个你的文件，${name} 都会保持“已修改”，之后的更新仍会询问你。`,
    notNow: '以后再说',
    applyChoices: '应用选择',
    upToDate: '一切都是最新的',
    noSources: '你的技能都不来自会更新的来源。从 GitHub 或注册表添加的技能会在这里显示新版本。',
    updatedTitle: '已更新',
    checkedAt: ({ time }) => `${time} 检查`,
    checkFailed: '无法检查更新。',
    diffFailed: '无法加载改动。',
    applyFailed: '无法更新。',
    applied: ({ ref }) => `已更新到 ${ref}`,
    tryAgain: '重试',
  },
  choose: {
    purpose: ({ total, off }) =>
      `你的库中有 ${total} 个技能。在你选择之前，${off} 个保持关闭，所以你的会话暂时不会改变。`,
    purposeIdle: '选择你的代理能获得哪些技能。',
    migratedTitle: ({ count }) => `${count} 个已在你用过的地方开启`,
    migratedBody: ({ names }) =>
      `${names} 来自你的账户或项目上下文，所以在你用过的地方保持开启。`,
    listTitle: '选择你的代理能获得什么',
    selectAll: '全选',
    selectNone: '全不选',
    usedOn: ({ date }) => `${date} 使用过`,
    selected: ({ count }) => `已选择 ${count} 个`,
    turnOn: ({ count }) => `在所有地方开启 ${count} 个`,
    failed: '无法开启。你的选择已保留。',
    nothingWaits:
      '每个技能都已有自己的位置。可以在技能自己的页面上开启或缩小范围。',
  },
  shelf: {
    title: '来自你的注册表',
    titleNew: '从这些开始',
    browseAll: '浏览全部',
    fromSource: ({ source }) => `${source} 上的新作和热门。`,
    add: '添加',
    inLibrary: '已在你的库中',
    addFailed: '无法添加',
  },
};

const zhHant: SkillsUpdatesTranslation = {
  updates: {
    title: '更新',
    purpose: '來自技能來源處的新版本。在你選擇之前，什麼都不會改變。',
    checkNow: '立即檢查',
    checking: '正在檢查…',
    readyTitle: '可以更新',
    readyBody: '你沒有改動過這些，所以更新是安全的。',
    choiceTitle: '需要你來選擇',
    choiceBody: ({ name }) =>
      `你編輯過 ${name}，而它的來源有了新版本。請逐個檔案選擇；兩邊的內容都會顯示。`,
    refChange: ({ from, to }) => `從 ${from} 到 ${to}`,
    newerWaiting: '有新版本可用',
    linesChanged: ({ count, file }) => `${file} 中有 ${count} 行改動`,
    filesChanged: ({ count }) => `${count} 個檔案有改動`,
    viewChanges: '查看改動',
    hideChanges: '隱藏改動',
    update: '更新',
    fileDiffers: ({ count }) => `你的和他們的不同 · ${count} 行`,
    fileTheirsOnly: '他們的版本新增',
    fileMineOnly: '僅在你的版本中',
    fileUnchanged: '未改動',
    nothingToChoose: '無需選擇',
    keepNote: ({ name }) =>
      `保留任何一個你的檔案，${name} 都會保持「已修改」，之後的更新仍會詢問你。`,
    notNow: '以後再說',
    applyChoices: '套用選擇',
    upToDate: '一切都是最新的',
    noSources: '你的技能都不來自會更新的來源。從 GitHub 或登錄檔新增的技能會在這裡顯示新版本。',
    updatedTitle: '已更新',
    checkedAt: ({ time }) => `${time} 檢查`,
    checkFailed: '無法檢查更新。',
    diffFailed: '無法載入改動。',
    applyFailed: '無法更新。',
    applied: ({ ref }) => `已更新到 ${ref}`,
    tryAgain: '重試',
  },
  choose: {
    purpose: ({ total, off }) =>
      `你的庫中有 ${total} 個技能。在你選擇之前，${off} 個保持關閉，所以你的工作階段暫時不會改變。`,
    purposeIdle: '選擇你的代理能獲得哪些技能。',
    migratedTitle: ({ count }) => `${count} 個已在你用過的地方開啟`,
    migratedBody: ({ names }) =>
      `${names} 來自你的帳戶或專案上下文，所以在你用過的地方保持開啟。`,
    listTitle: '選擇你的代理能獲得什麼',
    selectAll: '全選',
    selectNone: '全不選',
    usedOn: ({ date }) => `${date} 使用過`,
    selected: ({ count }) => `已選擇 ${count} 個`,
    turnOn: ({ count }) => `在所有地方開啟 ${count} 個`,
    failed: '無法開啟。你的選擇已保留。',
    nothingWaits:
      '每個技能都已有自己的位置。可以在技能自己的頁面上開啟或縮小範圍。',
  },
  shelf: {
    title: '來自你的登錄檔',
    titleNew: '從這些開始',
    browseAll: '瀏覽全部',
    fromSource: ({ source }) => `${source} 上的新作和熱門。`,
    add: '新增',
    inLibrary: '已在你的庫中',
    addFailed: '無法新增',
  },
};

export const skillsUpdatesTranslations = {
  en,
  ca,
  de,
  es,
  fr,
  it,
  ja,
  pl,
  pt,
  ru,
  zhHans,
  zhHant,
} as const;
