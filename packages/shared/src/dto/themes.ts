/**
 * The colour themes, without zod: the web app reads this list on its first load (`@os-planner/shared/lite`), where the schemas are not
 * wanted. `system` follows the operating system (light or dark); the others are fixed. Coloured themes are dark schemes.
 */
export const THEMES = [
  'system',
  'light',
  'dark',
  'purple',
  'red',
  'green',
  'blue',
  'darkblue',
] as const;
export type ThemeName = (typeof THEMES)[number];
