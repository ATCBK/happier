type Paths = Readonly<{ paths: string }>;
type Changes = Paths & Readonly<{ count: number | null }>;
type Labels = Readonly<{
    discard: (params: Changes) => string;
    restore: (params: Paths) => string;
    undoDiscard: (params: Paths) => string;
    undoRestore: (params: Paths) => string;
    undo: (params: Paths) => string;
}>;

export const fileReviewNoteTranslations = {
    en: {
        discard: ({ paths, count }) => `You discarded ${count === null ? 'changes' : `${count} ${count === 1 ? 'change' : 'changes'}`} in ${paths}`,
        restore: ({ paths }) => `You restored ${paths} to its before state`,
        undoDiscard: ({ paths }) => `You undid the discard in ${paths}`,
        undoRestore: ({ paths }) => `You undid the restore in ${paths}`,
        undo: ({ paths }) => `You undid the review action in ${paths}`,
    },
    fr: {
        discard: ({ paths, count }) => `Vous avez annulé ${count === null ? 'des modifications' : `${count} modification${count === 1 ? '' : 's'}`} dans ${paths}`,
        restore: ({ paths }) => `Vous avez restauré l’état précédent de ${paths}`,
        undoDiscard: ({ paths }) => `Vous avez rétabli les modifications annulées dans ${paths}`,
        undoRestore: ({ paths }) => `Vous avez annulé la restauration de ${paths}`,
        undo: ({ paths }) => `Vous avez annulé l’action de révision dans ${paths}`,
    },
    de: {
        discard: ({ paths, count }) => `Du hast ${count === null ? 'Änderungen' : `${count} ${count === 1 ? 'Änderung' : 'Änderungen'}`} in ${paths} verworfen`,
        restore: ({ paths }) => `Du hast ${paths} auf den vorherigen Stand zurückgesetzt`,
        undoDiscard: ({ paths }) => `Du hast das Verwerfen in ${paths} rückgängig gemacht`,
        undoRestore: ({ paths }) => `Du hast das Wiederherstellen von ${paths} rückgängig gemacht`,
        undo: ({ paths }) => `Du hast die Überprüfungsaktion in ${paths} rückgängig gemacht`,
    },
    es: {
        discard: ({ paths, count }) => `Has descartado ${count === null ? 'cambios' : `${count} cambio${count === 1 ? '' : 's'}`} en ${paths}`,
        restore: ({ paths }) => `Has restaurado el estado anterior de ${paths}`,
        undoDiscard: ({ paths }) => `Has deshecho el descarte en ${paths}`,
        undoRestore: ({ paths }) => `Has deshecho la restauración de ${paths}`,
        undo: ({ paths }) => `Has deshecho la acción de revisión en ${paths}`,
    },
    ca: {
        discard: ({ paths, count }) => `Has descartat ${count === null ? 'canvis' : `${count} canvi${count === 1 ? '' : 's'}`} a ${paths}`,
        restore: ({ paths }) => `Has restaurat l’estat anterior de ${paths}`,
        undoDiscard: ({ paths }) => `Has desfet el descart a ${paths}`,
        undoRestore: ({ paths }) => `Has desfet la restauració de ${paths}`,
        undo: ({ paths }) => `Has desfet l’acció de revisió a ${paths}`,
    },
    it: {
        discard: ({ paths, count }) => `Hai scartato ${count === null ? 'modifiche' : `${count} ${count === 1 ? 'modifica' : 'modifiche'}`} in ${paths}`,
        restore: ({ paths }) => `Hai ripristinato lo stato precedente di ${paths}`,
        undoDiscard: ({ paths }) => `Hai annullato lo scarto in ${paths}`,
        undoRestore: ({ paths }) => `Hai annullato il ripristino di ${paths}`,
        undo: ({ paths }) => `Hai annullato l’azione di revisione in ${paths}`,
    },
    pt: {
        discard: ({ paths, count }) => `Você descartou ${count === null ? 'alterações' : `${count} ${count === 1 ? 'alteração' : 'alterações'}`} em ${paths}`,
        restore: ({ paths }) => `Você restaurou o estado anterior de ${paths}`,
        undoDiscard: ({ paths }) => `Você desfez o descarte em ${paths}`,
        undoRestore: ({ paths }) => `Você desfez a restauração de ${paths}`,
        undo: ({ paths }) => `Você desfez a ação de revisão em ${paths}`,
    },
    pl: {
        discard: ({ paths, count }) => `Odrzucono zmiany w ${paths}${count === null ? '' : ` (${count})`}`,
        restore: ({ paths }) => `Przywrócono poprzedni stan ${paths}`,
        undoDiscard: ({ paths }) => `Cofnięto odrzucenie zmian w ${paths}`,
        undoRestore: ({ paths }) => `Cofnięto przywrócenie ${paths}`,
        undo: ({ paths }) => `Cofnięto czynność przeglądu w ${paths}`,
    },
    ru: {
        discard: ({ paths, count }) => `Вы отменили изменения${count === null ? '' : ` (${count})`} в ${paths}`,
        restore: ({ paths }) => `Вы восстановили предыдущее состояние ${paths}`,
        undoDiscard: ({ paths }) => `Вы вернули отменённые изменения в ${paths}`,
        undoRestore: ({ paths }) => `Вы отменили восстановление ${paths}`,
        undo: ({ paths }) => `Вы отменили действие проверки в ${paths}`,
    },
    ja: {
        discard: ({ paths, count }) => `${paths} の変更${count === null ? '' : ` ${count} 件`}を破棄しました`,
        restore: ({ paths }) => `${paths} を以前の状態に復元しました`,
        undoDiscard: ({ paths }) => `${paths} の変更の破棄を取り消しました`,
        undoRestore: ({ paths }) => `${paths} の復元を取り消しました`,
        undo: ({ paths }) => `${paths} のレビュー操作を取り消しました`,
    },
    'zh-Hans': {
        discard: ({ paths, count }) => `你放弃了 ${paths} 中的${count === null ? '' : ` ${count} 项`}更改`,
        restore: ({ paths }) => `你将 ${paths} 恢复到了之前的状态`,
        undoDiscard: ({ paths }) => `你撤销了对 ${paths} 的更改放弃操作`,
        undoRestore: ({ paths }) => `你撤销了对 ${paths} 的恢复操作`,
        undo: ({ paths }) => `你撤销了对 ${paths} 的审查操作`,
    },
    'zh-Hant': {
        discard: ({ paths, count }) => `你捨棄了 ${paths} 中的${count === null ? '' : ` ${count} 項`}變更`,
        restore: ({ paths }) => `你將 ${paths} 還原至先前的狀態`,
        undoDiscard: ({ paths }) => `你復原了對 ${paths} 的捨棄變更操作`,
        undoRestore: ({ paths }) => `你復原了對 ${paths} 的還原操作`,
        undo: ({ paths }) => `你復原了對 ${paths} 的審查操作`,
    },
} as const satisfies Record<string, Labels>;
