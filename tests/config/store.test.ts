import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { rmSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import type { Config } from '../../src/config/schema.js';
import {
  writeConfig, readConfig, configExists, getDefaultConfig, CONFIG_DIR, CONFIG_PATH,
} from '../../src/config/store.js';

// The state dir is the throwaway TUINNEL_HOME set by tests/setup/isolate-state.ts.
const TEST_CONFIG_DIR = process.env.TUINNEL_HOME!;
const TEST_CONFIG_PATH = join(TEST_CONFIG_DIR, 'config.json');

describe('config store', () => {
  beforeEach(() => {
    // Clean slate: remove the sandboxed state dir before each test
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    // Don't leave the corrupted-config fixture behind for later test files.
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  test('getDefaultConfig returns valid config with version 1', () => {
    const config = getDefaultConfig();
    expect(config.version).toBe(1);
    expect(config.tunnels).toEqual({});
  });

  test('CONFIG_DIR and CONFIG_PATH honor TUINNEL_HOME', () => {
    expect(CONFIG_DIR).toBe(TEST_CONFIG_DIR);
    expect(CONFIG_PATH).toBe(TEST_CONFIG_PATH);
  });

  test('writeConfig creates directory and file with 0600 permissions', () => {
    const config: Config = {
      version: 1,
      tunnels: {},
    };
    writeConfig(config);

    expect(existsSync(CONFIG_PATH)).toBe(true);

    const stat = statSync(CONFIG_PATH);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('readConfig returns null for missing file', () => {
    const result = readConfig();
    expect(result).toBeNull();
  });

  test('readConfig validates against schema', () => {
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ invalid: true }), 'utf-8');
    chmodSync(TEST_CONFIG_PATH, 0o600);

    expect(() => readConfig()).toThrow('Invalid config');
  });

  test('writeConfig validates config before writing', () => {
    const invalidConfig = { version: 2, tunnels: {} } as unknown as Config;
    expect(() => writeConfig(invalidConfig)).toThrow('Invalid config');
  });

  test('atomic write: uses temp file then renames', () => {
    const config: Config = {
      version: 1,
      apiToken: 'test-token-123',
      tunnels: {
        myapp: { port: 3000, subdomain: 'myapp', zone: 'example.com', protocol: 'http' },
      },
    };
    writeConfig(config);

    // After write, the temp file should NOT exist (it was renamed)
    const tmpPath = TEST_CONFIG_PATH + '.tmp';
    expect(existsSync(tmpPath)).toBe(false);

    // The final file should exist and contain valid data
    expect(existsSync(TEST_CONFIG_PATH)).toBe(true);
    const written = JSON.parse(readFileSync(TEST_CONFIG_PATH, 'utf-8'));
    expect(written.version).toBe(1);
    expect(written.apiToken).toBe('test-token-123');
    expect(written.tunnels.myapp.port).toBe(3000);
  });

  test('configExists returns correct boolean', () => {
    expect(configExists()).toBe(false);

    writeConfig(getDefaultConfig());
    expect(configExists()).toBe(true);
  });

  test('write then read roundtrip preserves data', () => {
    const config: Config = {
      version: 1,
      apiToken: 'roundtrip-token',
      defaultZone: 'example.com',
      tunnels: {
        angular: { port: 4200, subdomain: 'angular', zone: 'example.com', protocol: 'http' },
        api: { port: 8080, subdomain: 'api', zone: 'example.com', protocol: 'https' },
      },
    };

    writeConfig(config);
    const loaded = readConfig();

    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.apiToken).toBe('roundtrip-token');
    expect(loaded!.defaultZone).toBe('example.com');
    expect(loaded!.tunnels.angular.port).toBe(4200);
    expect(loaded!.tunnels.api.protocol).toBe('https');
  });

  test('readConfig throws for corrupted JSON', () => {
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    writeFileSync(TEST_CONFIG_PATH, 'not-valid-json{{{', 'utf-8');
    chmodSync(TEST_CONFIG_PATH, 0o600);

    expect(() => readConfig()).toThrow('Corrupted config');
  });
});
