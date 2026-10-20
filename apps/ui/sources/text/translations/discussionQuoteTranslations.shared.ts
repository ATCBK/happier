type Revision = Readonly<{ headerVersion: number; bodyVersion: number }>;

export const discussionQuoteCopy = {
    en: { message: 'Message', document: 'Document passage', task: 'Task', unavailable: 'Source unavailable', revision: ({ bodyVersion }: Revision) => `Version ${bodyVersion}` },
    ca: { message: 'Missatge', document: 'Fragment del document', task: 'Tasca', unavailable: 'Font no disponible', revision: ({ bodyVersion }: Revision) => `Versió ${bodyVersion}` },
    de: { message: 'Nachricht', document: 'Dokumentstelle', task: 'Aufgabe', unavailable: 'Quelle nicht verfügbar', revision: ({ bodyVersion }: Revision) => `Version ${bodyVersion}` },
    es: { message: 'Mensaje', document: 'Fragmento del documento', task: 'Tarea', unavailable: 'Fuente no disponible', revision: ({ bodyVersion }: Revision) => `Versión ${bodyVersion}` },
    fr: { message: 'Message', document: 'Passage du document', task: 'Tâche', unavailable: 'Source indisponible', revision: ({ bodyVersion }: Revision) => `Version ${bodyVersion}` },
    it: { message: 'Messaggio', document: 'Passaggio del documento', task: 'Attività', unavailable: 'Fonte non disponibile', revision: ({ bodyVersion }: Revision) => `Versione ${bodyVersion}` },
    ja: { message: 'メッセージ', document: 'ドキュメントの一節', task: 'タスク', unavailable: '参照元を利用できません', revision: ({ bodyVersion }: Revision) => `バージョン ${bodyVersion}` },
    pl: { message: 'Wiadomość', document: 'Fragment dokumentu', task: 'Zadanie', unavailable: 'Źródło niedostępne', revision: ({ bodyVersion }: Revision) => `Wersja ${bodyVersion}` },
    pt: { message: 'Mensagem', document: 'Trecho do documento', task: 'Tarefa', unavailable: 'Fonte indisponível', revision: ({ bodyVersion }: Revision) => `Versão ${bodyVersion}` },
    ru: { message: 'Сообщение', document: 'Фрагмент документа', task: 'Задача', unavailable: 'Источник недоступен', revision: ({ bodyVersion }: Revision) => `Версия ${bodyVersion}` },
    'zh-Hans': { message: '消息', document: '文档段落', task: '任务', unavailable: '来源不可用', revision: ({ bodyVersion }: Revision) => `版本 ${bodyVersion}` },
    'zh-Hant': { message: '訊息', document: '文件段落', task: '工作', unavailable: '來源無法使用', revision: ({ bodyVersion }: Revision) => `版本 ${bodyVersion}` },
};
