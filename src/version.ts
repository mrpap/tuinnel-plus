import { readFileSync } from 'fs';

// package.json sits one level up from both src/version.ts and the bundled dist/index.js.
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version;
