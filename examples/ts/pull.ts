/**
 * Pull bans and print them, newest first.
 *
 *   BANLIST_KEY=wdb_... npx tsx pull.ts
 *   BANLIST_KEY=wdb_... npx tsx pull.ts 2026-10-01T00:00:00.000Z
 *
 * The optional argument is an ISO timestamp: only bans updated after it are
 * returned. Store the newest `updated_at` you see and pass it next time; that is
 * the whole incremental sync. Keep `status: 'all'` so revocations reach you.
 */
import { BanListClient, type Ban } from '@wardogs/banlist';

const client = new BanListClient({
  baseUrl: process.env.BANLIST_URL ?? 'https://wardogs.ksroido.art/api/ban-share',
  apiKey: requireEnv('BANLIST_KEY'),
});

const since = process.argv[2];
const bans: Ban[] = [];

for await (const ban of client.iterateBans({ status: 'all', since, limit: 500 })) {
  bans.push(ban);
}

console.log(`${bans.length} ban record(s)${since ? ` updated after ${since}` : ''}\n`);

const rows = bans
  .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  .map((ban) => ({
    steam_id: ban.steam_id,
    reason: ban.reason,
    'reported by': ban.server.name,
    servers: ban.reports.server_count,
    duration: ban.permanent ? 'permanent' : `${ban.duration_days}d`,
    status: ban.status,
    uploaded: ban.created_at,
    case: ban.id,
  }));

console.table(rows);

console.log('\nmost reported players:');
console.table(
  (await client.listPlayers({ limit: 5 })).data.map((player) => ({
    steam_id: player.steam_id,
    servers: player.server_count,
    active: player.active_ban_count,
    permanent: player.permanent_count,
    last: player.last_reported_at,
  })),
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Export the read key your server was issued.`);
    process.exit(1);
  }
  return value;
}
