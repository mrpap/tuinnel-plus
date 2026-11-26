import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync, unlinkSync, renameSync, createWriteStream } from 'fs';
import { join } from 'path';
import { execSync, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { resolveStateDir } from '../config/paths.js';

export const BIN_DIR = join(resolveStateDir(), 'bin');
export const BINARY_PATH = join(BIN_DIR, 'cloudflared');
export const VERSION_FILE = join(BIN_DIR, '.version');

const ASSET_MAP: Record<string, string> = {
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'linux-arm64': 'cloudflared-linux-arm64',
  'linux-x64': 'cloudflared-linux-amd64',
};

const DOWNLOAD_BASE = 'https://github.com/cloudflare/cloudflared/releases/download';
const GITHUB_API_LATEST = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';

export function getAssetName(): string {
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSET_MAP[key];
  if (!asset) {
    throw new Error(`Unsupported platform: ${key}`);
  }
  return asset;
}

function isTarball(asset: string): boolean {
  return asset.endsWith('.tgz');
}

export function binaryExists(): boolean {
  return existsSync(BINARY_PATH);
}

export function getInstalledVersion(): string | null {
  if (existsSync(VERSION_FILE)) {
    return readFileSync(VERSION_FILE, 'utf-8').trim();
  }
  if (!binaryExists()) {
    return null;
  }
  try {
    const output = execFileSync(BINARY_PATH, ['version', '--short'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output.trim();
  } catch {
    return null;
  }
}

export interface Release {
  version: string;
  tag: string;
  /** `digest` is GitHub's `sha256:<hex>` for the downloadable file, when published. */
  assets: Array<{ name: string; digest: string | null }>;
}

export async function getLatestRelease(): Promise<Release> {
  const res = await fetch(GITHUB_API_LATEST, {
    headers: { 'Accept': 'application/vnd.github.v3+json' },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch latest release: ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as { tag_name: string; assets?: Array<{ name: string; digest?: string | null }> };
  return {
    // tag_name is like "2025.8.0" or "v2025.8.0"
    version: data.tag_name.replace(/^v/, ''),
    tag: data.tag_name,
    assets: (data.assets ?? []).map((a) => ({ name: a.name, digest: a.digest ?? null })),
  };
}

export async function getLatestVersion(): Promise<string> {
  return (await getLatestRelease()).version;
}

export function isUpdateAvailable(installed: string, latest: string): boolean {
  return installed !== latest;
}

export async function downloadBinary(
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<string> {
  const asset = getAssetName();
  // One lookup decides both what we download and the checksum it must match.
  const release = await getLatestRelease();
  const version = release.version;
  const expected = /^sha256:([0-9a-f]{64})$/i.exec(release.assets.find((a) => a.name === asset)?.digest ?? '')?.[1];
  if (!expected) {
    throw new Error(
      `GitHub did not publish a SHA-256 digest for ${asset} ${release.tag}; refusing to install an unverified binary. ` +
      'Set TUINNEL_CLOUDFLARED to use your own cloudflared instead.',
    );
  }
  const url = `${DOWNLOAD_BASE}/${release.tag}/${asset}`;

  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
  }

  const tmpPath = join(BIN_DIR, `${asset}.tmp`);

  // Download the file
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to download cloudflared: ${res.status} ${res.statusText}`);
  }

  const contentLength = res.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : null;
  let downloaded = 0;
  const hash = createHash('sha256');

  const body = res.body;
  if (!body) {
    throw new Error('Empty response body from download');
  }

  const writeStream = createWriteStream(tmpPath);

  // Transform to track progress
  const reader = body.getReader();
  const progressStream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      downloaded += value.byteLength;
      hash.update(value);
      if (onProgress) onProgress(downloaded, total);
      controller.enqueue(value);
    },
  });

  await pipeline(
    Readable.fromWeb(progressStream as import('stream/web').ReadableStream),
    writeStream,
  );

  // Check the file against the digest GitHub publishes for the release asset
  if (hash.digest('hex') !== expected.toLowerCase()) {
    unlinkSync(tmpPath);
    throw new Error('Downloaded cloudflared failed verification (SHA-256 mismatch); nothing was installed.');
  }

  // Extract or move binary
  if (isTarball(asset)) {
    // macOS: extract .tgz archive
    execFileSync('tar', ['-xzf', tmpPath, '-C', BIN_DIR], { timeout: 10000 });
    unlinkSync(tmpPath);
  } else {
    // Linux: rename bare binary
    renameSync(tmpPath, BINARY_PATH);
  }

  // Make executable
  chmodSync(BINARY_PATH, 0o755);

  // Store version (fetched at start of download)
  writeFileSync(VERSION_FILE, version + '\n', 'utf-8');

  return BINARY_PATH;
}

/**
 * The cloudflared to run. TUINNEL_CLOUDFLARED points at an existing install
 * (e.g. a package manager's, which keeps it updated); otherwise a managed copy
 * is downloaded into the state directory.
 */
export async function ensureBinary(
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<string> {
  const external = process.env.TUINNEL_CLOUDFLARED?.trim();
  if (external) {
    if (!existsSync(external)) {
      throw new Error(`TUINNEL_CLOUDFLARED points to ${external}, which does not exist`);
    }
    return external;
  }
  if (binaryExists()) {
    return BINARY_PATH;
  }
  return downloadBinary(onProgress);
}
