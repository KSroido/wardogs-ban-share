#!/usr/bin/env node
/**
 * Fails the build if anything that looks like a live credential is committed.
 *
 * This repo is public. Cloudflare and GitHub tokens belong in the dashboard
 * (Workers secrets) or in your password manager, never in a file.
 */
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

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;

    const path = join(dir, entry.name);
    const info = await stat(path);
    if (info.size > 2_000_000) continue;

    const buffer = await readFile(path);
    if (buffer.includes(0)) continue;

    const lines = buffer.toString('utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of PATTERNS) {
        if (pattern.regex.test(line)) {
          findings.push(`${relative(ROOT, path)}:${index + 1}  ${pattern.name}`);
        }
      }
    });
  }
}

await walk(ROOT);

if (findings.length > 0) {
  console.error('Refusing to continue: credential-like strings found in the working tree.\n');
  for (const finding of findings) console.error(`  ${finding}`);
  console.error('\nRemove the secret, rotate it, and use `wrangler secret put` instead.');
  process.exit(1);
}

console.log('check-secrets: no credential patterns found.');
