/**
 * The server renders Plugin UI's portable page through react-native-web (see
 * scripts/buildPublicProfileRenderer.mjs), so the declarations that name React Native types resolve here
 * instead of loading React Native's package types, whose global timer and fetch declarations conflict with Node.
 */
export {};
