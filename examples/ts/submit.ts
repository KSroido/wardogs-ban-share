/**
 * Submit bans to the federation.
 *
 *   BANLIST_KEY=wdb_... npx tsx submit.ts
 *
 * The key is bound to your server. The server id is never sent by the client:
 * the Worker derives it from the key, so a leaked key cannot post as someone else.
 */
import { BanListClient, type SubmitBanInput } from '@wardogs/banlist';

const client = new BanListClient({
  baseUrl: process.env.BANLIST_URL ?? 'https://wardogs.ksroido.art/api/ban-share',
  apiKey: requireEnv('BANLIST_KEY'),
});

const bans: SubmitBanInput[] = [
  {
    steam_id: '76561198000000001',
    reason: 'cheat',
    permanent: true,
    player_name: 'example_player',
    note: 'Aimbot, caught on spectator camera at 12:31.',
    evidence_url: 'https://example.com/clips/aimbot-1231.mp4',
    // Your own case id makes retries safe: the same id never creates a second ban.
    external_case_id: 'case-2026-10-19-001',
  },
  {
    steam_id: '76561198000000002',
    reason: 'chattroll',
    permanent: false,
    duration_days: 7,
    note: 'Repeated slurs in global chat after two warnings.',
    external_case_id: 'case-2026-10-19-002',
  },
];

const result = await client.submitBans(bans);

console.log(`created: ${result.created.length}`);
for (const ban of result.created) {
  console.log(
    `  ${ban.id}  ${ban.steam_id}  ${ban.reason}  ` +
      `${ban.permanent ? 'permanent' : `${ban.duration_days} days`}  ` +
      `(reported by ${ban.reports.server_count} server(s))`,
  );
}

if (result.duplicates.length > 0) {
  console.log(`already on file: ${result.duplicates.length}`);
  for (const dup of result.duplicates) {
    console.log(`  [${dup.index}] ${dup.steam_id} -> existing ban ${dup.id} (${dup.status})`);
  }
}

if (result.errors.length > 0) {
  console.log(`rejected: ${result.errors.length}`);
  for (const error of result.errors) {
    console.log(`  [${error.index}] ${error.code}: ${error.message}`);
  }
  process.exitCode = 1;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Export the key your server was issued.`);
    process.exit(1);
  }
  return value;
}
