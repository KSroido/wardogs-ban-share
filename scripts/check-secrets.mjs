#!/usr/bin/env node
/**
 * Fails the build if anything that would land in the repo contains a live credential.
 *
 * This repo is public. Cloudflare and GitHub tokens belong in the dashboard
 * (Workers secrets) or in your password manager, never in a file.
 *
 * Scope: files git would actually publish — tracked files plus untracked files that are
 * not gitignored. Local scratch (ignored dirs such as opencode-history/ or *.local.json)
 * is out of scope: it never reaches the remote, so scanning it only produces false
 * positives on dumps of old chat logs. Outside a git work tree we fall back to walking
 * the directory, skipping the usual vendor/build dirs.
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.wrangler',
  '__pycache__',
  '.venv',
  'venv',
  'bin',
]);

const PATTERNS = [
  { name: 'Cloudflare API token', regex: /\bcfut_[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'GitHub fine-grained token', regex: /\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { name: 'OpenAI style key', regex: /\bsk-[A-Za-z0-9]{32,}/ },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  // API keys issued by this project: wdb_ + 43 base64url chars.
  { name: 'Wardogs server key', regex: /\bwdb_[A-Za-z0-9_-]{40,}/ },
];

const findings = [];

/** Files git would publish: tracked + untracked-but-not-ignored. */
function gitVisibleFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return [...new Set(out.split('\0').filter(Boolean))];
}

async function walk(dir, acc) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), acc);
      continue;
    }
    if (entry.isFile()) acc.push(relative(ROOT, join(dir, entry.name)));
  }
  return acc;
}

async function scan(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return; // tracked but deleted in the working tree
  }
  if (!info.isFile() || info.size > 2_000_000) return;

  const buffer = await readFile(path);
  if (buffer.includes(0)) return;

  const lines = buffer.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push(`${relative(ROOT, path)}:${index + 1}  ${pattern.name}`);
      }
    }
  });
}

let files;
let scope;
try {
  files = gitVisibleFiles();
  scope = 'git-visible files';
} catch {
  files = await walk(ROOT, []);
  scope = 'working tree (not a git checkout)';
}

for (const file of files) await scan(join(ROOT, file));

if (findings.length > 0) {
  console.error(`Refusing to continue: credential-like strings found in ${scope}.\n`);
  for (const finding of findings) console.error(`  ${finding}`);
  console.error('\nRemove the secret, rotate it, and use `wrangler secret put` instead.');
  process.exit(1);
}

console.log(`check-secrets: no credential patterns found (${scope}, ${files.length} files).`);
