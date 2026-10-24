function commands(open: string, select: (ordinal: number) => string) {
    return {
        sessionListFilterOpen: open,
        sessionListSpaceSelect1: select(1),
        sessionListSpaceSelect2: select(2),
        sessionListSpaceSelect3: select(3),
        sessionListSpaceSelect4: select(4),
        sessionListSpaceSelect5: select(5),
        sessionListSpaceSelect6: select(6),
        sessionListSpaceSelect7: select(7),
        sessionListSpaceSelect8: select(8),
        sessionListSpaceSelect9: select(9),
    };
}

export const sessionListSpacesKeyboardTranslations = {
    en: commands('Open list filters', ordinal => `Select space ${ordinal}`),
    ca: commands('Obre els filtres de la llista', ordinal => `Selecciona l’espai ${ordinal}`),
    de: commands('Listenfilter öffnen', ordinal => `Bereich ${ordinal} auswählen`),
    es: commands('Abrir filtros de la lista', ordinal => `Seleccionar espacio ${ordinal}`),
    fr: commands('Ouvrir les filtres de la liste', ordinal => `Sélectionner l’espace ${ordinal}`),
    it: commands('Apri i filtri dell’elenco', ordinal => `Seleziona lo spazio ${ordinal}`),
    ja: commands('リストのフィルターを開く', ordinal => `スペース ${ordinal} を選択`),
    pl: commands('Otwórz filtry listy', ordinal => `Wybierz przestrzeń ${ordinal}`),
    pt: commands('Abrir filtros da lista', ordinal => `Selecionar espaço ${ordinal}`),
    ru: commands('Открыть фильтры списка', ordinal => `Выбрать пространство ${ordinal}`),
    'zh-Hans': commands('打开列表筛选器', ordinal => `选择空间 ${ordinal}`),
    'zh-Hant': commands('開啟列表篩選器', ordinal => `選擇空間 ${ordinal}`),
};
