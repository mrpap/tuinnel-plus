import { readFileSync } from 'fs';

// Baked in by the build (tsup.config.ts), so a running build reports what it was built from
// even after package.json moves on. Undefined when running from source.
declare const __BUILD_VERSION__: string | undefined;
declare const __BUILD_COMMIT__: string | null | undefined;

const built = typeof __BUILD_VERSION__ !== 'undefined';

// package.json sits one level up from src/version.ts.
export const VERSION: string = built
  ? __BUILD_VERSION__!
  : JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version;

/** The commit a development build came from; null for a release build and when running from source. */
export const COMMIT: string | null = built && typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : null;

export function versionLabel(version: string, commit: string | null): string {
  return commit ? `${version} (${commit})` : version;
}

export const VERSION_LABEL = versionLabel(VERSION, COMMIT);
