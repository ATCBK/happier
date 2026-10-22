// MCP sign-in copy (P7 U7.9): the server page's Sign-in section (T2 states) and the `/oauth/mcp/callback`
// page. Mounted under `capabilities.mcpSignIn`.

type Named = Readonly<{ name: string }>;

export type McpSignInTranslation = Readonly<{
  title: string;
  notConnectedTitle: (params: Named) => string;
  notConnectedBody: (params: Named) => string;
  signIn: string;
  signingTitle: string;
  signingBody: (params: Named) => string;
  waiting: (params: Named) => string;
  cancel: string;
  notSignedInHere: (params: Named) => string;
  usePhone: string;
  or: string;
  copyLink: string;
  linkCopied: string;
  phoneTitle: string;
  phoneBody: string;
  phoneWaiting: string;
  timeLeft: (params: Readonly<{ time: string }>) => string;
  useThisDevice: string;
  pasteTitle: string;
  pasteBody: string;
  finishingTitle: (params: Readonly<{ machine: string }>) => string;
  finishingBody: (
    params: Readonly<{ name: string; machine: string }>,
  ) => string;
  connectedAs: (params: Readonly<{ identity: string }>) => string;
  connected: string;
  connectedBody: string;
  connectedSince: (params: Readonly<{ date: string }>) => string;
  signOut: string;
  signOutTitle: (params: Named) => string;
  signOutBody: (params: Named) => string;
  signOutFailed: string;
  moreAccessChip: string;
  moreAccessBody: (params: Named) => string;
  grantAccess: string;
  expiredChip: string;
  expiredBody: (params: Named) => string;
  addressChangedChip: string;
  addressChangedBody: string;
  reconnect: string;
  revokedChip: string;
  revokedBody: (params: Named) => string;
  signInAgain: string;
  didNotFinishTitle: (params: Named) => string;
  didNotFinishBody: string;
  tryAgain: string;
  noMachineTitle: string;
  noMachineBody: string;
  clientRefusedTitle: (params: Named) => string;
  clientRefusedBody: string;
  useApiKey: string;
  useOwnApp: string;
  ownAppBody: string;
  callbackUrl: string;
  clientId: string;
  clientSecret: string;
  editOwnApp: string;
  removeOwnApp: string;
  invalidClientTitle: string;
  invalidClientBody: string;
  ownAppNotNeeded: string;
  reviewSetApp: string;
  reviewRemoveApp: string;
  callback: Readonly<{
    finishing: string;
    closeTitle: string;
    closeBody: string;
    connectedTitle: string;
    connectedBody: string;
    pasteTitle: string;
    pasteBody: string;
    copyCode: string;
    copied: string;
    invalidTitle: string;
    invalidBody: string;
    unfinishedTitle: string;
    unfinishedBody: string;
    openServers: string;
  }>;
}>;

const en: McpSignInTranslation = {
  title: 'Sign-in',
  notConnectedTitle: ({ name }) => `Sign in to ${name}`,
  notConnectedBody: ({ name }) =>
    `${name} asks you to approve access once. It then works on every machine and in every session.`,
  signIn: 'Sign in',
  signingTitle: 'Continue in your browser',
  signingBody: ({ name }) =>
    `Approve Happier in ${name}. This page updates by itself.`,
  waiting: ({ name }) => `Waiting for ${name}…`,
  cancel: 'Cancel',
  notSignedInHere: ({ name }) => `Not signed in to ${name} here?`,
  usePhone: 'Use your phone',
  or: 'or',
  copyLink: 'copy the link',
  linkCopied: 'Link copied',
  phoneTitle: 'Scan with your phone',
  phoneBody: 'Approve on your phone. This page finishes the sign-in.',
  phoneWaiting: 'Waiting…',
  timeLeft: ({ time }) => `${time} left`,
  useThisDevice: 'Use this device',
  pasteTitle: 'Got a code instead?',
  pasteBody: 'If the browser showed a code or a page address, paste it here.',
  finishingTitle: ({ machine }) => `Finishing sign-in on ${machine}`,
  finishingBody: ({ name, machine }) =>
    `Approved in ${name}. ${machine} is completing it for your Account; every machine can use it in a moment.`,
  connectedAs: ({ identity }) => `Connected as ${identity}`,
  connected: 'Connected',
  connectedBody: 'Works on every machine.',
  connectedSince: ({ date }) => `Works on every machine · signed in ${date}`,
  signOut: 'Sign out',
  signOutTitle: ({ name }) => `Sign out of ${name}?`,
  signOutBody: ({ name }) =>
    `Sessions start without ${name}’s tools until you sign in again. Your setup is kept.`,
  signOutFailed: 'Couldn’t sign out. Try again when a machine is online.',
  moreAccessChip: 'Needs more access',
  moreAccessBody: ({ name }) =>
    `A tool asked ${name} for access you haven’t granted. Approve it once and the call can run.`,
  grantAccess: 'Grant access',
  expiredChip: 'Sign-in expired',
  expiredBody: ({ name }) =>
    `${name} stopped accepting it. Sessions start without its tools until you reconnect.`,
  addressChangedChip: 'Address changed',
  addressChangedBody:
    'The server’s address changed since you signed in. Sign in again to use it.',
  reconnect: 'Reconnect',
  revokedChip: 'Access revoked',
  revokedBody: ({ name }) =>
    `The access was removed in ${name}’s settings. Your setup is kept.`,
  signInAgain: 'Sign in again',
  didNotFinishTitle: ({ name }) => `${name} didn’t finish the sign-in`,
  didNotFinishBody: 'Sign-in is not complete. Try again when you’re ready.',
  tryAgain: 'Try again',
  noMachineTitle: 'Sign-in needs a machine online',
  noMachineBody:
    'A machine finishes the sign-in for you. None of yours is online right now.',
  clientRefusedTitle: ({ name }) => `${name} doesn’t let Happier sign in`,
  clientRefusedBody:
    'It doesn’t let apps register for sign-in. Use an API key if it offers one.',
  useApiKey: 'Use an API key',
  useOwnApp: 'Use your own OAuth app',
  ownAppBody: 'Create an OAuth app in the service’s console with this callback URL, then enter its details. Happier saves it with your Account sign-in.',
  callbackUrl: 'Callback URL',
  clientId: 'Client ID',
  clientSecret: 'Client secret (optional)',
  editOwnApp: 'Edit your OAuth app',
  removeOwnApp: 'Remove app and retry automatic sign-in',
  invalidClientTitle: 'The OAuth app was rejected',
  invalidClientBody: 'Check the Client ID, secret and registered callback URL, then sign in again.',
  ownAppNotNeeded: 'This service accepts Happier’s app identity. Your own OAuth app is not needed.',
  reviewSetApp: 'Set or replace OAuth app',
  reviewRemoveApp: 'Remove OAuth app',
  callback: {
    finishing: 'Finishing sign-in…',
    closeTitle: 'Signed in',
    closeBody: 'You can close this tab and go back to Happier.',
    connectedTitle: 'Signed in',
    connectedBody: 'Taking you back to the server…',
    pasteTitle: 'Copy this code into Happier',
    pasteBody:
      'Paste it on the server page where you started signing in. It only works there, once.',
    copyCode: 'Copy code',
    copied: 'Copied',
    invalidTitle: 'This sign-in link isn’t complete',
    invalidBody: 'Start the sign-in again from the server page.',
    unfinishedTitle: 'The sign-in didn’t finish',
    unfinishedBody: 'Return to the server page and try signing in again.',
    openServers: 'Open MCP servers',
  },
};

const ca: McpSignInTranslation = {
  title: 'Inici de sessió',
  notConnectedTitle: ({ name }) => `Inicia la sessió a ${name}`,
  notConnectedBody: ({ name }) =>
    `${name} et demana que aprovis l’accés una sola vegada. Després funciona a totes les màquines i a totes les sessions.`,
  signIn: 'Inicia la sessió',
  signingTitle: 'Continua al navegador',
  signingBody: ({ name }) =>
    `Aprova Happier a ${name}. Aquesta pàgina s’actualitza sola.`,
  waiting: ({ name }) => `Esperant ${name}…`,
  cancel: 'Cancel·la',
  notSignedInHere: ({ name }) => `No has iniciat la sessió a ${name} aquí?`,
  usePhone: 'Fes servir el mòbil',
  or: 'o',
  copyLink: 'copia l’enllaç',
  linkCopied: 'Enllaç copiat',
  phoneTitle: 'Escaneja amb el mòbil',
  phoneBody: 'Aprova-ho al mòbil. Aquesta pàgina acaba l’inici de sessió.',
  phoneWaiting: 'Esperant…',
  timeLeft: ({ time }) => `${time} restants`,
  useThisDevice: 'Fes servir aquest dispositiu',
  pasteTitle: 'Tens un codi?',
  pasteBody:
    'Si el navegador t’ha mostrat un codi o una adreça de pàgina, enganxa’l aquí.',
  finishingTitle: ({ machine }) => `Acabant l’inici de sessió a ${machine}`,
  finishingBody: ({ name, machine }) =>
    `Aprovat a ${name}. ${machine} el completa per al teu compte; totes les màquines el podran fer servir en un moment.`,
  connectedAs: ({ identity }) => `Connectat com a ${identity}`,
  connected: 'Connectat',
  connectedBody: 'Funciona a totes les màquines.',
  connectedSince: ({ date }) =>
    `Funciona a totes les màquines · sessió iniciada ${date}`,
  signOut: 'Tanca la sessió',
  signOutTitle: ({ name }) => `Vols tancar la sessió de ${name}?`,
  signOutBody: ({ name }) =>
    `Les sessions s’iniciaran sense les eines de ${name} fins que tornis a iniciar la sessió. La configuració es conserva.`,
  signOutFailed:
    'No s’ha pogut tancar la sessió. Torna-ho a provar quan hi hagi una màquina en línia.',
  moreAccessChip: 'Cal més accés',
  moreAccessBody: ({ name }) =>
    `Una eina ha demanat a ${name} un accés que no has concedit. Aprova’l una vegada i la crida podrà executar-se.`,
  grantAccess: 'Concedeix l’accés',
  expiredChip: 'Inici de sessió caducat',
  expiredBody: ({ name }) =>
    `${name} ha deixat d’acceptar-lo. Les sessions s’iniciaran sense les seves eines fins que et tornis a connectar.`,
  addressChangedChip: 'Adreça canviada',
  addressChangedBody:
    'L’adreça del servidor ha canviat des que vas iniciar la sessió. Torna a iniciar-la per fer-lo servir.',
  reconnect: 'Torna a connectar',
  revokedChip: 'Accés revocat',
  revokedBody: ({ name }) =>
    `L’accés s’ha retirat a la configuració de ${name}. La configuració es conserva.`,
  signInAgain: 'Torna a iniciar la sessió',
  didNotFinishTitle: ({ name }) => `${name} no ha acabat l’inici de sessió`,
  didNotFinishBody:
    'L’inici de sessió no s’ha completat. Torna-ho a provar quan vulguis.',
  tryAgain: 'Torna-ho a provar',
  noMachineTitle: 'L’inici de sessió necessita una màquina en línia',
  noMachineBody:
    'Una màquina t’acaba l’inici de sessió. Cap de les teves és en línia ara mateix.',
  clientRefusedTitle: ({ name }) =>
    `${name} no deixa que Happier iniciï la sessió`,
  clientRefusedBody:
    'No permet que les aplicacions es registrin per iniciar sessió. Fes servir una clau d’API si n’ofereix.',
  useApiKey: 'Fes servir una clau d’API',
  useOwnApp: 'Fes servir la teva aplicació OAuth',
  ownAppBody: 'Crea una aplicació OAuth a la consola del servei amb aquest URL de retorn i introdueix-ne les dades. Happier les desa amb la sessió del teu compte.',
  callbackUrl: 'URL de retorn',
  clientId: 'ID del client',
  clientSecret: 'Secret del client (opcional)',
  editOwnApp: 'Edita la teva aplicació OAuth',
  removeOwnApp: 'Elimina l’aplicació i torna a provar l’inici automàtic',
  invalidClientTitle: 'S’ha rebutjat l’aplicació OAuth',
  invalidClientBody: 'Comprova l’ID del client, el secret i l’URL de retorn registrat, i torna a iniciar sessió.',
  ownAppNotNeeded: 'Aquest servei accepta la identitat de Happier. No cal la teva aplicació OAuth.',
  reviewSetApp: 'Estableix o substitueix l’aplicació OAuth',
  reviewRemoveApp: 'Elimina l’aplicació OAuth',
  callback: {
    finishing: 'Acabant l’inici de sessió…',
    closeTitle: 'Sessió iniciada',
    closeBody: 'Pots tancar aquesta pestanya i tornar a Happier.',
    connectedTitle: 'Sessió iniciada',
    connectedBody: 'Tornant al servidor…',
    pasteTitle: 'Copia aquest codi a Happier',
    pasteBody:
      'Enganxa’l a la pàgina del servidor des d’on has començat a iniciar la sessió. Només hi funciona, i una sola vegada.',
    copyCode: 'Copia el codi',
    copied: 'Copiat',
    invalidTitle: 'Aquest enllaç d’inici de sessió no és complet',
    invalidBody: 'Torna a començar l’inici de sessió des de la pàgina del servidor.',
    unfinishedTitle: 'L’inici de sessió no s’ha acabat',
    unfinishedBody: 'Torna a la pàgina del servidor i prova d’iniciar sessió de nou.',
    openServers: 'Obre els servidors MCP',
  },
};

const de: McpSignInTranslation = {
  title: 'Anmeldung',
  notConnectedTitle: ({ name }) => `Bei ${name} anmelden`,
  notConnectedBody: ({ name }) =>
    `${name} bittet dich, den Zugriff einmalig zu genehmigen. Danach funktioniert er auf jeder Maschine und in jeder Sitzung.`,
  signIn: 'Anmelden',
  signingTitle: 'Weiter in deinem Browser',
  signingBody: ({ name }) =>
    `Genehmige Happier in ${name}. Diese Seite aktualisiert sich von selbst.`,
  waiting: ({ name }) => `Warten auf ${name}…`,
  cancel: 'Abbrechen',
  notSignedInHere: ({ name }) => `Hier nicht bei ${name} angemeldet?`,
  usePhone: 'Handy verwenden',
  or: 'oder',
  copyLink: 'Link kopieren',
  linkCopied: 'Link kopiert',
  phoneTitle: 'Mit dem Handy scannen',
  phoneBody:
    'Genehmige auf deinem Handy. Diese Seite schließt die Anmeldung ab.',
  phoneWaiting: 'Warten…',
  timeLeft: ({ time }) => `noch ${time}`,
  useThisDevice: 'Dieses Gerät verwenden',
  pasteTitle: 'Stattdessen einen Code?',
  pasteBody:
    'Wenn der Browser einen Code oder eine Seitenadresse angezeigt hat, füge sie hier ein.',
  finishingTitle: ({ machine }) =>
    `Anmeldung auf ${machine} wird abgeschlossen`,
  finishingBody: ({ name, machine }) =>
    `In ${name} genehmigt. ${machine} schließt die Anmeldung für deinen Account ab; gleich kann jede Maschine sie nutzen.`,
  connectedAs: ({ identity }) => `Verbunden als ${identity}`,
  connected: 'Verbunden',
  connectedBody: 'Funktioniert auf jeder Maschine.',
  connectedSince: ({ date }) =>
    `Funktioniert auf jeder Maschine · angemeldet ${date}`,
  signOut: 'Abmelden',
  signOutTitle: ({ name }) => `Von ${name} abmelden?`,
  signOutBody: ({ name }) =>
    `Sitzungen starten ohne die Tools von ${name}, bis du dich wieder anmeldest. Deine Einrichtung bleibt erhalten.`,
  signOutFailed:
    'Abmelden nicht möglich. Versuche es erneut, wenn eine Maschine online ist.',
  moreAccessChip: 'Braucht mehr Zugriff',
  moreAccessBody: ({ name }) =>
    `Ein Tool hat bei ${name} Zugriff angefragt, den du nicht erteilt hast. Genehmige ihn einmal, dann kann der Aufruf laufen.`,
  grantAccess: 'Zugriff erteilen',
  expiredChip: 'Anmeldung abgelaufen',
  expiredBody: ({ name }) =>
    `${name} akzeptiert sie nicht mehr. Sitzungen starten ohne die Tools, bis du dich neu verbindest.`,
  addressChangedChip: 'Adresse geändert',
  addressChangedBody:
    'Die Adresse des Servers hat sich seit deiner Anmeldung geändert. Melde dich erneut an, um ihn zu nutzen.',
  reconnect: 'Neu verbinden',
  revokedChip: 'Zugriff widerrufen',
  revokedBody: ({ name }) =>
    `Der Zugriff wurde in den Einstellungen von ${name} entfernt. Deine Einrichtung bleibt erhalten.`,
  signInAgain: 'Erneut anmelden',
  didNotFinishTitle: ({ name }) =>
    `${name} hat die Anmeldung nicht abgeschlossen`,
  didNotFinishBody:
    'Die Anmeldung ist nicht abgeschlossen. Versuche es erneut, wenn du bereit bist.',
  tryAgain: 'Erneut versuchen',
  noMachineTitle: 'Für die Anmeldung muss eine Maschine online sein',
  noMachineBody:
    'Eine Maschine schließt die Anmeldung für dich ab. Keine deiner Maschinen ist gerade online.',
  clientRefusedTitle: ({ name }) => `${name} erlaubt Happier keine Anmeldung`,
  clientRefusedBody:
    'Apps dürfen sich dort nicht für die Anmeldung registrieren. Nutze einen API-Schlüssel, falls angeboten.',
  useApiKey: 'API-Schlüssel verwenden',
  useOwnApp: 'Eigene OAuth-App verwenden',
  ownAppBody: 'Erstelle in der Konsole des Dienstes eine OAuth-App mit dieser Rückruf-URL und gib ihre Daten ein. Happier speichert sie mit deiner Kontoanmeldung.',
  callbackUrl: 'Rückruf-URL',
  clientId: 'Client-ID',
  clientSecret: 'Client-Geheimnis (optional)',
  editOwnApp: 'OAuth-App bearbeiten',
  removeOwnApp: 'App entfernen und automatische Anmeldung erneut versuchen',
  invalidClientTitle: 'Die OAuth-App wurde abgelehnt',
  invalidClientBody: 'Prüfe Client-ID, Geheimnis und registrierte Rückruf-URL und melde dich erneut an.',
  ownAppNotNeeded: 'Dieser Dienst akzeptiert Happiers App-Identität. Deine eigene OAuth-App wird nicht benötigt.',
  reviewSetApp: 'OAuth-App festlegen oder ersetzen',
  reviewRemoveApp: 'OAuth-App entfernen',
  callback: {
    finishing: 'Anmeldung wird abgeschlossen…',
    closeTitle: 'Angemeldet',
    closeBody: 'Du kannst diesen Tab schließen und zu Happier zurückkehren.',
    connectedTitle: 'Angemeldet',
    connectedBody: 'Du wirst zum Server zurückgebracht…',
    pasteTitle: 'Kopiere diesen Code in Happier',
    pasteBody:
      'Füge ihn auf der Serverseite ein, auf der du die Anmeldung gestartet hast. Er funktioniert nur dort und nur einmal.',
    copyCode: 'Code kopieren',
    copied: 'Kopiert',
    invalidTitle: 'Dieser Anmeldelink ist unvollständig',
    invalidBody: 'Starte die Anmeldung erneut von der Serverseite aus.',
    unfinishedTitle: 'Die Anmeldung wurde nicht abgeschlossen',
    unfinishedBody:
      'Kehre zur Serverseite zurück und versuche die Anmeldung erneut.',
    openServers: 'MCP-Server öffnen',
  },
};

const es: McpSignInTranslation = {
  title: 'Inicio de sesión',
  notConnectedTitle: ({ name }) => `Inicia sesión en ${name}`,
  notConnectedBody: ({ name }) =>
    `${name} te pide aprobar el acceso una sola vez. Después funciona en todas las máquinas y en todas las sesiones.`,
  signIn: 'Iniciar sesión',
  signingTitle: 'Continúa en tu navegador',
  signingBody: ({ name }) =>
    `Aprueba Happier en ${name}. Esta página se actualiza sola.`,
  waiting: ({ name }) => `Esperando a ${name}…`,
  cancel: 'Cancelar',
  notSignedInHere: ({ name }) => `¿No has iniciado sesión en ${name} aquí?`,
  usePhone: 'Usa tu teléfono',
  or: 'o',
  copyLink: 'copia el enlace',
  linkCopied: 'Enlace copiado',
  phoneTitle: 'Escanea con tu teléfono',
  phoneBody: 'Aprueba en tu teléfono. Esta página termina el inicio de sesión.',
  phoneWaiting: 'Esperando…',
  timeLeft: ({ time }) => `quedan ${time}`,
  useThisDevice: 'Usar este dispositivo',
  pasteTitle: '¿Tienes un código?',
  pasteBody:
    'Si el navegador mostró un código o la dirección de una página, pégalo aquí.',
  finishingTitle: ({ machine }) => `Terminando el inicio de sesión en ${machine}`,
  finishingBody: ({ name, machine }) =>
    `Aprobado en ${name}. ${machine} lo completa para tu cuenta; en un momento todas las máquinas podrán usarlo.`,
  connectedAs: ({ identity }) => `Conectado como ${identity}`,
  connected: 'Conectado',
  connectedBody: 'Funciona en todas las máquinas.',
  connectedSince: ({ date }) =>
    `Funciona en todas las máquinas · sesión iniciada ${date}`,
  signOut: 'Cerrar sesión',
  signOutTitle: ({ name }) => `¿Cerrar sesión en ${name}?`,
  signOutBody: ({ name }) =>
    `Las sesiones empezarán sin las herramientas de ${name} hasta que vuelvas a iniciar sesión. Tu configuración se conserva.`,
  signOutFailed:
    'No se pudo cerrar sesión. Inténtalo de nuevo cuando haya una máquina en línea.',
  moreAccessChip: 'Necesita más acceso',
  moreAccessBody: ({ name }) =>
    `Una herramienta pidió a ${name} un acceso que no has concedido. Apruébalo una vez y la llamada podrá ejecutarse.`,
  grantAccess: 'Conceder acceso',
  expiredChip: 'Inicio de sesión caducado',
  expiredBody: ({ name }) =>
    `${name} dejó de aceptarlo. Las sesiones empiezan sin sus herramientas hasta que te vuelvas a conectar.`,
  addressChangedChip: 'Dirección cambiada',
  addressChangedBody:
    'La dirección del servidor cambió desde que iniciaste sesión. Inicia sesión de nuevo para usarlo.',
  reconnect: 'Volver a conectar',
  revokedChip: 'Acceso revocado',
  revokedBody: ({ name }) =>
    `El acceso se quitó en los ajustes de ${name}. Tu configuración se conserva.`,
  signInAgain: 'Iniciar sesión de nuevo',
  didNotFinishTitle: ({ name }) => `${name} no terminó el inicio de sesión`,
  didNotFinishBody:
    'El inicio de sesión no se ha completado. Vuelve a intentarlo cuando quieras.',
  tryAgain: 'Reintentar',
  noMachineTitle: 'El inicio de sesión necesita una máquina en línea',
  noMachineBody:
    'Una máquina termina el inicio de sesión por ti. Ninguna de las tuyas está en línea ahora mismo.',
  clientRefusedTitle: ({ name }) =>
    `${name} no deja que Happier inicie sesión`,
  clientRefusedBody:
    'No permite que las aplicaciones se registren para iniciar sesión. Usa una clave de API si la ofrece.',
  useApiKey: 'Usar una clave de API',
  useOwnApp: 'Usar tu propia aplicación OAuth',
  ownAppBody: 'Crea una aplicación OAuth en la consola del servicio con esta URL de retorno e introduce sus datos. Happier los guarda con el inicio de sesión de tu cuenta.',
  callbackUrl: 'URL de retorno',
  clientId: 'ID de cliente',
  clientSecret: 'Secreto de cliente (opcional)',
  editOwnApp: 'Editar tu aplicación OAuth',
  removeOwnApp: 'Eliminar aplicación y reintentar el acceso automático',
  invalidClientTitle: 'Se ha rechazado la aplicación OAuth',
  invalidClientBody: 'Comprueba el ID, el secreto y la URL de retorno registrada, y vuelve a iniciar sesión.',
  ownAppNotNeeded: 'Este servicio acepta la identidad de Happier. No necesitas tu propia aplicación OAuth.',
  reviewSetApp: 'Establecer o reemplazar la aplicación OAuth',
  reviewRemoveApp: 'Eliminar la aplicación OAuth',
  callback: {
    finishing: 'Terminando el inicio de sesión…',
    closeTitle: 'Sesión iniciada',
    closeBody: 'Puedes cerrar esta pestaña y volver a Happier.',
    connectedTitle: 'Sesión iniciada',
    connectedBody: 'Volviendo al servidor…',
    pasteTitle: 'Copia este código en Happier',
    pasteBody:
      'Pégalo en la página del servidor donde empezaste a iniciar sesión. Solo funciona allí, y una vez.',
    copyCode: 'Copiar código',
    copied: 'Copiado',
    invalidTitle: 'Este enlace de inicio de sesión no está completo',
    invalidBody: 'Vuelve a empezar el inicio de sesión desde la página del servidor.',
    unfinishedTitle: 'El inicio de sesión no terminó',
    unfinishedBody: 'Vuelve a la página del servidor e intenta iniciar sesión de nuevo.',
    openServers: 'Abrir servidores MCP',
  },
};

const fr: McpSignInTranslation = {
  title: 'Connexion',
  notConnectedTitle: ({ name }) => `Se connecter à ${name}`,
  notConnectedBody: ({ name }) =>
    `${name} vous demande d’approuver l’accès une seule fois. Il fonctionne ensuite sur toutes les machines et dans toutes les sessions.`,
  signIn: 'Se connecter',
  signingTitle: 'Continuez dans votre navigateur',
  signingBody: ({ name }) =>
    `Approuvez Happier dans ${name}. Cette page se met à jour toute seule.`,
  waiting: ({ name }) => `En attente de ${name}…`,
  cancel: 'Annuler',
  notSignedInHere: ({ name }) => `Pas connecté à ${name} ici ?`,
  usePhone: 'Utiliser votre téléphone',
  or: 'ou',
  copyLink: 'copier le lien',
  linkCopied: 'Lien copié',
  phoneTitle: 'Scannez avec votre téléphone',
  phoneBody:
    'Approuvez sur votre téléphone. Cette page termine la connexion.',
  phoneWaiting: 'En attente…',
  timeLeft: ({ time }) => `${time} restantes`,
  useThisDevice: 'Utiliser cet appareil',
  pasteTitle: 'Vous avez un code ?',
  pasteBody:
    'Si le navigateur a affiché un code ou l’adresse d’une page, collez-le ici.',
  finishingTitle: ({ machine }) => `Finalisation de la connexion sur ${machine}`,
  finishingBody: ({ name, machine }) =>
    `Approuvé dans ${name}. ${machine} la finalise pour votre compte ; toutes les machines pourront l’utiliser dans un instant.`,
  connectedAs: ({ identity }) => `Connecté en tant que ${identity}`,
  connected: 'Connecté',
  connectedBody: 'Fonctionne sur toutes les machines.',
  connectedSince: ({ date }) =>
    `Fonctionne sur toutes les machines · connecté ${date}`,
  signOut: 'Se déconnecter',
  signOutTitle: ({ name }) => `Se déconnecter de ${name} ?`,
  signOutBody: ({ name }) =>
    `Les sessions démarreront sans les outils de ${name} tant que vous ne vous reconnectez pas. Votre configuration est conservée.`,
  signOutFailed:
    'Déconnexion impossible. Réessayez quand une machine sera en ligne.',
  moreAccessChip: 'Accès supplémentaire requis',
  moreAccessBody: ({ name }) =>
    `Un outil a demandé à ${name} un accès que vous n’avez pas accordé. Approuvez-le une fois et l’appel pourra s’exécuter.`,
  grantAccess: 'Accorder l’accès',
  expiredChip: 'Connexion expirée',
  expiredBody: ({ name }) =>
    `${name} ne l’accepte plus. Les sessions démarrent sans ses outils tant que vous ne vous reconnectez pas.`,
  addressChangedChip: 'Adresse modifiée',
  addressChangedBody:
    'L’adresse du serveur a changé depuis votre connexion. Reconnectez-vous pour l’utiliser.',
  reconnect: 'Se reconnecter',
  revokedChip: 'Accès révoqué',
  revokedBody: ({ name }) =>
    `L’accès a été retiré dans les paramètres de ${name}. Votre configuration est conservée.`,
  signInAgain: 'Se connecter à nouveau',
  didNotFinishTitle: ({ name }) => `${name} n’a pas terminé la connexion`,
  didNotFinishBody:
    'La connexion n’est pas terminée. Réessayez quand vous le souhaitez.',
  tryAgain: 'Réessayer',
  noMachineTitle: 'La connexion nécessite une machine en ligne',
  noMachineBody:
    'Une machine termine la connexion pour vous. Aucune des vôtres n’est en ligne pour le moment.',
  clientRefusedTitle: ({ name }) =>
    `${name} n’autorise pas la connexion de Happier`,
  clientRefusedBody:
    'Il n’autorise pas les applications à s’enregistrer pour la connexion. Utilisez une clé API s’il en propose une.',
  useApiKey: 'Utiliser une clé API',
  useOwnApp: 'Utiliser votre application OAuth',
  ownAppBody: 'Créez une application OAuth dans la console du service avec cette URL de retour, puis saisissez ses informations. Happier les enregistre avec la connexion de votre compte.',
  callbackUrl: 'URL de retour',
  clientId: 'ID client',
  clientSecret: 'Secret client (facultatif)',
  editOwnApp: 'Modifier votre application OAuth',
  removeOwnApp: 'Retirer l’application et réessayer la connexion automatique',
  invalidClientTitle: 'L’application OAuth a été refusée',
  invalidClientBody: 'Vérifiez l’ID client, le secret et l’URL de retour enregistrée, puis reconnectez-vous.',
  ownAppNotNeeded: 'Ce service accepte l’identité de Happier. Votre application OAuth n’est pas nécessaire.',
  reviewSetApp: 'Définir ou remplacer l’application OAuth',
  reviewRemoveApp: 'Supprimer l’application OAuth',
  callback: {
    finishing: 'Finalisation de la connexion…',
    closeTitle: 'Connecté',
    closeBody: 'Vous pouvez fermer cet onglet et revenir à Happier.',
    connectedTitle: 'Connecté',
    connectedBody: 'Retour au serveur…',
    pasteTitle: 'Copiez ce code dans Happier',
    pasteBody:
      'Collez-le sur la page du serveur où vous avez commencé la connexion. Il ne fonctionne que là, et une seule fois.',
    copyCode: 'Copier le code',
    copied: 'Copié',
    invalidTitle: 'Ce lien de connexion est incomplet',
    invalidBody: 'Relancez la connexion depuis la page du serveur.',
    unfinishedTitle: 'La connexion n’a pas abouti',
    unfinishedBody: 'Revenez à la page du serveur et réessayez de vous connecter.',
    openServers: 'Ouvrir les serveurs MCP',
  },
};

const it: McpSignInTranslation = {
  title: 'Accesso',
  notConnectedTitle: ({ name }) => `Accedi a ${name}`,
  notConnectedBody: ({ name }) =>
    `${name} ti chiede di approvare l’accesso una sola volta. Poi funziona su ogni macchina e in ogni sessione.`,
  signIn: 'Accedi',
  signingTitle: 'Continua nel browser',
  signingBody: ({ name }) =>
    `Approva Happier in ${name}. Questa pagina si aggiorna da sola.`,
  waiting: ({ name }) => `In attesa di ${name}…`,
  cancel: 'Annulla',
  notSignedInHere: ({ name }) => `Non hai effettuato l’accesso a ${name} qui?`,
  usePhone: 'Usa il telefono',
  or: 'oppure',
  copyLink: 'copia il link',
  linkCopied: 'Link copiato',
  phoneTitle: 'Inquadra con il telefono',
  phoneBody: 'Approva dal telefono. Questa pagina completa l’accesso.',
  phoneWaiting: 'In attesa…',
  timeLeft: ({ time }) => `${time} rimasti`,
  useThisDevice: 'Usa questo dispositivo',
  pasteTitle: 'Hai un codice?',
  pasteBody:
    'Se il browser ha mostrato un codice o l’indirizzo di una pagina, incollalo qui.',
  finishingTitle: ({ machine }) => `Completamento dell’accesso su ${machine}`,
  finishingBody: ({ name, machine }) =>
    `Approvato in ${name}. ${machine} lo completa per il tuo account; tra un attimo ogni macchina potrà usarlo.`,
  connectedAs: ({ identity }) => `Connesso come ${identity}`,
  connected: 'Connesso',
  connectedBody: 'Funziona su ogni macchina.',
  connectedSince: ({ date }) =>
    `Funziona su ogni macchina · accesso effettuato ${date}`,
  signOut: 'Esci',
  signOutTitle: ({ name }) => `Uscire da ${name}?`,
  signOutBody: ({ name }) =>
    `Le sessioni partiranno senza gli strumenti di ${name} finché non accedi di nuovo. La configurazione viene conservata.`,
  signOutFailed:
    'Impossibile uscire. Riprova quando una macchina è online.',
  moreAccessChip: 'Serve più accesso',
  moreAccessBody: ({ name }) =>
    `Uno strumento ha chiesto a ${name} un accesso che non hai concesso. Approvalo una volta e la chiamata potrà essere eseguita.`,
  grantAccess: 'Concedi accesso',
  expiredChip: 'Accesso scaduto',
  expiredBody: ({ name }) =>
    `${name} non lo accetta più. Le sessioni partono senza i suoi strumenti finché non ti riconnetti.`,
  addressChangedChip: 'Indirizzo cambiato',
  addressChangedBody:
    'L’indirizzo del server è cambiato da quando hai effettuato l’accesso. Accedi di nuovo per usarlo.',
  reconnect: 'Riconnetti',
  revokedChip: 'Accesso revocato',
  revokedBody: ({ name }) =>
    `L’accesso è stato rimosso nelle impostazioni di ${name}. La configurazione viene conservata.`,
  signInAgain: 'Accedi di nuovo',
  didNotFinishTitle: ({ name }) => `${name} non ha completato l’accesso`,
  didNotFinishBody:
    'L’accesso non è completo. Riprova quando vuoi.',
  tryAgain: 'Riprova',
  noMachineTitle: 'L’accesso richiede una macchina online',
  noMachineBody:
    'Una macchina completa l’accesso per te. Al momento nessuna delle tue è online.',
  clientRefusedTitle: ({ name }) =>
    `${name} non permette l’accesso a Happier`,
  clientRefusedBody:
    'Non consente alle app di registrarsi per l’accesso. Usa una chiave API se ne offre una.',
  useApiKey: 'Usa una chiave API',
  useOwnApp: 'Usa la tua app OAuth',
  ownAppBody: 'Crea un’app OAuth nella console del servizio con questo URL di ritorno, poi inserisci i dati. Happier li salva con l’accesso del tuo account.',
  callbackUrl: 'URL di ritorno',
  clientId: 'ID client',
  clientSecret: 'Segreto client (facoltativo)',
  editOwnApp: 'Modifica la tua app OAuth',
  removeOwnApp: 'Rimuovi l’app e riprova l’accesso automatico',
  invalidClientTitle: 'L’app OAuth è stata rifiutata',
  invalidClientBody: 'Controlla ID client, segreto e URL di ritorno registrato, poi accedi di nuovo.',
  ownAppNotNeeded: 'Questo servizio accetta l’identità di Happier. La tua app OAuth non è necessaria.',
  reviewSetApp: 'Imposta o sostituisci l’app OAuth',
  reviewRemoveApp: 'Rimuovi l’app OAuth',
  callback: {
    finishing: 'Completamento dell’accesso…',
    closeTitle: 'Accesso effettuato',
    closeBody: 'Puoi chiudere questa scheda e tornare a Happier.',
    connectedTitle: 'Accesso effettuato',
    connectedBody: 'Ti riportiamo al server…',
    pasteTitle: 'Copia questo codice in Happier',
    pasteBody:
      'Incollalo nella pagina del server da cui hai iniziato l’accesso. Funziona solo lì, una volta.',
    copyCode: 'Copia codice',
    copied: 'Copiato',
    invalidTitle: 'Questo link di accesso non è completo',
    invalidBody: 'Riavvia l’accesso dalla pagina del server.',
    unfinishedTitle: 'L’accesso non è stato completato',
    unfinishedBody: 'Torna alla pagina del server e prova ad accedere di nuovo.',
    openServers: 'Apri i server MCP',
  },
};

const ja: McpSignInTranslation = {
  title: 'サインイン',
  notConnectedTitle: ({ name }) => `${name} にサインイン`,
  notConnectedBody: ({ name }) =>
    `${name} へのアクセスを一度承認してください。以降はすべてのマシンとすべてのセッションで使えます。`,
  signIn: 'サインイン',
  signingTitle: 'ブラウザで続行してください',
  signingBody: ({ name }) =>
    `${name} で Happier を承認してください。このページは自動で更新されます。`,
  waiting: ({ name }) => `${name} を待っています…`,
  cancel: 'キャンセル',
  notSignedInHere: ({ name }) => `ここでは ${name} にサインインしていませんか？`,
  usePhone: 'スマートフォンを使う',
  or: 'または',
  copyLink: 'リンクをコピー',
  linkCopied: 'リンクをコピーしました',
  phoneTitle: 'スマートフォンでスキャン',
  phoneBody: 'スマートフォンで承認してください。このページでサインインが完了します。',
  phoneWaiting: '待機中…',
  timeLeft: ({ time }) => `残り ${time}`,
  useThisDevice: 'このデバイスを使う',
  pasteTitle: 'コードをお持ちですか？',
  pasteBody:
    'ブラウザにコードまたはページのアドレスが表示された場合は、ここに貼り付けてください。',
  finishingTitle: ({ machine }) => `${machine} でサインインを完了しています`,
  finishingBody: ({ name, machine }) =>
    `${name} で承認されました。${machine} がアカウント用に完了します。まもなくすべてのマシンで使えます。`,
  connectedAs: ({ identity }) => `${identity} として接続中`,
  connected: '接続済み',
  connectedBody: 'すべてのマシンで使えます。',
  connectedSince: ({ date }) => `すべてのマシンで使えます · ${date} にサインイン`,
  signOut: 'サインアウト',
  signOutTitle: ({ name }) => `${name} からサインアウトしますか？`,
  signOutBody: ({ name }) =>
    `再度サインインするまで、セッションは ${name} のツールなしで開始されます。設定は保持されます。`,
  signOutFailed:
    'サインアウトできませんでした。マシンがオンラインのときにもう一度お試しください。',
  moreAccessChip: '追加のアクセスが必要',
  moreAccessBody: ({ name }) =>
    `ツールが、許可していないアクセスを ${name} に要求しました。一度承認すると、呼び出しを実行できます。`,
  grantAccess: 'アクセスを許可',
  expiredChip: 'サインインの期限切れ',
  expiredBody: ({ name }) =>
    `${name} がサインインを受け付けなくなりました。再接続するまで、セッションはそのツールなしで開始されます。`,
  addressChangedChip: 'アドレスが変更されました',
  addressChangedBody:
    'サインイン後にサーバーのアドレスが変更されました。使うには再度サインインしてください。',
  reconnect: '再接続',
  revokedChip: 'アクセスが取り消されました',
  revokedBody: ({ name }) =>
    `${name} の設定でアクセスが削除されました。設定は保持されます。`,
  signInAgain: '再度サインイン',
  didNotFinishTitle: ({ name }) => `${name} のサインインが完了しませんでした`,
  didNotFinishBody:
    'サインインは完了していません。準備ができたら再試行してください。',
  tryAgain: '再試行',
  noMachineTitle: 'サインインにはオンラインのマシンが必要です',
  noMachineBody:
    'サインインはマシンが完了します。現在、オンラインのマシンがありません。',
  clientRefusedTitle: ({ name }) => `${name} は Happier のサインインを許可していません`,
  clientRefusedBody:
    'アプリのサインイン登録を許可していません。API キーが提供されている場合はそちらを使ってください。',
  useApiKey: 'API キーを使う',
  useOwnApp: '自分の OAuth アプリを使う',
  ownAppBody: 'サービスの管理画面でこのコールバック URL を使って OAuth アプリを作成し、詳細を入力してください。Happier はアカウントのサインイン情報と一緒に保存します。',
  callbackUrl: 'コールバック URL',
  clientId: 'クライアント ID',
  clientSecret: 'クライアントシークレット（任意）',
  editOwnApp: 'OAuth アプリを編集',
  removeOwnApp: 'アプリを削除して自動サインインを再試行',
  invalidClientTitle: 'OAuth アプリが拒否されました',
  invalidClientBody: 'クライアント ID、シークレット、登録したコールバック URL を確認して、再度サインインしてください。',
  ownAppNotNeeded: 'このサービスは Happier のアプリ ID に対応しています。独自の OAuth アプリは不要です。',
  reviewSetApp: 'OAuth アプリを設定または置換',
  reviewRemoveApp: 'OAuth アプリを削除',
  callback: {
    finishing: 'サインインを完了しています…',
    closeTitle: 'サインインしました',
    closeBody: 'このタブを閉じて Happier に戻れます。',
    connectedTitle: 'サインインしました',
    connectedBody: 'サーバーに戻ります…',
    pasteTitle: 'このコードを Happier にコピー',
    pasteBody:
      'サインインを開始したサーバーページに貼り付けてください。そこでのみ、一度だけ使えます。',
    copyCode: 'コードをコピー',
    copied: 'コピーしました',
    invalidTitle: 'このサインインリンクは不完全です',
    invalidBody: 'サーバーページからサインインをやり直してください。',
    unfinishedTitle: 'サインインが完了しませんでした',
    unfinishedBody: 'サーバーページに戻って、もう一度サインインしてください。',
    openServers: 'MCP サーバーを開く',
  },
};

const pl: McpSignInTranslation = {
  title: 'Logowanie',
  notConnectedTitle: ({ name }) => `Zaloguj się do ${name}`,
  notConnectedBody: ({ name }) =>
    `${name} prosi o jednorazowe zatwierdzenie dostępu. Potem działa na każdej maszynie i w każdej sesji.`,
  signIn: 'Zaloguj się',
  signingTitle: 'Kontynuuj w przeglądarce',
  signingBody: ({ name }) =>
    `Zatwierdź Happier w ${name}. Ta strona odświeży się sama.`,
  waiting: ({ name }) => `Czekam na ${name}…`,
  cancel: 'Anuluj',
  notSignedInHere: ({ name }) => `Nie jesteś tu zalogowany do ${name}?`,
  usePhone: 'Użyj telefonu',
  or: 'lub',
  copyLink: 'skopiuj link',
  linkCopied: 'Skopiowano link',
  phoneTitle: 'Zeskanuj telefonem',
  phoneBody: 'Zatwierdź na telefonie. Ta strona dokończy logowanie.',
  phoneWaiting: 'Czekam…',
  timeLeft: ({ time }) => `zostało ${time}`,
  useThisDevice: 'Użyj tego urządzenia',
  pasteTitle: 'Masz kod?',
  pasteBody:
    'Jeśli przeglądarka pokazała kod lub adres strony, wklej go tutaj.',
  finishingTitle: ({ machine }) => `Kończenie logowania na ${machine}`,
  finishingBody: ({ name, machine }) =>
    `Zatwierdzono w ${name}. ${machine} dokańcza je dla Twojego konta; za chwilę każda maszyna będzie mogła z niego korzystać.`,
  connectedAs: ({ identity }) => `Połączono jako ${identity}`,
  connected: 'Połączono',
  connectedBody: 'Działa na każdej maszynie.',
  connectedSince: ({ date }) =>
    `Działa na każdej maszynie · zalogowano ${date}`,
  signOut: 'Wyloguj się',
  signOutTitle: ({ name }) => `Wylogować się z ${name}?`,
  signOutBody: ({ name }) =>
    `Sesje będą startować bez narzędzi ${name}, dopóki nie zalogujesz się ponownie. Konfiguracja zostaje.`,
  signOutFailed:
    'Nie udało się wylogować. Spróbuj ponownie, gdy jakaś maszyna będzie online.',
  moreAccessChip: 'Potrzebny dodatkowy dostęp',
  moreAccessBody: ({ name }) =>
    `Narzędzie poprosiło ${name} o dostęp, którego nie przyznano. Zatwierdź go raz, a wywołanie będzie mogło się wykonać.`,
  grantAccess: 'Przyznaj dostęp',
  expiredChip: 'Logowanie wygasło',
  expiredBody: ({ name }) =>
    `${name} przestał je akceptować. Sesje startują bez jego narzędzi, dopóki nie połączysz się ponownie.`,
  addressChangedChip: 'Adres się zmienił',
  addressChangedBody:
    'Adres serwera zmienił się od czasu logowania. Zaloguj się ponownie, aby z niego korzystać.',
  reconnect: 'Połącz ponownie',
  revokedChip: 'Dostęp cofnięty',
  revokedBody: ({ name }) =>
    `Dostęp został usunięty w ustawieniach ${name}. Konfiguracja zostaje.`,
  signInAgain: 'Zaloguj się ponownie',
  didNotFinishTitle: ({ name }) => `${name} nie dokończył logowania`,
  didNotFinishBody:
    'Logowanie nie zostało ukończone. Spróbuj ponownie, gdy będziesz gotowy.',
  tryAgain: 'Spróbuj ponownie',
  noMachineTitle: 'Logowanie wymaga maszyny online',
  noMachineBody:
    'Logowanie kończy maszyna. Żadna z Twoich nie jest teraz online.',
  clientRefusedTitle: ({ name }) => `${name} nie pozwala Happier się zalogować`,
  clientRefusedBody:
    'Nie pozwala aplikacjom rejestrować się do logowania. Użyj klucza API, jeśli jest dostępny.',
  useApiKey: 'Użyj klucza API',
  useOwnApp: 'Użyj własnej aplikacji OAuth',
  ownAppBody: 'Utwórz aplikację OAuth w konsoli usługi z tym adresem zwrotnym, a następnie podaj jej dane. Happier zapisze je z logowaniem do konta.',
  callbackUrl: 'Adres zwrotny',
  clientId: 'Identyfikator klienta',
  clientSecret: 'Sekret klienta (opcjonalnie)',
  editOwnApp: 'Edytuj aplikację OAuth',
  removeOwnApp: 'Usuń aplikację i ponów automatyczne logowanie',
  invalidClientTitle: 'Aplikacja OAuth została odrzucona',
  invalidClientBody: 'Sprawdź identyfikator, sekret i zarejestrowany adres zwrotny, a następnie zaloguj się ponownie.',
  ownAppNotNeeded: 'Ta usługa akceptuje tożsamość Happier. Własna aplikacja OAuth nie jest potrzebna.',
  reviewSetApp: 'Ustaw lub zastąp aplikację OAuth',
  reviewRemoveApp: 'Usuń aplikację OAuth',
  callback: {
    finishing: 'Kończenie logowania…',
    closeTitle: 'Zalogowano',
    closeBody: 'Możesz zamknąć tę kartę i wrócić do Happier.',
    connectedTitle: 'Zalogowano',
    connectedBody: 'Wracam do serwera…',
    pasteTitle: 'Skopiuj ten kod do Happier',
    pasteBody:
      'Wklej go na stronie serwera, na której zaczęto logowanie. Działa tylko tam i tylko raz.',
    copyCode: 'Skopiuj kod',
    copied: 'Skopiowano',
    invalidTitle: 'Ten link logowania jest niekompletny',
    invalidBody: 'Rozpocznij logowanie ponownie ze strony serwera.',
    unfinishedTitle: 'Logowanie nie zostało dokończone',
    unfinishedBody: 'Wróć do strony serwera i spróbuj zalogować się ponownie.',
    openServers: 'Otwórz serwery MCP',
  },
};

const pt: McpSignInTranslation = {
  title: 'Entrada',
  notConnectedTitle: ({ name }) => `Entrar em ${name}`,
  notConnectedBody: ({ name }) =>
    `${name} pede que você aprove o acesso uma única vez. Depois ele funciona em todas as máquinas e em todas as sessões.`,
  signIn: 'Entrar',
  signingTitle: 'Continue no navegador',
  signingBody: ({ name }) =>
    `Aprove o Happier em ${name}. Esta página se atualiza sozinha.`,
  waiting: ({ name }) => `Aguardando ${name}…`,
  cancel: 'Cancelar',
  notSignedInHere: ({ name }) => `Não entrou em ${name} aqui?`,
  usePhone: 'Use o celular',
  or: 'ou',
  copyLink: 'copie o link',
  linkCopied: 'Link copiado',
  phoneTitle: 'Escaneie com o celular',
  phoneBody: 'Aprove no celular. Esta página conclui a entrada.',
  phoneWaiting: 'Aguardando…',
  timeLeft: ({ time }) => `restam ${time}`,
  useThisDevice: 'Usar este dispositivo',
  pasteTitle: 'Tem um código?',
  pasteBody:
    'Se o navegador mostrou um código ou o endereço de uma página, cole aqui.',
  finishingTitle: ({ machine }) => `Concluindo a entrada em ${machine}`,
  finishingBody: ({ name, machine }) =>
    `Aprovado em ${name}. ${machine} está concluindo para a sua conta; em instantes todas as máquinas poderão usar.`,
  connectedAs: ({ identity }) => `Conectado como ${identity}`,
  connected: 'Conectado',
  connectedBody: 'Funciona em todas as máquinas.',
  connectedSince: ({ date }) =>
    `Funciona em todas as máquinas · entrada em ${date}`,
  signOut: 'Sair',
  signOutTitle: ({ name }) => `Sair de ${name}?`,
  signOutBody: ({ name }) =>
    `As sessões começam sem as ferramentas de ${name} até você entrar de novo. Sua configuração é mantida.`,
  signOutFailed:
    'Não foi possível sair. Tente de novo quando uma máquina estiver online.',
  moreAccessChip: 'Precisa de mais acesso',
  moreAccessBody: ({ name }) =>
    `Uma ferramenta pediu a ${name} um acesso que você não concedeu. Aprove uma vez e a chamada poderá ser executada.`,
  grantAccess: 'Conceder acesso',
  expiredChip: 'Entrada expirada',
  expiredBody: ({ name }) =>
    `${name} deixou de aceitá-la. As sessões começam sem as ferramentas dele até você reconectar.`,
  addressChangedChip: 'Endereço alterado',
  addressChangedBody:
    'O endereço do servidor mudou desde que você entrou. Entre de novo para usá-lo.',
  reconnect: 'Reconectar',
  revokedChip: 'Acesso revogado',
  revokedBody: ({ name }) =>
    `O acesso foi removido nas configurações de ${name}. Sua configuração é mantida.`,
  signInAgain: 'Entrar de novo',
  didNotFinishTitle: ({ name }) => `${name} não concluiu a entrada`,
  didNotFinishBody:
    'O acesso não foi concluído. Tente novamente quando quiser.',
  tryAgain: 'Tentar de novo',
  noMachineTitle: 'A entrada precisa de uma máquina online',
  noMachineBody:
    'Uma máquina conclui a entrada para você. Nenhuma das suas está online agora.',
  clientRefusedTitle: ({ name }) =>
    `${name} não deixa o Happier entrar`,
  clientRefusedBody:
    'Ele não permite que apps se registrem para entrar. Use uma chave de API, se houver.',
  useApiKey: 'Usar uma chave de API',
  useOwnApp: 'Usar seu próprio aplicativo OAuth',
  ownAppBody: 'Crie um aplicativo OAuth no console do serviço com esta URL de retorno e insira os dados. O Happier os salva com a conexão da sua conta.',
  callbackUrl: 'URL de retorno',
  clientId: 'ID do cliente',
  clientSecret: 'Segredo do cliente (opcional)',
  editOwnApp: 'Editar seu aplicativo OAuth',
  removeOwnApp: 'Remover aplicativo e tentar o acesso automático novamente',
  invalidClientTitle: 'O aplicativo OAuth foi recusado',
  invalidClientBody: 'Confira o ID, o segredo e a URL de retorno registrada e entre novamente.',
  ownAppNotNeeded: 'Este serviço aceita a identidade do Happier. Seu aplicativo OAuth não é necessário.',
  reviewSetApp: 'Definir ou substituir o aplicativo OAuth',
  reviewRemoveApp: 'Remover o aplicativo OAuth',
  callback: {
    finishing: 'Concluindo a entrada…',
    closeTitle: 'Entrada concluída',
    closeBody: 'Você pode fechar esta aba e voltar ao Happier.',
    connectedTitle: 'Entrada concluída',
    connectedBody: 'Levando você de volta ao servidor…',
    pasteTitle: 'Copie este código no Happier',
    pasteBody:
      'Cole na página do servidor em que você começou a entrada. Ele só funciona lá, uma vez.',
    copyCode: 'Copiar código',
    copied: 'Copiado',
    invalidTitle: 'Este link de entrada está incompleto',
    invalidBody: 'Comece a entrada de novo pela página do servidor.',
    unfinishedTitle: 'A entrada não foi concluída',
    unfinishedBody: 'Volte à página do servidor e tente entrar novamente.',
    openServers: 'Abrir servidores MCP',
  },
};

const ru: McpSignInTranslation = {
  title: 'Вход',
  notConnectedTitle: ({ name }) => `Войдите в ${name}`,
  notConnectedBody: ({ name }) =>
    `${name} просит один раз подтвердить доступ. Потом он работает на всех машинах и во всех сессиях.`,
  signIn: 'Войти',
  signingTitle: 'Продолжите в браузере',
  signingBody: ({ name }) =>
    `Подтвердите Happier в ${name}. Эта страница обновится сама.`,
  waiting: ({ name }) => `Ожидание ${name}…`,
  cancel: 'Отмена',
  notSignedInHere: ({ name }) => `Не вошли в ${name} здесь?`,
  usePhone: 'Использовать телефон',
  or: 'или',
  copyLink: 'скопировать ссылку',
  linkCopied: 'Ссылка скопирована',
  phoneTitle: 'Отсканируйте телефоном',
  phoneBody: 'Подтвердите на телефоне. Эта страница завершит вход.',
  phoneWaiting: 'Ожидание…',
  timeLeft: ({ time }) => `осталось ${time}`,
  useThisDevice: 'Использовать это устройство',
  pasteTitle: 'Есть код?',
  pasteBody:
    'Если браузер показал код или адрес страницы, вставьте его сюда.',
  finishingTitle: ({ machine }) => `Завершение входа на ${machine}`,
  finishingBody: ({ name, machine }) =>
    `Подтверждено в ${name}. ${machine} завершает вход для вашего аккаунта; через мгновение его смогут использовать все машины.`,
  connectedAs: ({ identity }) => `Подключено как ${identity}`,
  connected: 'Подключено',
  connectedBody: 'Работает на всех машинах.',
  connectedSince: ({ date }) => `Работает на всех машинах · вход выполнен ${date}`,
  signOut: 'Выйти',
  signOutTitle: ({ name }) => `Выйти из ${name}?`,
  signOutBody: ({ name }) =>
    `Сессии будут запускаться без инструментов ${name}, пока вы не войдёте снова. Настройки сохранятся.`,
  signOutFailed:
    'Не удалось выйти. Повторите, когда какая-нибудь машина будет в сети.',
  moreAccessChip: 'Нужен дополнительный доступ',
  moreAccessBody: ({ name }) =>
    `Инструмент запросил у ${name} доступ, который вы не предоставили. Подтвердите его один раз, и вызов выполнится.`,
  grantAccess: 'Предоставить доступ',
  expiredChip: 'Вход истёк',
  expiredBody: ({ name }) =>
    `${name} больше его не принимает. Сессии запускаются без его инструментов, пока вы не подключитесь заново.`,
  addressChangedChip: 'Адрес изменился',
  addressChangedBody:
    'Адрес сервера изменился после вашего входа. Войдите снова, чтобы им пользоваться.',
  reconnect: 'Подключиться заново',
  revokedChip: 'Доступ отозван',
  revokedBody: ({ name }) =>
    `Доступ удалён в настройках ${name}. Настройки сохранились.`,
  signInAgain: 'Войти снова',
  didNotFinishTitle: ({ name }) => `${name} не завершил вход`,
  didNotFinishBody:
    'Вход не завершён. Повторите попытку, когда будете готовы.',
  tryAgain: 'Повторить',
  noMachineTitle: 'Для входа нужна машина в сети',
  noMachineBody:
    'Вход завершает машина. Сейчас ни одна из ваших не в сети.',
  clientRefusedTitle: ({ name }) => `${name} не разрешает вход через Happier`,
  clientRefusedBody:
    'Он не позволяет приложениям регистрироваться для входа. Используйте API-ключ, если он есть.',
  useApiKey: 'Использовать API-ключ',
  useOwnApp: 'Использовать своё OAuth-приложение',
  ownAppBody: 'Создайте OAuth-приложение в консоли сервиса с этим адресом возврата и введите его данные. Happier сохранит их вместе со входом в ваш аккаунт.',
  callbackUrl: 'Адрес возврата',
  clientId: 'ID клиента',
  clientSecret: 'Секрет клиента (необязательно)',
  editOwnApp: 'Изменить OAuth-приложение',
  removeOwnApp: 'Удалить приложение и повторить автоматический вход',
  invalidClientTitle: 'OAuth-приложение отклонено',
  invalidClientBody: 'Проверьте ID клиента, секрет и зарегистрированный адрес возврата, затем войдите снова.',
  ownAppNotNeeded: 'Этот сервис принимает идентификатор Happier. Ваше OAuth-приложение не требуется.',
  reviewSetApp: 'Задать или заменить OAuth-приложение',
  reviewRemoveApp: 'Удалить OAuth-приложение',
  callback: {
    finishing: 'Завершение входа…',
    closeTitle: 'Вход выполнен',
    closeBody: 'Можно закрыть эту вкладку и вернуться в Happier.',
    connectedTitle: 'Вход выполнен',
    connectedBody: 'Возвращаем вас на сервер…',
    pasteTitle: 'Скопируйте этот код в Happier',
    pasteBody:
      'Вставьте его на странице сервера, где вы начали вход. Он работает только там и только один раз.',
    copyCode: 'Скопировать код',
    copied: 'Скопировано',
    invalidTitle: 'Эта ссылка для входа неполная',
    invalidBody: 'Начните вход заново со страницы сервера.',
    unfinishedTitle: 'Вход не завершён',
    unfinishedBody: 'Вернитесь на страницу сервера и попробуйте войти снова.',
    openServers: 'Открыть MCP-серверы',
  },
};

const zhHans: McpSignInTranslation = {
  title: '登录',
  notConnectedTitle: ({ name }) => `登录 ${name}`,
  notConnectedBody: ({ name }) =>
    `${name} 需要你批准一次访问。之后在每台机器和每个会话中都可使用。`,
  signIn: '登录',
  signingTitle: '请在浏览器中继续',
  signingBody: ({ name }) => `在 ${name} 中批准 Happier。此页面会自动更新。`,
  waiting: ({ name }) => `正在等待 ${name}…`,
  cancel: '取消',
  notSignedInHere: ({ name }) => `在这里没有登录 ${name}？`,
  usePhone: '使用手机',
  or: '或',
  copyLink: '复制链接',
  linkCopied: '链接已复制',
  phoneTitle: '用手机扫描',
  phoneBody: '在手机上批准。此页面将完成登录。',
  phoneWaiting: '等待中…',
  timeLeft: ({ time }) => `剩余 ${time}`,
  useThisDevice: '使用此设备',
  pasteTitle: '有验证码吗？',
  pasteBody: '如果浏览器显示了验证码或页面地址，请粘贴到这里。',
  finishingTitle: ({ machine }) => `正在 ${machine} 上完成登录`,
  finishingBody: ({ name, machine }) =>
    `已在 ${name} 中批准。${machine} 正在为你的账号完成登录；稍后每台机器都可使用。`,
  connectedAs: ({ identity }) => `已以 ${identity} 身份连接`,
  connected: '已连接',
  connectedBody: '在每台机器上都可使用。',
  connectedSince: ({ date }) => `在每台机器上都可使用 · ${date} 登录`,
  signOut: '退出登录',
  signOutTitle: ({ name }) => `退出 ${name}？`,
  signOutBody: ({ name }) =>
    `再次登录之前，会话启动时将没有 ${name} 的工具。你的设置会保留。`,
  signOutFailed: '无法退出登录。请在有机器在线时重试。',
  moreAccessChip: '需要更多访问权限',
  moreAccessBody: ({ name }) =>
    `某个工具向 ${name} 请求了你尚未授予的访问权限。批准一次后，该调用即可运行。`,
  grantAccess: '授予访问权限',
  expiredChip: '登录已过期',
  expiredBody: ({ name }) =>
    `${name} 已不再接受该登录。重新连接之前，会话启动时将没有它的工具。`,
  addressChangedChip: '地址已更改',
  addressChangedBody: '自你登录后，服务器地址已更改。请重新登录以继续使用。',
  reconnect: '重新连接',
  revokedChip: '访问权限已撤销',
  revokedBody: ({ name }) => `访问权限已在 ${name} 的设置中移除。你的设置会保留。`,
  signInAgain: '重新登录',
  didNotFinishTitle: ({ name }) => `${name} 未完成登录`,
  didNotFinishBody: '登录尚未完成。准备好后请重试。',
  tryAgain: '重试',
  noMachineTitle: '登录需要一台在线的机器',
  noMachineBody: '登录由机器为你完成。你的机器目前都不在线。',
  clientRefusedTitle: ({ name }) => `${name} 不允许 Happier 登录`,
  clientRefusedBody: '它不允许应用注册登录。如果提供 API 密钥，请改用 API 密钥。',
  useApiKey: '使用 API 密钥',
  useOwnApp: '使用自己的 OAuth 应用',
  ownAppBody: '在服务控制台中使用此回调网址创建 OAuth 应用，然后填写其信息。Happier 会将它与账户登录信息一起保存。',
  callbackUrl: '回调网址',
  clientId: '客户端 ID',
  clientSecret: '客户端密钥（可选）',
  editOwnApp: '编辑 OAuth 应用',
  removeOwnApp: '移除应用并重试自动登录',
  invalidClientTitle: 'OAuth 应用被拒绝',
  invalidClientBody: '检查客户端 ID、密钥和已注册的回调网址，然后重新登录。',
  ownAppNotNeeded: '此服务接受 Happier 的应用身份，无需使用自己的 OAuth 应用。',
  reviewSetApp: '设置或替换 OAuth 应用',
  reviewRemoveApp: '移除 OAuth 应用',
  callback: {
    finishing: '正在完成登录…',
    closeTitle: '已登录',
    closeBody: '你可以关闭此标签页并返回 Happier。',
    connectedTitle: '已登录',
    connectedBody: '正在带你返回服务器…',
    pasteTitle: '将此验证码复制到 Happier',
    pasteBody: '粘贴到你开始登录的服务器页面。它只在那里有效，且仅可使用一次。',
    copyCode: '复制验证码',
    copied: '已复制',
    invalidTitle: '此登录链接不完整',
    invalidBody: '请从服务器页面重新开始登录。',
    unfinishedTitle: '登录未完成',
    unfinishedBody: '请返回服务器页面并重新登录。',
    openServers: '打开 MCP 服务器',
  },
};

const zhHant: McpSignInTranslation = {
  title: '登入',
  notConnectedTitle: ({ name }) => `登入 ${name}`,
  notConnectedBody: ({ name }) =>
    `${name} 需要你核准一次存取。之後在每台機器和每個工作階段中都能使用。`,
  signIn: '登入',
  signingTitle: '請在瀏覽器中繼續',
  signingBody: ({ name }) => `在 ${name} 中核准 Happier。此頁面會自動更新。`,
  waiting: ({ name }) => `正在等待 ${name}…`,
  cancel: '取消',
  notSignedInHere: ({ name }) => `在這裡沒有登入 ${name}？`,
  usePhone: '使用手機',
  or: '或',
  copyLink: '複製連結',
  linkCopied: '連結已複製',
  phoneTitle: '用手機掃描',
  phoneBody: '在手機上核准。此頁面將完成登入。',
  phoneWaiting: '等待中…',
  timeLeft: ({ time }) => `剩餘 ${time}`,
  useThisDevice: '使用此裝置',
  pasteTitle: '有驗證碼嗎？',
  pasteBody: '如果瀏覽器顯示了驗證碼或頁面網址，請貼到這裡。',
  finishingTitle: ({ machine }) => `正在 ${machine} 上完成登入`,
  finishingBody: ({ name, machine }) =>
    `已在 ${name} 中核准。${machine} 正在為你的帳號完成登入；稍後每台機器都能使用。`,
  connectedAs: ({ identity }) => `已以 ${identity} 身分連線`,
  connected: '已連線',
  connectedBody: '在每台機器上都能使用。',
  connectedSince: ({ date }) => `在每台機器上都能使用 · ${date} 登入`,
  signOut: '登出',
  signOutTitle: ({ name }) => `登出 ${name}？`,
  signOutBody: ({ name }) =>
    `再次登入之前，工作階段啟動時將沒有 ${name} 的工具。你的設定會保留。`,
  signOutFailed: '無法登出。請在有機器上線時重試。',
  moreAccessChip: '需要更多存取權限',
  moreAccessBody: ({ name }) =>
    `某個工具向 ${name} 要求了你尚未授予的存取權限。核准一次後，該呼叫即可執行。`,
  grantAccess: '授予存取權限',
  expiredChip: '登入已過期',
  expiredBody: ({ name }) =>
    `${name} 已不再接受該登入。重新連線之前，工作階段啟動時將沒有它的工具。`,
  addressChangedChip: '位址已變更',
  addressChangedBody: '自你登入後，伺服器位址已變更。請重新登入以繼續使用。',
  reconnect: '重新連線',
  revokedChip: '存取權限已撤銷',
  revokedBody: ({ name }) => `存取權限已在 ${name} 的設定中移除。你的設定會保留。`,
  signInAgain: '重新登入',
  didNotFinishTitle: ({ name }) => `${name} 未完成登入`,
  didNotFinishBody: '登入尚未完成。準備好後請重試。',
  tryAgain: '重試',
  noMachineTitle: '登入需要一台上線的機器',
  noMachineBody: '登入由機器為你完成。你的機器目前都沒有上線。',
  clientRefusedTitle: ({ name }) => `${name} 不允許 Happier 登入`,
  clientRefusedBody: '它不允許應用程式註冊登入。如果提供 API 金鑰，請改用 API 金鑰。',
  useApiKey: '使用 API 金鑰',
  useOwnApp: '使用自己的 OAuth 應用程式',
  ownAppBody: '在服務控制台中使用此回呼網址建立 OAuth 應用程式，然後填寫其資訊。Happier 會將它與帳戶登入資訊一起儲存。',
  callbackUrl: '回呼網址',
  clientId: '用戶端 ID',
  clientSecret: '用戶端密鑰（選填）',
  editOwnApp: '編輯 OAuth 應用程式',
  removeOwnApp: '移除應用程式並重試自動登入',
  invalidClientTitle: 'OAuth 應用程式遭到拒絕',
  invalidClientBody: '檢查用戶端 ID、密鑰及已註冊的回呼網址，然後重新登入。',
  ownAppNotNeeded: '此服務接受 Happier 的應用程式身分，無須使用自己的 OAuth 應用程式。',
  reviewSetApp: '設定或取代 OAuth 應用程式',
  reviewRemoveApp: '移除 OAuth 應用程式',
  callback: {
    finishing: '正在完成登入…',
    closeTitle: '已登入',
    closeBody: '你可以關閉此分頁並返回 Happier。',
    connectedTitle: '已登入',
    connectedBody: '正在帶你返回伺服器…',
    pasteTitle: '將此驗證碼複製到 Happier',
    pasteBody: '貼到你開始登入的伺服器頁面。它只在那裡有效，且僅可使用一次。',
    copyCode: '複製驗證碼',
    copied: '已複製',
    invalidTitle: '此登入連結不完整',
    invalidBody: '請從伺服器頁面重新開始登入。',
    unfinishedTitle: '登入未完成',
    unfinishedBody: '請返回伺服器頁面並重新登入。',
    openServers: '開啟 MCP 伺服器',
  },
};

export const mcpSignInTranslations = {
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
} as const satisfies Record<string, McpSignInTranslation>;
