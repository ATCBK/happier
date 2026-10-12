/** The agent's resource proposal card (plan 60 AGW-6/7/8, lab `ra` A2–A4, A7). */
const en = {
  title: {
    storage: 'Cleanup proposal',
    processes: 'Free memory',
    retry: 'Make room and retry',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · checked ${time}`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · checking…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `${count} of ${total} selected`,
  selectAll: 'Select all',
  selectAllSafe: 'Select all safe',
  givesBack: 'Gives back',
  frees: 'Frees',
  onDisk: ({ amount }: { amount: string }) => `of ${amount} on disk`,
  changed: 'changed',
  gone: 'gone',
  notIncluded: 'Not part of this proposal',
  includeAnyway: 'Include it',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `${found} of ${goal} found`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? 'One thing changed since the agent looked.'
      : `${count} things changed since the agent looked.`,
  staleBody: 'Nothing can be approved until it is checked again.',
  checkAgain: 'Check again',
  checkUnavailable:
    'Couldn’t check these right now. Each item is checked again when it runs.',
  note: {
    trash:
      'Each item is checked again, then moved. The space comes back when the Trash empties.',
    processes: 'Nothing is deleted. Each one is checked again first.',
    emptyAfter:
      'The space is needed now, so the Trash is emptied straight away. That part can’t be undone.',
  },
  approve: {
    trash: ({ count }: { count: number }) => `Move ${count} to Trash`,
    emptyAndRetry: 'Trash, empty and retry',
    keepUndo: 'Move to Trash and retry',
    keepUndoHint: 'Keeps Undo; frees space only when the Trash empties.',
    stop: ({ count }: { count: number }) => `Stop ${count}`,
  },
  notNow: 'Not now',
  declinedTitle: 'Proposal declined',
  declinedFacts: ({ count }: { count: number }) =>
    `${count} items · nothing was changed`,
  reopen: 'Reopen',
  tryAgain: 'Try again',
  startAgain: 'Start again',
  startedAgain: 'Started again',
  keptByGuard: 'Kept, because they are working',
  memoryLabel: 'Memory',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `${now} now · about ${after} after`,
  memoryNow: ({ now }: { now: string }) => `${now} in use`,
  processesTree: 'What is using memory',
  analysingFound: ({ count }: { count: number }) => `${count} found so far`,
  analysingNote: 'Still reading. You can approve when it has finished.',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} items, all safe`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} items · ${safe} safe, ${attention} need your eye`,
    stops: ({ count }: { count: number }) => `Stop ${count}`,
  },
  restored: 'Put back · nothing was removed',
  skipped: ({ reason }: { reason: string }) => `Not moved: ${reason}`,
  stopped: ({ count }: { count: number }) => `Stopped ${count}`,
  stoppedFreed: ({ amount }: { amount: string }) => `${amount} freed`,
  notStopped: ({ reason }: { reason: string }) => `Not stopped: ${reason}`,
  failed: 'This proposal couldn’t finish. Nothing else was changed.',
  processSafe: 'Safe · start again any time',
  processCheck: 'Check first',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}, ${size}, ${verdict}`,
  owner: {
    session: 'Session',
    terminal: 'Terminal',
    service: 'Dev server',
    run: 'Run',
    browser_sidecar: 'Browser sidecar',
    workspace_sync: 'Workspace sync',
    other: 'Process',
  },
} as const;

export type ResourceProposalTranslations = typeof en;

const ca = {
  title: {
    storage: 'Proposta de neteja',
    processes: 'Allibera memòria',
    retry: 'Fes espai i torna-ho a provar',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · comprovat ${time}`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · comprovant…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `${count} de ${total} seleccionats`,
  selectAll: 'Selecciona-ho tot',
  selectAllSafe: 'Selecciona tots els segurs',
  givesBack: 'Recupera',
  frees: 'Allibera',
  onDisk: ({ amount }: { amount: string }) => `de ${amount} al disc`,
  changed: 'canviat',
  gone: 'ja no hi és',
  notIncluded: 'No forma part d’aquesta proposta',
  includeAnyway: 'Inclou-lo',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `${found} de ${goal} trobats`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? 'Una cosa ha canviat des que l’agent ho va mirar.'
      : `${count} coses han canviat des que l’agent ho va mirar.`,
  staleBody: 'No es pot aprovar res fins que no es torni a comprovar.',
  checkAgain: 'Torna a comprovar',
  checkUnavailable:
    'Ara no s’han pogut comprovar. Cada element es torna a comprovar quan s’executa.',
  note: {
    trash:
      'Cada element es torna a comprovar i després es mou. L’espai es recupera quan es buida la Paperera.',
    processes: 'No se suprimeix res. Cada un es torna a comprovar primer.',
    emptyAfter:
      'L’espai cal ara, així que la Paperera es buida de seguida. Aquesta part no es pot desfer.',
  },
  approve: {
    trash: ({ count }: { count: number }) => `Mou ${count} a la Paperera`,
    emptyAndRetry: 'Paperera, buida i torna-ho a provar',
    keepUndo: 'Mou a la Paperera i torna-ho a provar',
    keepUndoHint: 'Manté Desfés; allibera espai només quan es buida la Paperera.',
    stop: ({ count }: { count: number }) => `Atura ${count}`,
  },
  notNow: 'Ara no',
  declinedTitle: 'Proposta rebutjada',
  declinedFacts: ({ count }: { count: number }) =>
    `${count} elements · no s’ha canviat res`,
  reopen: 'Torna a obrir',
  tryAgain: 'Torna-ho a provar',
  startAgain: 'Torna a iniciar',
  startedAgain: 'Iniciat de nou',
  keptByGuard: 'Es mantenen perquè estan treballant',
  memoryLabel: 'Memòria',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `${now} ara · uns ${after} després`,
  memoryNow: ({ now }: { now: string }) => `${now} en ús`,
  processesTree: 'Què fa servir la memòria',
  analysingFound: ({ count }: { count: number }) => `${count} trobats fins ara`,
  analysingNote: 'Encara llegint. Podràs aprovar-ho quan acabi.',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} elements, tots segurs`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} elements · ${safe} segurs, ${attention} necessiten la teva mirada`,
    stops: ({ count }: { count: number }) => `Atura ${count}`,
  },
  restored: 'Restaurat · no s’ha eliminat res',
  skipped: ({ reason }: { reason: string }) => `No s’ha mogut: ${reason}`,
  stopped: ({ count }: { count: number }) => `${count} aturats`,
  stoppedFreed: ({ amount }: { amount: string }) => `${amount} alliberats`,
  notStopped: ({ reason }: { reason: string }) => `No s’ha aturat: ${reason}`,
  failed: 'Aquesta proposta no s’ha pogut completar. No s’ha canviat res més.',
  processSafe: 'Segur · es pot tornar a iniciar en qualsevol moment',
  processCheck: 'Comprova-ho primer',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}, ${size}, ${verdict}`,
  owner: {
    session: 'Sessió',
    terminal: 'Terminal',
    service: 'Servidor de desenvolupament',
    run: 'Execució',
    browser_sidecar: 'Navegador auxiliar',
    workspace_sync: 'Sincronització de l’espai de treball',
    other: 'Procés',
  },
} as const;

const de = {
  title: {
    storage: 'Aufräumvorschlag',
    processes: 'Arbeitsspeicher freigeben',
    retry: 'Platz schaffen und erneut versuchen',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · geprüft ${time}`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · wird geprüft…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `${count} von ${total} ausgewählt`,
  selectAll: 'Alle auswählen',
  selectAllSafe: 'Alle sicheren auswählen',
  givesBack: 'Gibt frei',
  frees: 'Gibt frei',
  onDisk: ({ amount }: { amount: string }) => `von ${amount} auf der Festplatte`,
  changed: 'geändert',
  gone: 'nicht mehr vorhanden',
  notIncluded: 'Nicht Teil dieses Vorschlags',
  includeAnyway: 'Einbeziehen',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `${found} von ${goal} gefunden`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? 'Eine Sache hat sich geändert, seit der Agent nachgesehen hat.'
      : `${count} Dinge haben sich geändert, seit der Agent nachgesehen hat.`,
  staleBody: 'Nichts kann genehmigt werden, bevor es erneut geprüft wurde.',
  checkAgain: 'Erneut prüfen',
  checkUnavailable:
    'Diese konnten gerade nicht geprüft werden. Jedes Element wird bei der Ausführung erneut geprüft.',
  note: {
    trash:
      'Jedes Element wird erneut geprüft und dann verschoben. Der Platz wird frei, wenn der Papierkorb geleert wird.',
    processes: 'Nichts wird gelöscht. Jeder Prozess wird vorher erneut geprüft.',
    emptyAfter:
      'Der Platz wird jetzt benötigt, daher wird der Papierkorb sofort geleert. Dieser Teil kann nicht rückgängig gemacht werden.',
  },
  approve: {
    trash: ({ count }: { count: number }) =>
      `${count} in den Papierkorb verschieben`,
    emptyAndRetry: 'Papierkorb, leeren und erneut versuchen',
    keepUndo: 'In den Papierkorb und erneut versuchen',
    keepUndoHint:
      'Behält Rückgängig; gibt Platz erst frei, wenn der Papierkorb geleert wird.',
    stop: ({ count }: { count: number }) => `${count} beenden`,
  },
  notNow: 'Nicht jetzt',
  declinedTitle: 'Vorschlag abgelehnt',
  declinedFacts: ({ count }: { count: number }) =>
    `${count} Elemente · nichts wurde geändert`,
  reopen: 'Wieder öffnen',
  tryAgain: 'Erneut versuchen',
  startAgain: 'Wieder starten',
  startedAgain: 'Wieder gestartet',
  keptByGuard: 'Bleiben, weil sie arbeiten',
  memoryLabel: 'Arbeitsspeicher',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `jetzt ${now} · danach etwa ${after}`,
  memoryNow: ({ now }: { now: string }) => `${now} belegt`,
  processesTree: 'Was Arbeitsspeicher belegt',
  analysingFound: ({ count }: { count: number }) => `${count} bisher gefunden`,
  analysingNote: 'Liest noch. Du kannst genehmigen, sobald es fertig ist.',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} Elemente, alle sicher`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} Elemente · ${safe} sicher, ${attention} brauchen deinen Blick`,
    stops: ({ count }: { count: number }) => `${count} beenden`,
  },
  restored: 'Zurückgelegt · nichts wurde entfernt',
  skipped: ({ reason }: { reason: string }) => `Nicht verschoben: ${reason}`,
  stopped: ({ count }: { count: number }) => `${count} beendet`,
  stoppedFreed: ({ amount }: { amount: string }) => `${amount} freigegeben`,
  notStopped: ({ reason }: { reason: string }) => `Nicht beendet: ${reason}`,
  failed:
    'Dieser Vorschlag konnte nicht abgeschlossen werden. Sonst wurde nichts geändert.',
  processSafe: 'Sicher · jederzeit neu startbar',
  processCheck: 'Zuerst prüfen',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}, ${size}, ${verdict}`,
  owner: {
    session: 'Sitzung',
    terminal: 'Terminal',
    service: 'Dev-Server',
    run: 'Lauf',
    browser_sidecar: 'Browser-Sidecar',
    workspace_sync: 'Workspace-Synchronisierung',
    other: 'Prozess',
  },
} as const;

const es = {
  title: {
    storage: 'Propuesta de limpieza',
    processes: 'Liberar memoria',
    retry: 'Hacer espacio y reintentar',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · comprobado ${time}`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · comprobando…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `${count} de ${total} seleccionados`,
  selectAll: 'Seleccionar todo',
  selectAllSafe: 'Seleccionar todos los seguros',
  givesBack: 'Recupera',
  frees: 'Libera',
  onDisk: ({ amount }: { amount: string }) => `de ${amount} en disco`,
  changed: 'cambiado',
  gone: 'ya no existe',
  notIncluded: 'No forma parte de esta propuesta',
  includeAnyway: 'Incluirlo',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `${found} de ${goal} encontrados`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? 'Algo cambió desde que el agente lo revisó.'
      : `${count} cosas cambiaron desde que el agente lo revisó.`,
  staleBody: 'No se puede aprobar nada hasta comprobarlo de nuevo.',
  checkAgain: 'Comprobar de nuevo',
  checkUnavailable:
    'No se pudieron comprobar ahora. Cada elemento se vuelve a comprobar al ejecutarse.',
  note: {
    trash:
      'Cada elemento se vuelve a comprobar y luego se mueve. El espacio se recupera cuando se vacía la Papelera.',
    processes: 'No se elimina nada. Cada uno se vuelve a comprobar primero.',
    emptyAfter:
      'El espacio se necesita ahora, así que la Papelera se vacía de inmediato. Esa parte no se puede deshacer.',
  },
  approve: {
    trash: ({ count }: { count: number }) => `Mover ${count} a la Papelera`,
    emptyAndRetry: 'Papelera, vaciar y reintentar',
    keepUndo: 'Mover a la Papelera y reintentar',
    keepUndoHint:
      'Conserva Deshacer; libera espacio solo cuando se vacía la Papelera.',
    stop: ({ count }: { count: number }) => `Detener ${count}`,
  },
  notNow: 'Ahora no',
  declinedTitle: 'Propuesta rechazada',
  declinedFacts: ({ count }: { count: number }) =>
    `${count} elementos · no se cambió nada`,
  reopen: 'Reabrir',
  tryAgain: 'Reintentar',
  startAgain: 'Iniciar de nuevo',
  startedAgain: 'Iniciado de nuevo',
  keptByGuard: 'Se mantienen porque están trabajando',
  memoryLabel: 'Memoria',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `${now} ahora · unos ${after} después`,
  memoryNow: ({ now }: { now: string }) => `${now} en uso`,
  processesTree: 'Qué usa la memoria',
  analysingFound: ({ count }: { count: number }) => `${count} encontrados hasta ahora`,
  analysingNote: 'Aún leyendo. Podrás aprobar cuando termine.',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} elementos, todos seguros`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} elementos · ${safe} seguros, ${attention} necesitan tu atención`,
    stops: ({ count }: { count: number }) => `Detener ${count}`,
  },
  restored: 'Restaurado · no se eliminó nada',
  skipped: ({ reason }: { reason: string }) => `No se movió: ${reason}`,
  stopped: ({ count }: { count: number }) => `${count} detenidos`,
  stoppedFreed: ({ amount }: { amount: string }) => `${amount} liberados`,
  notStopped: ({ reason }: { reason: string }) => `No se detuvo: ${reason}`,
  failed: 'Esta propuesta no pudo terminar. No se cambió nada más.',
  processSafe: 'Seguro · se puede volver a iniciar en cualquier momento',
  processCheck: 'Comprobar primero',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}, ${size}, ${verdict}`,
  owner: {
    session: 'Sesión',
    terminal: 'Terminal',
    service: 'Servidor de desarrollo',
    run: 'Ejecución',
    browser_sidecar: 'Navegador auxiliar',
    workspace_sync: 'Sincronización del espacio de trabajo',
    other: 'Proceso',
  },
} as const;

const fr = {
  title: {
    storage: 'Proposition de nettoyage',
    processes: 'Libérer de la mémoire',
    retry: 'Faire de la place et réessayer',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · vérifié ${time}`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · vérification…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `${count} sur ${total} sélectionnés`,
  selectAll: 'Tout sélectionner',
  selectAllSafe: 'Sélectionner tous les éléments sûrs',
  givesBack: 'Récupère',
  frees: 'Libère',
  onDisk: ({ amount }: { amount: string }) => `sur ${amount} sur le disque`,
  changed: 'modifié',
  gone: 'disparu',
  notIncluded: 'Ne fait pas partie de cette proposition',
  includeAnyway: 'L’inclure',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `${found} trouvés sur ${goal}`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? 'Une chose a changé depuis que l’agent a regardé.'
      : `${count} choses ont changé depuis que l’agent a regardé.`,
  staleBody: 'Rien ne peut être approuvé avant une nouvelle vérification.',
  checkAgain: 'Vérifier à nouveau',
  checkUnavailable:
    'Impossible de les vérifier pour le moment. Chaque élément est revérifié lors de son exécution.',
  note: {
    trash:
      'Chaque élément est revérifié, puis déplacé. L’espace est récupéré quand la corbeille est vidée.',
    processes: 'Rien n’est supprimé. Chacun est d’abord revérifié.',
    emptyAfter:
      'L’espace est nécessaire maintenant, la corbeille est donc vidée immédiatement. Cette partie est irréversible.',
  },
  approve: {
    trash: ({ count }: { count: number }) =>
      `Déplacer ${count} dans la corbeille`,
    emptyAndRetry: 'Corbeille, vider et réessayer',
    keepUndo: 'Mettre à la corbeille et réessayer',
    keepUndoHint:
      'Conserve Annuler ; libère de l’espace seulement quand la corbeille est vidée.',
    stop: ({ count }: { count: number }) => `Arrêter ${count}`,
  },
  notNow: 'Pas maintenant',
  declinedTitle: 'Proposition refusée',
  declinedFacts: ({ count }: { count: number }) =>
    `${count} éléments · rien n’a été modifié`,
  reopen: 'Rouvrir',
  tryAgain: 'Réessayer',
  startAgain: 'Relancer',
  startedAgain: 'Relancé',
  keptByGuard: 'Conservés, car ils travaillent',
  memoryLabel: 'Mémoire',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `${now} maintenant · environ ${after} après`,
  memoryNow: ({ now }: { now: string }) => `${now} utilisés`,
  processesTree: 'Ce qui utilise la mémoire',
  analysingFound: ({ count }: { count: number }) => `${count} trouvés pour l’instant`,
  analysingNote: 'Lecture en cours. Tu pourras approuver une fois terminé.',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} éléments, tous sûrs`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} éléments · ${safe} sûrs, ${attention} à vérifier`,
    stops: ({ count }: { count: number }) => `Arrêter ${count}`,
  },
  restored: 'Remis en place · rien n’a été supprimé',
  skipped: ({ reason }: { reason: string }) => `Non déplacé : ${reason}`,
  stopped: ({ count }: { count: number }) => `${count} arrêtés`,
  stoppedFreed: ({ amount }: { amount: string }) => `${amount} libérés`,
  notStopped: ({ reason }: { reason: string }) => `Non arrêté : ${reason}`,
  failed: 'Cette proposition n’a pas pu aboutir. Rien d’autre n’a été modifié.',
  processSafe: 'Sûr · peut être relancé à tout moment',
  processCheck: 'Vérifier d’abord',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}, ${size}, ${verdict}`,
  owner: {
    session: 'Session',
    terminal: 'Terminal',
    service: 'Serveur de dev',
    run: 'Exécution',
    browser_sidecar: 'Navigateur annexe',
    workspace_sync: 'Synchronisation de l’espace de travail',
    other: 'Processus',
  },
} as const;

const it = {
  title: {
    storage: 'Proposta di pulizia',
    processes: 'Libera memoria',
    retry: 'Fai spazio e riprova',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · verificato ${time}`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · verifica in corso…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `${count} di ${total} selezionati`,
  selectAll: 'Seleziona tutto',
  selectAllSafe: 'Seleziona tutti i sicuri',
  givesBack: 'Recupera',
  frees: 'Libera',
  onDisk: ({ amount }: { amount: string }) => `di ${amount} su disco`,
  changed: 'modificato',
  gone: 'non più presente',
  notIncluded: 'Non fa parte di questa proposta',
  includeAnyway: 'Includilo',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `${found} di ${goal} trovati`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? 'Una cosa è cambiata da quando l’agente ha controllato.'
      : `${count} cose sono cambiate da quando l’agente ha controllato.`,
  staleBody: 'Non si può approvare nulla finché non viene verificato di nuovo.',
  checkAgain: 'Verifica di nuovo',
  checkUnavailable:
    'Impossibile verificarli ora. Ogni elemento viene verificato di nuovo quando viene eseguito.',
  note: {
    trash:
      'Ogni elemento viene verificato di nuovo, poi spostato. Lo spazio torna disponibile quando il Cestino viene svuotato.',
    processes: 'Non viene eliminato nulla. Ognuno viene prima verificato di nuovo.',
    emptyAfter:
      'Lo spazio serve ora, quindi il Cestino viene svuotato subito. Questa parte non può essere annullata.',
  },
  approve: {
    trash: ({ count }: { count: number }) => `Sposta ${count} nel Cestino`,
    emptyAndRetry: 'Cestino, svuota e riprova',
    keepUndo: 'Sposta nel Cestino e riprova',
    keepUndoHint:
      'Mantiene Annulla; libera spazio solo quando il Cestino viene svuotato.',
    stop: ({ count }: { count: number }) => `Arresta ${count}`,
  },
  notNow: 'Non ora',
  declinedTitle: 'Proposta rifiutata',
  declinedFacts: ({ count }: { count: number }) =>
    `${count} elementi · non è stato modificato nulla`,
  reopen: 'Riapri',
  tryAgain: 'Riprova',
  startAgain: 'Avvia di nuovo',
  startedAgain: 'Avviato di nuovo',
  keptByGuard: 'Mantenuti perché stanno lavorando',
  memoryLabel: 'Memoria',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `${now} ora · circa ${after} dopo`,
  memoryNow: ({ now }: { now: string }) => `${now} in uso`,
  processesTree: 'Cosa usa la memoria',
  analysingFound: ({ count }: { count: number }) => `${count} trovati finora`,
  analysingNote: 'Ancora in lettura. Potrai approvare quando avrà finito.',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} elementi, tutti sicuri`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} elementi · ${safe} sicuri, ${attention} da controllare`,
    stops: ({ count }: { count: number }) => `Ferma ${count}`,
  },
  restored: 'Ripristinato · non è stato rimosso nulla',
  skipped: ({ reason }: { reason: string }) => `Non spostato: ${reason}`,
  stopped: ({ count }: { count: number }) => `${count} arrestati`,
  stoppedFreed: ({ amount }: { amount: string }) => `${amount} liberati`,
  notStopped: ({ reason }: { reason: string }) => `Non arrestato: ${reason}`,
  failed:
    'Questa proposta non è stata completata. Non è stato modificato nient’altro.',
  processSafe: 'Sicuro · riavviabile in qualsiasi momento',
  processCheck: 'Verifica prima',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}, ${size}, ${verdict}`,
  owner: {
    session: 'Sessione',
    terminal: 'Terminale',
    service: 'Server di sviluppo',
    run: 'Esecuzione',
    browser_sidecar: 'Browser ausiliario',
    workspace_sync: 'Sincronizzazione workspace',
    other: 'Processo',
  },
} as const;

const ja = {
  title: {
    storage: 'クリーンアップの提案',
    processes: 'メモリを解放',
    retry: '空きを作って再試行',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · ${time}に確認`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · 確認中…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `${total}件中${count}件を選択`,
  selectAll: 'すべて選択',
  selectAllSafe: '安全なものをすべて選択',
  givesBack: '回復',
  frees: '解放',
  onDisk: ({ amount }: { amount: string }) => `ディスク上の${amount}のうち`,
  changed: '変更あり',
  gone: '存在しません',
  notIncluded: 'この提案には含まれていません',
  includeAnyway: '含める',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `${goal}のうち${found}を検出`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? 'エージェントの確認後に1件変更されました。'
      : `エージェントの確認後に${count}件変更されました。`,
  staleBody: '再確認するまで承認できません。',
  checkAgain: '再確認',
  checkUnavailable:
    '今は確認できませんでした。各項目は実行時に再確認されます。',
  note: {
    trash:
      '各項目は再確認されてから移動されます。ゴミ箱を空にすると容量が戻ります。',
    processes: '何も削除されません。それぞれ最初に再確認されます。',
    emptyAfter:
      '今すぐ容量が必要なため、ゴミ箱はすぐに空になります。この操作は元に戻せません。',
  },
  approve: {
    trash: ({ count }: { count: number }) => `${count}件をゴミ箱に移動`,
    emptyAndRetry: 'ゴミ箱に移動、空にして再試行',
    keepUndo: 'ゴミ箱に移動して再試行',
    keepUndoHint: '元に戻せます。容量はゴミ箱を空にしたときに解放されます。',
    stop: ({ count }: { count: number }) => `${count}件を停止`,
  },
  notNow: '今はしない',
  declinedTitle: '提案を却下しました',
  declinedFacts: ({ count }: { count: number }) =>
    `${count}件 · 何も変更されていません`,
  reopen: '再度開く',
  tryAgain: '再試行',
  startAgain: 'もう一度開始',
  startedAgain: '再開しました',
  keptByGuard: '作業中のため保持',
  memoryLabel: 'メモリ',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `現在 ${now} · 後で約 ${after}`,
  memoryNow: ({ now }: { now: string }) => `${now} 使用中`,
  processesTree: 'メモリを使っているもの',
  analysingFound: ({ count }: { count: number }) => `これまでに ${count} 件`,
  analysingNote: '読み込み中です。完了後に承認できます。',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} 件、すべて安全`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} 件 · 安全 ${safe} 件、確認が必要 ${attention} 件`,
    stops: ({ count }: { count: number }) => `${count} 件を停止`,
  },
  restored: '元に戻しました · 何も削除されていません',
  skipped: ({ reason }: { reason: string }) => `移動されませんでした: ${reason}`,
  stopped: ({ count }: { count: number }) => `${count}件を停止しました`,
  stoppedFreed: ({ amount }: { amount: string }) => `${amount}を解放`,
  notStopped: ({ reason }: { reason: string }) => `停止されませんでした: ${reason}`,
  failed: 'この提案を完了できませんでした。他には何も変更されていません。',
  processSafe: '安全 · いつでも再起動できます',
  processCheck: '先に確認',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}、${size}、${verdict}`,
  owner: {
    session: 'セッション',
    terminal: 'ターミナル',
    service: '開発サーバー',
    run: '実行',
    browser_sidecar: 'ブラウザサイドカー',
    workspace_sync: 'ワークスペース同期',
    other: 'プロセス',
  },
} as const;

const pl = {
  title: {
    storage: 'Propozycja porządków',
    processes: 'Zwolnij pamięć',
    retry: 'Zwolnij miejsce i ponów',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · sprawdzono ${time}`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · sprawdzanie…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `Wybrano ${count} z ${total}`,
  selectAll: 'Zaznacz wszystko',
  selectAllSafe: 'Zaznacz wszystkie bezpieczne',
  givesBack: 'Odzyskuje',
  frees: 'Zwalnia',
  onDisk: ({ amount }: { amount: string }) => `z ${amount} na dysku`,
  changed: 'zmieniono',
  gone: 'już nie istnieje',
  notIncluded: 'Nie jest częścią tej propozycji',
  includeAnyway: 'Uwzględnij',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `Znaleziono ${found} z ${goal}`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? 'Jedna rzecz zmieniła się od sprawdzenia przez agenta.'
      : `Zmiany od sprawdzenia przez agenta: ${count}.`,
  staleBody: 'Nic nie może zostać zatwierdzone przed ponownym sprawdzeniem.',
  checkAgain: 'Sprawdź ponownie',
  checkUnavailable:
    'Nie udało się ich teraz sprawdzić. Każdy element jest sprawdzany ponownie podczas wykonania.',
  note: {
    trash:
      'Każdy element jest ponownie sprawdzany, a potem przenoszony. Miejsce wraca po opróżnieniu Kosza.',
    processes: 'Nic nie jest usuwane. Każdy jest najpierw ponownie sprawdzany.',
    emptyAfter:
      'Miejsce jest potrzebne teraz, więc Kosz zostanie od razu opróżniony. Tej części nie można cofnąć.',
  },
  approve: {
    trash: ({ count }: { count: number }) => `Przenieś do Kosza: ${count}`,
    emptyAndRetry: 'Kosz, opróżnij i ponów',
    keepUndo: 'Przenieś do Kosza i ponów',
    keepUndoHint:
      'Zachowuje Cofnij; zwalnia miejsce dopiero po opróżnieniu Kosza.',
    stop: ({ count }: { count: number }) => `Zatrzymaj: ${count}`,
  },
  notNow: 'Nie teraz',
  declinedTitle: 'Propozycja odrzucona',
  declinedFacts: ({ count }: { count: number }) =>
    `Elementy: ${count} · nic nie zmieniono`,
  reopen: 'Otwórz ponownie',
  tryAgain: 'Spróbuj ponownie',
  startAgain: 'Uruchom ponownie',
  startedAgain: 'Uruchomiono ponownie',
  keptByGuard: 'Zostają, bo pracują',
  memoryLabel: 'Pamięć',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `teraz ${now} · potem ok. ${after}`,
  memoryNow: ({ now }: { now: string }) => `${now} w użyciu`,
  processesTree: 'Co używa pamięci',
  analysingFound: ({ count }: { count: number }) => `Dotąd znaleziono ${count}`,
  analysingNote: 'Wciąż czyta. Zatwierdzisz, gdy skończy.',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} elementów, wszystkie bezpieczne`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} elementów · ${safe} bezpiecznych, ${attention} do sprawdzenia`,
    stops: ({ count }: { count: number }) => `Zatrzymaj ${count}`,
  },
  restored: 'Przywrócono · nic nie usunięto',
  skipped: ({ reason }: { reason: string }) => `Nie przeniesiono: ${reason}`,
  stopped: ({ count }: { count: number }) => `Zatrzymano: ${count}`,
  stoppedFreed: ({ amount }: { amount: string }) => `Zwolniono ${amount}`,
  notStopped: ({ reason }: { reason: string }) => `Nie zatrzymano: ${reason}`,
  failed: 'Nie udało się dokończyć tej propozycji. Nic więcej nie zmieniono.',
  processSafe: 'Bezpieczne · można uruchomić ponownie w każdej chwili',
  processCheck: 'Najpierw sprawdź',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}, ${size}, ${verdict}`,
  owner: {
    session: 'Sesja',
    terminal: 'Terminal',
    service: 'Serwer deweloperski',
    run: 'Uruchomienie',
    browser_sidecar: 'Przeglądarka pomocnicza',
    workspace_sync: 'Synchronizacja obszaru roboczego',
    other: 'Proces',
  },
} as const;

const pt = {
  title: {
    storage: 'Proposta de limpeza',
    processes: 'Libertar memória',
    retry: 'Libertar espaço e tentar novamente',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · verificado ${time}`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · a verificar…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `${count} de ${total} selecionados`,
  selectAll: 'Selecionar tudo',
  selectAllSafe: 'Selecionar todos os seguros',
  givesBack: 'Recupera',
  frees: 'Liberta',
  onDisk: ({ amount }: { amount: string }) => `de ${amount} em disco`,
  changed: 'alterado',
  gone: 'já não existe',
  notIncluded: 'Não faz parte desta proposta',
  includeAnyway: 'Incluir',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `${found} de ${goal} encontrados`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? 'Uma coisa mudou desde que o agente verificou.'
      : `${count} coisas mudaram desde que o agente verificou.`,
  staleBody: 'Nada pode ser aprovado até ser verificado novamente.',
  checkAgain: 'Verificar novamente',
  checkUnavailable:
    'Não foi possível verificá-los agora. Cada item é verificado novamente quando é executado.',
  note: {
    trash:
      'Cada item é verificado novamente e depois movido. O espaço é recuperado quando o Lixo é esvaziado.',
    processes: 'Nada é eliminado. Cada um é verificado novamente primeiro.',
    emptyAfter:
      'O espaço é necessário agora, por isso o Lixo é esvaziado de imediato. Essa parte não pode ser anulada.',
  },
  approve: {
    trash: ({ count }: { count: number }) => `Mover ${count} para o Lixo`,
    emptyAndRetry: 'Lixo, esvaziar e tentar novamente',
    keepUndo: 'Mover para o Lixo e tentar novamente',
    keepUndoHint:
      'Mantém Anular; liberta espaço apenas quando o Lixo é esvaziado.',
    stop: ({ count }: { count: number }) => `Parar ${count}`,
  },
  notNow: 'Agora não',
  declinedTitle: 'Proposta recusada',
  declinedFacts: ({ count }: { count: number }) =>
    `${count} itens · nada foi alterado`,
  reopen: 'Reabrir',
  tryAgain: 'Tentar novamente',
  startAgain: 'Iniciar novamente',
  startedAgain: 'Iniciado novamente',
  keptByGuard: 'Mantidos porque estão trabalhando',
  memoryLabel: 'Memória',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `${now} agora · cerca de ${after} depois`,
  memoryNow: ({ now }: { now: string }) => `${now} em uso`,
  processesTree: 'O que está usando memória',
  analysingFound: ({ count }: { count: number }) => `${count} encontrados até agora`,
  analysingNote: 'Ainda lendo. Você pode aprovar quando terminar.',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} itens, todos seguros`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} itens · ${safe} seguros, ${attention} precisam da sua atenção`,
    stops: ({ count }: { count: number }) => `Parar ${count}`,
  },
  restored: 'Reposto · nada foi removido',
  skipped: ({ reason }: { reason: string }) => `Não movido: ${reason}`,
  stopped: ({ count }: { count: number }) => `${count} parados`,
  stoppedFreed: ({ amount }: { amount: string }) => `${amount} libertados`,
  notStopped: ({ reason }: { reason: string }) => `Não parado: ${reason}`,
  failed: 'Esta proposta não pôde ser concluída. Nada mais foi alterado.',
  processSafe: 'Seguro · pode ser reiniciado a qualquer momento',
  processCheck: 'Verificar primeiro',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}, ${size}, ${verdict}`,
  owner: {
    session: 'Sessão',
    terminal: 'Terminal',
    service: 'Servidor de desenvolvimento',
    run: 'Execução',
    browser_sidecar: 'Navegador auxiliar',
    workspace_sync: 'Sincronização do espaço de trabalho',
    other: 'Processo',
  },
} as const;

const ru = {
  title: {
    storage: 'Предложение по очистке',
    processes: 'Освободить память',
    retry: 'Освободить место и повторить',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · проверено ${time}`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · проверка…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `Выбрано ${count} из ${total}`,
  selectAll: 'Выбрать все',
  selectAllSafe: 'Выбрать все безопасные',
  givesBack: 'Вернёт',
  frees: 'Освободит',
  onDisk: ({ amount }: { amount: string }) => `из ${amount} на диске`,
  changed: 'изменено',
  gone: 'больше нет',
  notIncluded: 'Не входит в это предложение',
  includeAnyway: 'Включить',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `Найдено ${found} из ${goal}`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? 'С момента проверки агентом изменился один элемент.'
      : `С момента проверки агентом изменилось элементов: ${count}.`,
  staleBody: 'Ничего нельзя одобрить, пока не будет повторной проверки.',
  checkAgain: 'Проверить снова',
  checkUnavailable:
    'Сейчас проверить не удалось. Каждый элемент проверяется заново при выполнении.',
  note: {
    trash:
      'Каждый элемент проверяется заново, затем перемещается. Место освободится, когда корзина будет очищена.',
    processes: 'Ничего не удаляется. Каждый сначала проверяется заново.',
    emptyAfter:
      'Место нужно сейчас, поэтому корзина будет очищена сразу. Эту часть нельзя отменить.',
  },
  approve: {
    trash: ({ count }: { count: number }) =>
      `Переместить в корзину: ${count}`,
    emptyAndRetry: 'В корзину, очистить и повторить',
    keepUndo: 'В корзину и повторить',
    keepUndoHint:
      'Сохраняет отмену; место освобождается только после очистки корзины.',
    stop: ({ count }: { count: number }) => `Остановить: ${count}`,
  },
  notNow: 'Не сейчас',
  declinedTitle: 'Предложение отклонено',
  declinedFacts: ({ count }: { count: number }) =>
    `Элементов: ${count} · ничего не изменено`,
  reopen: 'Открыть снова',
  tryAgain: 'Повторить',
  startAgain: 'Запустить снова',
  startedAgain: 'Запущено снова',
  keptByGuard: 'Оставлены, потому что работают',
  memoryLabel: 'Память',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `сейчас ${now} · потом около ${after}`,
  memoryNow: ({ now }: { now: string }) => `${now} занято`,
  processesTree: 'Что использует память',
  analysingFound: ({ count }: { count: number }) => `Пока найдено: ${count}`,
  analysingNote: 'Ещё читает. Одобрить можно, когда закончит.',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} элементов, все безопасны`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} элементов · ${safe} безопасны, ${attention} требуют внимания`,
    stops: ({ count }: { count: number }) => `Остановить ${count}`,
  },
  restored: 'Возвращено · ничего не удалено',
  skipped: ({ reason }: { reason: string }) => `Не перемещено: ${reason}`,
  stopped: ({ count }: { count: number }) => `Остановлено: ${count}`,
  stoppedFreed: ({ amount }: { amount: string }) => `Освобождено ${amount}`,
  notStopped: ({ reason }: { reason: string }) => `Не остановлено: ${reason}`,
  failed: 'Не удалось завершить это предложение. Больше ничего не изменено.',
  processSafe: 'Безопасно · можно запустить снова в любой момент',
  processCheck: 'Сначала проверить',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}, ${size}, ${verdict}`,
  owner: {
    session: 'Сессия',
    terminal: 'Терминал',
    service: 'Сервер разработки',
    run: 'Запуск',
    browser_sidecar: 'Вспомогательный браузер',
    workspace_sync: 'Синхронизация рабочей области',
    other: 'Процесс',
  },
} as const;

const zhHans = {
  title: {
    storage: '清理建议',
    processes: '释放内存',
    retry: '腾出空间并重试',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · ${time}已检查`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · 正在检查…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `已选择 ${count}/${total}`,
  selectAll: '全选',
  selectAllSafe: '选择所有安全项',
  givesBack: '可回收',
  frees: '可释放',
  onDisk: ({ amount }: { amount: string }) => `占磁盘 ${amount}`,
  changed: '已更改',
  gone: '已不存在',
  notIncluded: '不属于此建议',
  includeAnyway: '包含它',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `已找到 ${found}，目标 ${goal}`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? '自代理检查后有 1 项发生了变化。'
      : `自代理检查后有 ${count} 项发生了变化。`,
  staleBody: '重新检查之前无法批准任何内容。',
  checkAgain: '重新检查',
  checkUnavailable: '暂时无法检查这些项目。每一项在执行时都会重新检查。',
  note: {
    trash: '每一项都会重新检查后再移动。清空废纸篓后空间才会释放。',
    processes: '不会删除任何内容。每一项都会先重新检查。',
    emptyAfter: '现在就需要空间，因此会立即清空废纸篓。这一步无法撤销。',
  },
  approve: {
    trash: ({ count }: { count: number }) => `将 ${count} 项移到废纸篓`,
    emptyAndRetry: '移到废纸篓、清空并重试',
    keepUndo: '移到废纸篓并重试',
    keepUndoHint: '保留撤销；仅在清空废纸篓后释放空间。',
    stop: ({ count }: { count: number }) => `停止 ${count} 项`,
  },
  notNow: '暂不',
  declinedTitle: '已拒绝建议',
  declinedFacts: ({ count }: { count: number }) =>
    `${count} 项 · 未做任何更改`,
  reopen: '重新打开',
  tryAgain: '重试',
  startAgain: '重新启动',
  startedAgain: '已重新启动',
  keptByGuard: '因正在工作而保留',
  memoryLabel: '内存',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `现在 ${now} · 之后约 ${after}`,
  memoryNow: ({ now }: { now: string }) => `已用 ${now}`,
  processesTree: '正在使用内存的内容',
  analysingFound: ({ count }: { count: number }) => `目前已找到 ${count} 项`,
  analysingNote: '仍在读取。完成后即可批准。',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} 项，全部安全`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} 项 · ${safe} 项安全，${attention} 项需要你查看`,
    stops: ({ count }: { count: number }) => `停止 ${count} 项`,
  },
  restored: '已放回 · 未移除任何内容',
  skipped: ({ reason }: { reason: string }) => `未移动：${reason}`,
  stopped: ({ count }: { count: number }) => `已停止 ${count} 项`,
  stoppedFreed: ({ amount }: { amount: string }) => `已释放 ${amount}`,
  notStopped: ({ reason }: { reason: string }) => `未停止：${reason}`,
  failed: '此建议未能完成。未更改其他任何内容。',
  processSafe: '安全 · 随时可重新启动',
  processCheck: '请先检查',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}，${size}，${verdict}`,
  owner: {
    session: '会话',
    terminal: '终端',
    service: '开发服务器',
    run: '运行',
    browser_sidecar: '浏览器辅助进程',
    workspace_sync: '工作区同步',
    other: '进程',
  },
} as const;

const zhHant = {
  title: {
    storage: '清理建議',
    processes: '釋放記憶體',
    retry: '騰出空間並重試',
  },
  machineChecked: ({ machine, time }: { machine: string; time: string }) =>
    `${machine} · ${time}已檢查`,
  machineChecking: ({ machine }: { machine: string }) =>
    `${machine} · 正在檢查…`,
  selected: ({ count, total }: { count: number; total: number }) =>
    `已選取 ${count}/${total}`,
  selectAll: '全選',
  selectAllSafe: '選取所有安全項目',
  givesBack: '可回收',
  frees: '可釋放',
  onDisk: ({ amount }: { amount: string }) => `佔磁碟 ${amount}`,
  changed: '已變更',
  gone: '已不存在',
  notIncluded: '不屬於此建議',
  includeAnyway: '包含它',
  goal: ({ found, goal }: { found: string; goal: string }) =>
    `已找到 ${found}，目標 ${goal}`,
  staleTitle: ({ count }: { count: number }) =>
    count === 1
      ? '自代理檢查後有 1 項發生了變化。'
      : `自代理檢查後有 ${count} 項發生了變化。`,
  staleBody: '重新檢查之前無法核准任何內容。',
  checkAgain: '重新檢查',
  checkUnavailable: '暫時無法檢查這些項目。每一項在執行時都會重新檢查。',
  note: {
    trash: '每一項都會重新檢查後再移動。清空垃圾桶後空間才會釋放。',
    processes: '不會刪除任何內容。每一項都會先重新檢查。',
    emptyAfter: '現在就需要空間，因此會立即清空垃圾桶。這一步無法復原。',
  },
  approve: {
    trash: ({ count }: { count: number }) => `將 ${count} 項移到垃圾桶`,
    emptyAndRetry: '移到垃圾桶、清空並重試',
    keepUndo: '移到垃圾桶並重試',
    keepUndoHint: '保留復原；僅在清空垃圾桶後釋放空間。',
    stop: ({ count }: { count: number }) => `停止 ${count} 項`,
  },
  notNow: '暫不',
  declinedTitle: '已拒絕建議',
  declinedFacts: ({ count }: { count: number }) =>
    `${count} 項 · 未做任何變更`,
  reopen: '重新開啟',
  tryAgain: '重試',
  startAgain: '重新啟動',
  startedAgain: '已重新啟動',
  keptByGuard: '因正在工作而保留',
  memoryLabel: '記憶體',
  memoryAfter: ({ now, after }: { now: string; after: string }) => `現在 ${now} · 之後約 ${after}`,
  memoryNow: ({ now }: { now: string }) => `已用 ${now}`,
  processesTree: '正在使用記憶體的內容',
  analysingFound: ({ count }: { count: number }) => `目前已找到 ${count} 項`,
  analysingNote: '仍在讀取。完成後即可核准。',
  inbox: {
    allSafe: ({ count }: { count: number }) => `${count} 項，全部安全`,
    mixed: ({ count, safe, attention }: { count: number; safe: number; attention: number }) => `${count} 項 · ${safe} 項安全，${attention} 項需要你查看`,
    stops: ({ count }: { count: number }) => `停止 ${count} 項`,
  },
  restored: '已放回 · 未移除任何內容',
  skipped: ({ reason }: { reason: string }) => `未移動：${reason}`,
  stopped: ({ count }: { count: number }) => `已停止 ${count} 項`,
  stoppedFreed: ({ amount }: { amount: string }) => `已釋放 ${amount}`,
  notStopped: ({ reason }: { reason: string }) => `未停止：${reason}`,
  failed: '此建議未能完成。未變更其他任何內容。',
  processSafe: '安全 · 隨時可重新啟動',
  processCheck: '請先檢查',
  itemLabel: ({
    title,
    size,
    verdict,
  }: {
    title: string;
    size: string;
    verdict: string;
  }) => `${title}，${size}，${verdict}`,
  owner: {
    session: '工作階段',
    terminal: '終端機',
    service: '開發伺服器',
    run: '執行',
    browser_sidecar: '瀏覽器輔助程序',
    workspace_sync: '工作區同步',
    other: '程序',
  },
} as const;

export const resourceProposalTranslations = {
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
