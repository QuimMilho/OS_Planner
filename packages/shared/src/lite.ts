// The light entry point (`@os-planner/shared/lite`): the few helpers the app needs before anything else loads.
//
// The full package carries the editor schema, validation (TipTap/ProseMirror, KaTeX) and every DTO schema
// (zod): roughly 1 MB that a visitor looking at the landing page or the sign-in form does not need. Code on
// the first-load path imports from here instead, so those libraries are fetched only with the screens that
// use them. Keep this file free of anything that imports zod, TipTap (at run time) or KaTeX.
export { EMPTY_DOC } from './doc/empty';
export { collectMediaIds, countWords, extractText } from './doc/text';
export { IMAGE_MIMES, VIDEO_MIMES } from './dto/mime';
export { positionBetween } from './dto/position';
export * from './permissions';
export * from './dto/realtime-consts';
export * from './dto/shared-keys';
