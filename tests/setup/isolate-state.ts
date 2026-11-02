// Preloaded by bunfig.toml before any test file (and so before any src module
// computes its paths). Points TUINNEL_HOME at a throwaway directory so no test
// can read or write the real ~/.tuinnel. Changing HOME is not enough: Bun's
// os.homedir() ignores runtime HOME changes. resolveStateDir() additionally
// throws if a test run ever resolves to the real directory.
// tests/setup/isolation.test.ts guards both.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const sandbox = mkdtempSync(join(tmpdir(), 'tuinnel-test-'));
process.env.NODE_ENV = 'test';
process.env.TUINNEL_HOME = join(sandbox, '.tuinnel');
