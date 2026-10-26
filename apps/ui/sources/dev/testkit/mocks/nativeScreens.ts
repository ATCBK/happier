/** Native drawing/freezing lives in react-native-screens; navigation and route scenes stay real. */
export function createNativeScreensMock() {
    return {
        compatibilityFlags: {},
        ScreenStack: 'ScreenStack',
        ScreenStackItem: 'ScreenStackItem',
        ScreenStackHeaderBackButtonImage: 'ScreenStackHeaderBackButtonImage',
        ScreenStackHeaderCenterView: 'ScreenStackHeaderCenterView',
        ScreenStackHeaderLeftView: 'ScreenStackHeaderLeftView',
        ScreenStackHeaderRightView: 'ScreenStackHeaderRightView',
        ScreenStackHeaderSearchBarView: 'ScreenStackHeaderSearchBarView',
        SearchBar: 'SearchBar',
        isSearchBarAvailableForCurrentPlatform: false,
    };
}
