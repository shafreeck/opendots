// Node cannot load React Native's platform module. The installed unmodified URL
// parser only reads NativeModules.BlobModule for createObjectURL (unused here).
// Stub that native hook; all URL parsing/getters run from the shipped polyfill.
import { registerHooks } from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier==='react-native')return{url:'data:text/javascript,export const NativeModules = {};',shortCircuit:true};return next(specifier,context);}});
