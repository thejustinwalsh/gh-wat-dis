import type { FileKind, Language } from './types.ts';

const LANG: Record<string, Language> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  rs: 'rust',
};
const CODE = new Set(['py', 'go', 'java', 'kt', 'kts', 'rb', 'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'm', 'mm', 'scala',
  'lua', 'sh', 'bash', 'zsh', 'ps1', 'ex', 'exs', 'erl', 'hs', 'ml', 'dart', 'vue', 'svelte', 'astro', 'zig', 'nim', 'r', 'jl', 'pl',
  'clj', 'groovy', 'gd', 'glsl', 'wgsl', 'hlsl', 'css', 'scss', 'less', 'html']);
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock',
  'Gemfile.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'composer.lock', 'deno.lock', 'flake.lock']);
const SKIP_DIR = /(^|\/)(node_modules|dist|build|target|vendor|\.git)\//;

export const extOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
};
export const languageOf = (path: string): Language | null => LANG[extOf(path)] ?? null;
export const MAX_PARSE_BYTES = 500 * 1024;
/** Files the AST tier never parses. */
export const isSkipped = (path: string): boolean => SKIP_DIR.test(path) || /\.min\.[cm]?js$/.test(path);

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|__mocks__|spec|specs|e2e|benches)\//.test(path)
    || /\.(test|spec|e2e)\.[a-z]+$/.test(path) || /_test\.[a-z]+$/.test(path) || /(^|\/)test_[^/]+\.py$/.test(path);
}

export function kindOf(path: string): FileKind {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const ext = extOf(path);
  if (LOCKFILES.has(base)) return 'lockfile';
  if (base === 'package.json' || base === 'Cargo.toml') return 'manifest';
  if (SKIP_DIR.test(path) || /(^|\/)(__generated__|generated)\//.test(path)
    || /\.(generated|gen|pb|g)\.[a-z]+$/.test(base) || /_pb2\.py$/.test(base) || /\.min\.(js|css)$/.test(base) || ext === 'map' || ext === 'snap') return 'generated';
  if (/^\.github\/(workflows|actions)\//.test(path) || /^\.(circleci|buildkite)\//.test(path)
    || /^(\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.yml|\.travis\.yml)$/.test(base)) return 'ci';
  if (/(^|\/)(migrations?|migrate)\//.test(path)) return 'migration';
  if (['proto', 'graphql', 'gql', 'sql', 'prisma'].includes(ext) || /^(openapi|swagger)\.[a-z]+$/.test(base)) return 'schema';
  if (isTestPath(path)) return 'test';
  if (['md', 'mdx', 'rst', 'txt', 'adoc'].includes(ext) || /^docs?\//.test(path) || /^(LICENSE|NOTICE|AUTHORS|CHANGELOG)$/i.test(base)) return 'docs';
  if (/\.config\.[cm]?[jt]s$/.test(base) || ['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'xml'].includes(ext)
    || base.startsWith('.') || /^(Dockerfile|Makefile|Justfile|CODEOWNERS)/.test(base)) return 'config';
  if (LANG[ext] || CODE.has(ext)) return 'source';
  return 'other';
}

export function schemaKind(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const ext = extOf(path);
  if (ext === 'proto') return 'protobuf';
  if (ext === 'graphql' || ext === 'gql') return 'graphql';
  if (/^(openapi|swagger)\./.test(base)) return 'openapi';
  if (ext === 'sql') return 'sql';
  if (ext === 'prisma') return 'prisma';
  return 'schema';
}
