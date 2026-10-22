#!/usr/bin/env node
/**
 * Build the three SDK release artifacts, gated on the full test suite.
 *
 *   node scripts/release.mjs                     # gates + build into dist/
 *   node scripts/release.mjs --no-build          # gates only (CI-style check)
 *   node scripts/release.mjs --allow-dirty       # build from a dirty tree (local poking)
 *   node scripts/release.mjs --version 0.1.2     # must match the manifests
 *
 * Every artifact in dist/ is only written after npm, Python and Go tests pass.
 * Uploading stays manual: this script never touches the network.
 *
 * Requires Node >= 20, Python (py -3 / python3, or WDB_PYTHON) and Go
 * (on PATH, or WDB_GO pointing at the binary).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const ALLOW_DIRTY = flag('allow-dirty');
const BUILD_ENABLED = !flag('no-build');
const OUT_DIR = resolve(ROOT, option('out', 'dist'));

const PYTHON = process.env.WDB_PYTHON ?? (IS_WINDOWS ? 'py -3' : 'python3');
const GO = process.env.WDB_GO ?? 'go';

let failures = 0;

function log(message = '') {
  console.log(message);
}

function step(name) {
  log(`\n=== ${name} ===`);
}

/** Run a command; throw on non-zero exit. */
function run(command, args, { cwd = ROOT, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    shell: !IS_WINDOWS || command === 'npm' || command === 'npx' || command.includes(' '),
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    env: process.env,
  });

  if (result.error) throw new Error(`${command} ${args.join(' ')} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    if (capture) {
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
  return (result.stdout ?? '').trim();
}

function gate(name, fn) {
  step(name);
  try {
    fn();
    log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---------------------------------------------------------------- preconditions

function resolveVersion() {
  const requested = option('version', null);
  const versions = {
    'packages/sdk-ts/package.json': readJson('packages/sdk-ts/package.json').version,
    'sdks/python/pyproject.toml': /^version = "([^"]+)"/m.exec(
      readFileSync(join(ROOT, 'sdks/python/pyproject.toml'), 'utf8'),
    )?.[1],
    'sdks/python/wardogs_banlist/__init__.py': /__version__ = "([^"]+)"/.exec(
      readFileSync(join(ROOT, 'sdks/python/wardogs_banlist/__init__.py'), 'utf8'),
    )?.[1],
  };

  const unique = new Set(Object.values(versions));
  if (unique.size !== 1) {
    const detail = Object.entries(versions).map(([file, v]) => `  ${file}: ${v}`).join('\n');
    throw new Error(`manifest versions disagree:\n${detail}`);
  }

  const version = [...unique][0];
  if (requested && requested !== version) {
    throw new Error(`--version ${requested} does not match the manifests (${version})`);
  }
  log(`version ${version}`);
  return version;
}

function assertCleanTree() {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!dirty) {
    log('working tree clean');
    return;
  }
  if (ALLOW_DIRTY) {
    log('WARNING: building from a dirty tree (--allow-dirty):');
    log(dirty.split('\n').map((line) => `  ${line}`).join('\n'));
    return;
  }
  throw new Error(`working tree is dirty, commit or stash first:\n${dirty}`);
}

// ---------------------------------------------------------------- test gates

function npmGates() {
  run('npm', ['run', 'check:secrets']);
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);
}

function pythonGates() {
  run(`${PYTHON} -m unittest discover -s tests`, [], { cwd: join(ROOT, 'sdks/python') });
}

function goGates() {
  const goDir = join(ROOT, 'sdks/go');
  run(GO, ['version']);
  run(GO, ['vet', './...'], { cwd: goDir });

  // `go fmt` has no -l; ask the toolchain where gofmt lives so PATH layout does not matter.
  const goroot = run(GO, ['env', 'GOROOT'], { cwd: goDir, capture: true });
  const gofmt = join(goroot, 'bin', IS_WINDOWS ? 'gofmt.exe' : 'gofmt');
  const unformatted = execFileSync(gofmt, ['-l', '.'], { cwd: goDir, encoding: 'utf8' }).trim();
  if (unformatted) throw new Error(`gofmt would rewrite:\n${unformatted}`);

  run(GO, ['test', './...', '-count=1'], { cwd: goDir });
}

// ---------------------------------------------------------------- artifacts

function buildTypeScript(version) {
  const sdkDir = join(ROOT, 'packages/sdk-ts');
  run('npm', ['run', 'build:sdk']);

  const staged = join(OUT_DIR, `.ts-${process.pid}`);
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  run('npm', ['pack', '--pack-destination', staged], { cwd: sdkDir });

  const packed = readdirSync(staged).find((name) => name.endsWith('.tgz'));
  if (!packed) throw new Error('npm pack produced no tarball');
  const target = join(OUT_DIR, `wardogs-banlist-${version}.tgz`);
  renameSync(join(staged, packed), target);

  // A tarball install reads the real manifest, not publishConfig, so point it at
  // the compiled output and drop the workspace-era indirection.
  const unpacked = join(OUT_DIR, `.ts-unpack-${process.pid}`);
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  run('tar', ['-xzf', target, '-C', unpacked]);

  const manifestPath = join(unpacked, 'package', 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!existsSync(join(unpacked, 'package', 'dist', 'index.js'))) {
    throw new Error('dist/index.js missing after build; the tarball would not import');
  }
  manifest.main = './dist/index.js';
  manifest.types = './dist/index.d.ts';
  manifest.exports = { '.': { types: './dist/index.d.ts', default: './dist/index.js' } };
  delete manifest.publishConfig;
  manifest.repository = {
    type: 'git',
    url: 'git+https://github.com/KSroido/wardogs-ban-share.git',
    directory: 'packages/sdk-ts',
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  rmSync(target, { force: true });
  run('tar', ['-czf', target, '-C', unpacked, 'package']);
  rmSync(unpacked, { recursive: true, force: true });
  rmSync(staged, { recursive: true, force: true });
  return target;
}

function buildPython(version) {
  const pythonOut = join(OUT_DIR, '.py');
  rmSync(pythonOut, { recursive: true, force: true });
  mkdirSync(pythonOut, { recursive: true });
  run(`${PYTHON} -m build --sdist --wheel --outdir "${pythonOut}"`, [], { cwd: join(ROOT, 'sdks/python') });

  const wheel = join(OUT_DIR, `wardogs_banlist-${version}-py3-none-any.whl`);
  const sdist = join(OUT_DIR, `wardogs_banlist-${version}.tar.gz`);
  renameSync(join(pythonOut, `wardogs_banlist-${version}-py3-none-any.whl`), wheel);
  renameSync(join(pythonOut, `wardogs_banlist-${version}.tar.gz`), sdist);
  rmSync(pythonOut, { recursive: true, force: true });
  return [wheel, sdist];
}

function buildGo(version) {
  const target = join(OUT_DIR, `wardogs-banlist-go-${version}.zip`);
  rmSync(target, { force: true });
  run(`${PYTHON} "${join(ROOT, 'scripts/zip-module.py')}" "${join(ROOT, 'sdks/go')}" "${target}"`);
  return target;
}

function writeChecksums(paths) {
  const lines = [...paths].sort().map((path) => `${sha256(path)}  ${path.split(/[\\/]/).pop()}`);
  const file = join(OUT_DIR, 'CHECKSUMS.txt');
  writeFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf8' });
  log(lines.join('\n'));
  return file;
}

// ---------------------------------------------------------------- main

function main() {
  console.log('wardogs-ban-share release\n');

  const version = resolveVersion();
  assertCleanTree();

  gate('node: secrets scan, typecheck, tests', npmGates);
  gate(`python: unittest (${PYTHON})`, pythonGates);
  gate(`go: vet, gofmt, test (${GO})`, goGates);

  if (!BUILD_ENABLED) {
    log('\n--no-build: every gate passed, nothing was packaged.');
    return;
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  step('packaging');
  const artifacts = [
    buildTypeScript(version),
    ...buildPython(version),
    buildGo(version),
  ];
  for (const path of artifacts) log(`built ${path}`);
  writeChecksums(artifacts);

  const tag = `v${version}`;
  log(`\nartifacts in ${OUT_DIR}`);
  log('\nupload with:');
  log(`  gh release create ${tag} --title "${tag}" --notes-file <notes> ${artifacts.map((p) => `"${p}"`).join(' ')} "${join(OUT_DIR, 'CHECKSUMS.txt')}"`);
  log('\ninstall lines for the README:');
  log(`  npm i https://github.com/KSroido/wardogs-ban-share/releases/download/${tag}/wardogs-banlist-${version}.tgz`);
  log(`  pip install https://github.com/KSroido/wardogs-ban-share/releases/download/${tag}/wardogs_banlist-${version}-py3-none-any.whl`);
  log(`  go get github.com/KSroido/wardogs-ban-share/sdks/go/banlist@${tag}`);
}

try {
  main();
} catch (error) {
  console.error(`\nrelease aborted: ${error.message}`);
  process.exit(1);
}

if (failures) process.exit(1);
