#!/usr/bin/env node
/**
 * Maintainer CLI.
 *
 * Talks to the /admin routes, so it works locally and in production:
 *
 *   BANLIST_ADMIN_URL=https://wardogs.ksroido.art ADMIN_TOKEN=... \
 *     node scripts/admin.mjs create-server --name "Wardogs Main" --id wardogs-main
 *
 * The ADMIN_TOKEN is a Worker secret. It is never stored in this repo.
 */
import { argv, env, exit } from 'node:process';

const BASE = (env.BANLIST_ADMIN_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADMIN_PREFIX = '/api/ban-share/admin';
const TOKEN = env.ADMIN_TOKEN;

const [, , command, ...rest] = argv;
const { flags, positionals } = parseFlags(rest);

const commands = {
  servers: {
    help: 'list member servers',
    run: () => request('GET', '/servers'),
  },
  'create-server': {
    help: 'create a member server: --name <name> --location <geo> [--id <slug>] [--owner <admin>] [--note <text>]',
    run: () => {
      const name = required('name');
      return request('POST', '/servers', {
        name,
        id: flags.id,
        owner: flags.owner,
        location: required('location'),
        note: flags.note,
      });
    },
  },
  'set-status': {
    help: 'activate or defederate: --server <id> --status active|defederated',
    run: () =>
      request('PATCH', `/servers/${required('server')}`, {
        status: required('status'),
      }),
  },
  'issue-key': {
    help: 'issue a key: --server <id> [--label <text>] [--scopes bans:read,bans:write] [--group]',
    run: () =>
      request('POST', `/servers/${required('server')}/keys`, {
        label: flags.label,
        scopes: flags.scopes,
        // --group：发「同管理方 + 同位置」所有服共用的 key
        group: flags.group === true || flags.group === 'true' ? true : undefined,
      }),
  },
  keys: {
    help: 'list keys of a server: --server <id>',
    run: () => request('GET', `/servers/${required('server')}/keys`),
  },
  'revoke-key': {
    help: 'revoke one key: --id <key id>',
    run: () => request('POST', `/keys/${required('id')}/revoke`),
  },
  'revoke-ban': {
    help: 'emergency unban: --id <ban id> [--reason <text>]',
    run: () =>
      request('POST', `/bans/${required('id')}/revoke`, {
        reason: flags.reason,
      }),
  },
  reindex: {
    help: 'rebuild player_stats from the ban records',
    run: () => request('POST', '/reindex'),
  },
  player: {
    help: 'one player aggregate: --steam-id <steamid64>',
    run: () => request('GET', `/players/${required('steam-id')}`),
  },
  audit: {
    help: 'recent writes: [--limit 100] [--action ban.create]',
    run: () =>
      request('GET', `/audit?limit=${flags.limit ?? 100}${flags.action ? `&action=${encodeURIComponent(flags.action)}` : ''}`),
  },
  health: {
    help: 'check the API',
    run: async () => {
      const response = await fetch(`${BASE}/api/ban-share/health`);
      return response.json();
    },
  },
};

if (!command || command === 'help' || command === '--help') {
  console.log('Usage: node scripts/admin.mjs <command> [flags]\n');
  for (const [name, entry] of Object.entries(commands)) {
    console.log(`  ${name.padEnd(14)} ${entry.help}`);
  }
  console.log('\nEnvironment: ADMIN_TOKEN (required), BANLIST_ADMIN_URL (default http://127.0.0.1:8787)');
  exit(0);
}

const entry = commands[command];
if (!entry) {
  console.error(`Unknown command "${command}". Try: node scripts/admin.mjs help`);
  exit(1);
}

if (!TOKEN) {
  console.error('Missing ADMIN_TOKEN. It is the Worker secret, never a file in this repo.');
  exit(1);
}

try {
  const result = await entry.run();
  print(command, result);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
}

// ---------------------------------------------------------------- helpers

async function request(method, path, body) {
  const response = await fetch(`${BASE}${ADMIN_PREFIX}${path}`, {
    method,
    headers: {
      'x-admin-token': TOKEN,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const payload = text ? tryJson(text) : null;

  if (!response.ok) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`${message} (${payload?.error?.code ?? 'error'}, request ${payload?.request_id ?? '?'})`);
  }

  return payload;
}

function print(name, payload) {
  if (name === 'issue-key' && payload?.key) {
    console.log('\n  API key (shown once, store it now):\n');
    console.log(`    ${payload.key}\n`);
    console.log(`  server: ${payload.server_id}`);
    console.log(`  scopes: ${payload.scopes.join(' ')}`);
    console.log(`  key id: ${payload.id}\n`);
    console.log('  If it leaks: node scripts/admin.mjs revoke-key --id ' + payload.id);
    return;
  }

  if (name === 'servers' || name === 'keys' || name === 'audit') {
    const rows = payload?.data ?? [];
    console.log(`\n${rows.length} row(s)\n`);
    console.table(rows);
    return;
  }

  console.log(JSON.stringify(payload, null, 2));
}

function parseFlags(args) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { flags, positionals };
}

function required(name) {
  const value = flags[name];
  if (!value || value === true) {
    console.error(`Missing --${name}`);
    exit(1);
  }
  return value;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
