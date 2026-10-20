import type { SupportedLanguage } from '../_all';

type MainColumnCopy = Readonly<{
    hideSession: string;
    showSession: string;
    hideProject: string;
    showProject: string;
    hideWorkflow: string;
    showWorkflow: string;
    hidePage: (params: { title: string }) => string;
    showPage: (params: { title: string }) => string;
}>;

export const paneMainColumnTranslations = {
    en: { hideSession: 'Hide session', showSession: 'Show session', hideProject: 'Hide project', showProject: 'Show project', hideWorkflow: 'Hide workflow', showWorkflow: 'Show workflow', hidePage: ({ title }: { title: string }) => `Hide ${title}`, showPage: ({ title }: { title: string }) => `Show ${title}` },
    fr: { hideSession: 'Masquer la session', showSession: 'Afficher la session', hideProject: 'Masquer le projet', showProject: 'Afficher le projet', hideWorkflow: 'Masquer le workflow', showWorkflow: 'Afficher le workflow', hidePage: ({ title }: { title: string }) => `Masquer ${title}`, showPage: ({ title }: { title: string }) => `Afficher ${title}` },
    de: { hideSession: 'Sitzung ausblenden', showSession: 'Sitzung anzeigen', hideProject: 'Projekt ausblenden', showProject: 'Projekt anzeigen', hideWorkflow: 'Workflow ausblenden', showWorkflow: 'Workflow anzeigen', hidePage: ({ title }: { title: string }) => `${title} ausblenden`, showPage: ({ title }: { title: string }) => `${title} anzeigen` },
    es: { hideSession: 'Ocultar sesión', showSession: 'Mostrar sesión', hideProject: 'Ocultar proyecto', showProject: 'Mostrar proyecto', hideWorkflow: 'Ocultar flujo de trabajo', showWorkflow: 'Mostrar flujo de trabajo', hidePage: ({ title }: { title: string }) => `Ocultar ${title}`, showPage: ({ title }: { title: string }) => `Mostrar ${title}` },
    it: { hideSession: 'Nascondi sessione', showSession: 'Mostra sessione', hideProject: 'Nascondi progetto', showProject: 'Mostra progetto', hideWorkflow: 'Nascondi workflow', showWorkflow: 'Mostra workflow', hidePage: ({ title }: { title: string }) => `Nascondi ${title}`, showPage: ({ title }: { title: string }) => `Mostra ${title}` },
    pt: { hideSession: 'Ocultar sessão', showSession: 'Mostrar sessão', hideProject: 'Ocultar projeto', showProject: 'Mostrar projeto', hideWorkflow: 'Ocultar fluxo de trabalho', showWorkflow: 'Mostrar fluxo de trabalho', hidePage: ({ title }: { title: string }) => `Ocultar ${title}`, showPage: ({ title }: { title: string }) => `Mostrar ${title}` },
    ca: { hideSession: 'Amaga la sessió', showSession: 'Mostra la sessió', hideProject: 'Amaga el projecte', showProject: 'Mostra el projecte', hideWorkflow: 'Amaga el flux de treball', showWorkflow: 'Mostra el flux de treball', hidePage: ({ title }: { title: string }) => `Amaga ${title}`, showPage: ({ title }: { title: string }) => `Mostra ${title}` },
    pl: { hideSession: 'Ukryj sesję', showSession: 'Pokaż sesję', hideProject: 'Ukryj projekt', showProject: 'Pokaż projekt', hideWorkflow: 'Ukryj przepływ pracy', showWorkflow: 'Pokaż przepływ pracy', hidePage: ({ title }: { title: string }) => `Ukryj ${title}`, showPage: ({ title }: { title: string }) => `Pokaż ${title}` },
    ru: { hideSession: 'Скрыть сессию', showSession: 'Показать сессию', hideProject: 'Скрыть проект', showProject: 'Показать проект', hideWorkflow: 'Скрыть рабочий процесс', showWorkflow: 'Показать рабочий процесс', hidePage: ({ title }: { title: string }) => `Скрыть ${title}`, showPage: ({ title }: { title: string }) => `Показать ${title}` },
    ja: { hideSession: 'セッションを非表示', showSession: 'セッションを表示', hideProject: 'プロジェクトを非表示', showProject: 'プロジェクトを表示', hideWorkflow: 'ワークフローを非表示', showWorkflow: 'ワークフローを表示', hidePage: ({ title }: { title: string }) => `${title}を非表示`, showPage: ({ title }: { title: string }) => `${title}を表示` },
    'zh-Hans': { hideSession: '隐藏会话', showSession: '显示会话', hideProject: '隐藏项目', showProject: '显示项目', hideWorkflow: '隐藏工作流', showWorkflow: '显示工作流', hidePage: ({ title }: { title: string }) => `隐藏${title}`, showPage: ({ title }: { title: string }) => `显示${title}` },
    'zh-Hant': { hideSession: '隱藏工作階段', showSession: '顯示工作階段', hideProject: '隱藏專案', showProject: '顯示專案', hideWorkflow: '隱藏工作流程', showWorkflow: '顯示工作流程', hidePage: ({ title }: { title: string }) => `隱藏${title}`, showPage: ({ title }: { title: string }) => `顯示${title}` },
} as const satisfies Record<SupportedLanguage, MainColumnCopy>;
