// react-native-svg 15.15.3 keeps this runtime parser beside its separately published XML types.
declare module 'react-native-svg/lib/commonjs/xml' {
    export { parse } from 'react-native-svg/lib/typescript/xml';
}
