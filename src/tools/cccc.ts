// cccc (https://github.com/moznion/cccc): cyclomatic and cognitive complexity of each function.
// It is not on npm (the npm package named "cccc" is another project), so it is fetched from its own
// GitHub releases. doctor offers the install. Nothing else in the package needs it: without it the
// complexity facts are absent.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../cli/util.ts';

/**
 * The pinned release. Each sha256 is the value the release publishes beside the asset.
 * To move to a new version: change `version`, then copy the five sums from the release's .sha256 files.
 */
export const CCCC = {
  name: 'cccc',
  version: '1.8.2',
  repo: 'moznion/cccc',
  /** The workflow that builds the release assets. The attestation must name it. */
  workflow: 'moznion/cccc/.github/workflows/release-build.yml',
  assets: {
    'darwin-arm64': { file: 'cccc-v1.8.2-aarch64-apple-darwin.tar.gz', sha256: 'be7889e82eac5505f73c598b63359cc2a650bf48e713ca4e4e72903cd05446d7' },
    'darwin-x64': { file: 'cccc-v1.8.2-x86_64-apple-darwin.tar.gz', sha256: '5947b2d8f49755a191f3a752dfd6136dbd4b1222b15f72bd78b46f811ea23b93' },
    'linux-arm64': { file: 'cccc-v1.8.2-aarch64-unknown-linux-musl.tar.gz', sha256: '713e2f4f2f50bcce7449dbba5420c3303926513ecb603bb492ec123150fcd213' },
    'linux-x64': { file: 'cccc-v1.8.2-x86_64-unknown-linux-musl.tar.gz', sha256: '78d8fadc0c3177310ebdf5c1ed509c6f8adb2e292cd4f39b2b9bff2b534a7fb1' },
    'win32-x64': { file: 'cccc-v1.8.2-x86_64-pc-windows-msvc.zip', sha256: 'ff7f3b8e4b595161765768d09172d2d2f2dd4e43b5e2897e87b14c364cdb397c' },
  } as Record<string, { file: string; sha256: string }>,
};

/** What was installed, from where, and how it was checked. Written beside the binary. */
export interface Receipt {
  tool: string;
  version: string;
  source: string;
  asset: string;
  sha256: string;
  /** True when `gh attestation verify` confirmed the release workflow built the asset. */
  attested: boolean;
  signerWorkflow: string;
  installedAt: string;
}

export interface Located { path: string; version: string; receipt: Receipt | null }

export const platformKey = (): string => `${process.platform}-${process.arch}`;
const exe = (): string => (process.platform === 'win32' ? 'cccc.exe' : 'cccc');

/** Where fetched tools live: one directory for each tool version, outside every repository. */
export function toolsDir(): string {
  if (process.env.GH_WAT_DIS_TOOLS) return process.env.GH_WAT_DIS_TOOLS;
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(base, 'gh-wat-dis', 'tools');
}

const installDir = (): string => join(toolsDir(), `${CCCC.name}-${CCCC.version}`);

function versionOf(bin: string): string | null {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return r.status === 0 ? /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null : null;
}

/** The copy doctor installed, or one on PATH that the person installed themselves. */
export function locate(): Located | null {
  const own = join(installDir(), exe());
  if (existsSync(own)) {
    const version = versionOf(own);
    if (version) return { path: own, version, receipt: readJson<Receipt>(join(installDir(), 'receipt.json')) };
  }
  const version = versionOf(CCCC.name);
  return version ? { path: CCCC.name, version, receipt: null } : null;
}

function findFile(dir: string, name: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
  }
  return null;
}

/**
 * Download the pinned release asset for this platform, check it, and put the binary in the tools directory.
 * Two checks, both must hold: the sha256 pinned above, and GitHub's build attestation for the release workflow.
 * A gh without the attestation command is the one case that installs on the hash alone, and the receipt says so.
 */
export function install(log: (line: string) => void = () => {}): Receipt {
  const asset = CCCC.assets[platformKey()];
  if (!asset) throw new Error(`cccc ${CCCC.version} has no build for ${platformKey()}`);
  const tag = `v${CCCC.version}`;
  const tmp = mkdtempSync(join(tmpdir(), 'gh-wat-dis-cccc-'));
  const gh = (args: string[]): { ok: boolean; err: string } => {
    const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    return { ok: r.status === 0, err: `${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim() };
  };
  try {
    log(`download ${CCCC.repo} ${tag} ${asset.file}`);
    const dl = gh(['release', 'download', tag, '--repo', CCCC.repo, '--pattern', asset.file, '--dir', tmp]);
    if (!dl.ok) throw new Error(`download failed: ${dl.err.split('\n')[0]}`);
    const archive = join(tmp, asset.file);

    const sum = createHash('sha256').update(readFileSync(archive)).digest('hex');
    if (sum !== asset.sha256) throw new Error(`sha256 mismatch for ${asset.file}: got ${sum}, pinned ${asset.sha256}. Nothing installed.`);
    log('sha256   matches the pinned value');

    const att = gh(['attestation', 'verify', archive, '--repo', CCCC.repo, '--signer-workflow', CCCC.workflow]);
    const unsupported = !att.ok && /unknown command|accepts .* arg/i.test(att.err);
    if (!att.ok && !unsupported) throw new Error(`attestation check failed: ${att.err.split('\n')[0]}. Nothing installed.`);
    log(att.ok ? `attested built by ${CCCC.workflow}` : 'attested no: this gh has no attestation command. Installed on the pinned sha256 alone.');

    const out = join(tmp, 'x');
    mkdirSync(out);
    const tar = spawnSync('tar', ['-xf', archive, '-C', out], { encoding: 'utf8', windowsHide: true });
    if (tar.status !== 0) throw new Error(`could not unpack ${asset.file}: ${(tar.stderr ?? '').trim().split('\n')[0]}`);
    const bin = findFile(out, exe());
    if (!bin) throw new Error(`${asset.file} holds no ${exe()}`);

    const dest = installDir();
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(bin, join(dest, exe()));
    chmodSync(join(dest, exe()), 0o755);
    const version = versionOf(join(dest, exe()));
    if (version !== CCCC.version) throw new Error(`installed binary reports version ${version ?? 'none'}, expected ${CCCC.version}`);
    const receipt: Receipt = {
      tool: CCCC.name, version, source: `https://github.com/${CCCC.repo}/releases/download/${tag}/${asset.file}`,
      asset: asset.file, sha256: sum, attested: att.ok, signerWorkflow: CCCC.workflow, installedAt: new Date().toISOString(),
    };
    writeFileSync(join(dest, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    log(`installed ${join(dest, exe())}`);
    return receipt;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface CcccFunction { name: string; kind: string; line: number; cognitive: number; cyclomatic: number; children?: CcccFunction[] }
export interface CcccFile { path: string; functions?: CcccFunction[]; parse_errors?: string[] }

/** Run cccc on named files under `root`. Config, ignore files and its cache are off, so only the files decide the result. */
export function measure(bin: string, root: string, files: string[]): CcccFile[] {
  const out: CcccFile[] = [];
  for (let i = 0; i < files.length; i += 200) {
    const r = spawnSync(bin, ['--no-config', '--no-ignore', '--no-cache', '--', ...files.slice(i, i + 200)], {
      cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: '1' },
    });
    if (r.status !== 0) throw new Error(`cccc exited with ${r.status ?? r.signal}: ${(r.stderr ?? '').trim().slice(0, 200)}`);
    out.push(...((JSON.parse(r.stdout) as { files?: CcccFile[] }).files ?? []));
  }
  return out;
}
