import type { SupportedLanguage } from '../_all';

type EmptyEditorCopy = Readonly<{
    title: string;
    reason: string;
    openFile: string;
    changedInSession: string;
    openChangedFileA11y: (params: { name: string }) => string;
}>;

/** The editor column with nothing open (lab ade-shell EM1). */
export const paneEmptyEditorTranslations = {
    en: { title: 'Open a file beside the session', reason: 'Read or edit any file in this project while the session works.', openFile: 'Open file…', changedInSession: 'Changed in this session', openChangedFileA11y: ({ name }: { name: string }) => `Open ${name}` },
    fr: { title: 'Ouvrez un fichier à côté de la session', reason: 'Lisez ou modifiez n’importe quel fichier du projet pendant que la session travaille.', openFile: 'Ouvrir un fichier…', changedInSession: 'Modifiés dans cette session', openChangedFileA11y: ({ name }: { name: string }) => `Ouvrir ${name}` },
    de: { title: 'Öffne eine Datei neben der Sitzung', reason: 'Lies oder bearbeite jede Datei in diesem Projekt, während die Sitzung arbeitet.', openFile: 'Datei öffnen…', changedInSession: 'In dieser Sitzung geändert', openChangedFileA11y: ({ name }: { name: string }) => `${name} öffnen` },
    es: { title: 'Abre un archivo junto a la sesión', reason: 'Lee o edita cualquier archivo del proyecto mientras la sesión trabaja.', openFile: 'Abrir archivo…', changedInSession: 'Cambiados en esta sesión', openChangedFileA11y: ({ name }: { name: string }) => `Abrir ${name}` },
    it: { title: 'Apri un file accanto alla sessione', reason: 'Leggi o modifica qualsiasi file del progetto mentre la sessione lavora.', openFile: 'Apri file…', changedInSession: 'Modificati in questa sessione', openChangedFileA11y: ({ name }: { name: string }) => `Apri ${name}` },
    pt: { title: 'Abra um arquivo ao lado da sessão', reason: 'Leia ou edite qualquer arquivo do projeto enquanto a sessão trabalha.', openFile: 'Abrir arquivo…', changedInSession: 'Alterados nesta sessão', openChangedFileA11y: ({ name }: { name: string }) => `Abrir ${name}` },
    ca: { title: 'Obre un fitxer al costat de la sessió', reason: 'Llegeix o edita qualsevol fitxer del projecte mentre la sessió treballa.', openFile: 'Obre un fitxer…', changedInSession: 'Canviats en aquesta sessió', openChangedFileA11y: ({ name }: { name: string }) => `Obre ${name}` },
    pl: { title: 'Otwórz plik obok sesji', reason: 'Czytaj lub edytuj dowolny plik projektu, gdy sesja pracuje.', openFile: 'Otwórz plik…', changedInSession: 'Zmienione w tej sesji', openChangedFileA11y: ({ name }: { name: string }) => `Otwórz ${name}` },
    ru: { title: 'Откройте файл рядом с сессией', reason: 'Читайте или редактируйте любой файл проекта, пока сессия работает.', openFile: 'Открыть файл…', changedInSession: 'Изменены в этой сессии', openChangedFileA11y: ({ name }: { name: string }) => `Открыть ${name}` },
    ja: { title: 'セッションの横でファイルを開く', reason: 'セッションの作業中に、このプロジェクトのファイルを読んだり編集したりできます。', openFile: 'ファイルを開く…', changedInSession: 'このセッションで変更', openChangedFileA11y: ({ name }: { name: string }) => `${name}を開く` },
    'zh-Hans': { title: '在会话旁打开文件', reason: '会话工作时，阅读或编辑此项目中的任何文件。', openFile: '打开文件…', changedInSession: '本会话中的更改', openChangedFileA11y: ({ name }: { name: string }) => `打开 ${name}` },
    'zh-Hant': { title: '在工作階段旁開啟檔案', reason: '工作階段進行時，閱讀或編輯此專案中的任何檔案。', openFile: '開啟檔案…', changedInSession: '此工作階段中的變更', openChangedFileA11y: ({ name }: { name: string }) => `開啟 ${name}` },
} as const satisfies Record<SupportedLanguage, EmptyEditorCopy>;

type ShortcutsSheetCopy = Readonly<{
    footer: string;
    openSettings: string;
    hostA11y: string;
}>;

/** The `?` shortcut sheet (lab ade-shell KB1). */
export const paneShortcutsSheetTranslations = {
    en: { footer: 'Review keys work when a diff has focus and you are not typing.', openSettings: 'Change shortcuts in Settings', hostA11y: 'Show shortcuts for' },
    fr: { footer: 'Les touches de revue fonctionnent quand un diff a le focus et que vous ne tapez pas.', openSettings: 'Modifier les raccourcis dans Réglages', hostA11y: 'Afficher les raccourcis pour' },
    de: { footer: 'Review-Tasten wirken, wenn ein Diff den Fokus hat und du nicht tippst.', openSettings: 'Kurzbefehle in den Einstellungen ändern', hostA11y: 'Kurzbefehle anzeigen für' },
    es: { footer: 'Las teclas de revisión funcionan cuando un diff tiene el foco y no estás escribiendo.', openSettings: 'Cambiar atajos en Ajustes', hostA11y: 'Mostrar atajos para' },
    it: { footer: 'I tasti di revisione funzionano quando un diff ha il focus e non stai scrivendo.', openSettings: 'Cambia le scorciatoie nelle Impostazioni', hostA11y: 'Mostra le scorciatoie per' },
    pt: { footer: 'As teclas de revisão funcionam quando um diff tem o foco e você não está digitando.', openSettings: 'Alterar atalhos em Ajustes', hostA11y: 'Mostrar atalhos para' },
    ca: { footer: 'Les tecles de revisió funcionen quan un diff té el focus i no escrius.', openSettings: 'Canvia les dreceres a Configuració', hostA11y: 'Mostra les dreceres per a' },
    pl: { footer: 'Klawisze przeglądu działają, gdy diff ma fokus i nie piszesz.', openSettings: 'Zmień skróty w Ustawieniach', hostA11y: 'Pokaż skróty dla' },
    ru: { footer: 'Клавиши ревью работают, когда в фокусе diff и вы не печатаете.', openSettings: 'Изменить сочетания в настройках', hostA11y: 'Показать сочетания для' },
    ja: { footer: 'レビューのキーは、差分にフォーカスがあり入力中でないときに使えます。', openSettings: '設定でショートカットを変更', hostA11y: 'ショートカットの表示先' },
    'zh-Hans': { footer: '当差异视图获得焦点且你未在输入时，审阅按键可用。', openSettings: '在设置中更改快捷键', hostA11y: '显示快捷键：' },
    'zh-Hant': { footer: '當差異檢視取得焦點且你未在輸入時，審閱按鍵可用。', openSettings: '在設定中變更快速鍵', hostA11y: '顯示快速鍵：' },
} as const satisfies Record<SupportedLanguage, ShortcutsSheetCopy>;
