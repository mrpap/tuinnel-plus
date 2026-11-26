// tsup.config.ts
import { readFileSync } from 'fs';
import { defineConfig } from 'tsup';
import { buildCommit, buildDefines, readGitState } from './src/build-info';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  // Rollup tree-shaking for dead code elimination.
  // Known warning: "isDeepStrictEqual imported from external module util but never used"
  // comes from the @inkjs/ui barrel; the import is eliminated, so it's cosmetic.
  treeshake: true,
  // The version and commit this build came from; see src/version.ts.
  define: buildDefines({ version, commit: buildCommit(readGitState(version)) }),
  // The web UI is plain static files; ship them next to the bundle.
  onSuccess: 'rm -rf dist/web && cp -R src/web dist/web',
  // CRITICAL: Bundle ALL dependencies into the output.
  // Global npm install does not hoist dependencies.
  // Listing only top-level packages misses transitive deps
  // (Ink alone has 24+ runtime deps: react-reconciler, yoga-layout, ws, etc.)
  noExternal: [/.*/],        // Regex: bundle everything
  // Inject a real `require` function so bundled CJS code (e.g., Commander.js)
  // can resolve Node built-in modules like 'events', 'path', etc.
  // ESM doesn't have `require` natively, so esbuild's CJS shim throws.
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    // CRITICAL: Force single React instance.
    // esbuild can bundle multiple React copies from different dependency paths,
    // which breaks React hooks entirely (shared internal state requirement).
    options.alias = {
      'react': 'react',
      'react-reconciler': 'react-reconciler',
      // Ink optionally imports react-devtools-core (only when DEV=true).
      // Stub it out since it's not installed and not needed in production.
      'react-devtools-core': './src/stubs/react-devtools-core.ts',
    };
    // Ensure React runs in production mode (smaller, no dev warnings)
    options.define = {
      ...options.define,
      'process.env.NODE_ENV': '"production"',
    };
  },
});
