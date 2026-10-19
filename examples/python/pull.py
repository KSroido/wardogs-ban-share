#!/usr/bin/env python3
"""Pull bans and print them, newest first.

    BANLIST_KEY=wdb_... python examples/python/pull.py
    BANLIST_KEY=wdb_... python examples/python/pull.py 2026-10-01T00:00:00.000Z

The optional argument is an ISO timestamp: only bans updated after it are
returned. Store the newest `updated_at` you see and pass it next time; that is
the whole incremental sync. Keep status="all" so revocations reach you.
"""

import os
import pathlib
import sys

# Runnable straight from the repo, without installing the package.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "sdks" / "python"))

from wardogs_banlist import BanListClient  # noqa: E402


def main() -> int:
    key = os.environ.get("BANLIST_KEY")
    if not key:
        print("Missing BANLIST_KEY. Export the read key your server was issued.", file=sys.stderr)
        return 1

    client = BanListClient(
        os.environ.get("BANLIST_URL", "https://wardogs.ksroido.art/api/ban-share"),
        key,
    )

    since = sys.argv[1] if len(sys.argv) > 1 else None
    query = {"status": "all", "limit": 500}
    if since:
        query["since"] = since

    bans = list(client.iter_bans(**query))
    bans.sort(key=lambda ban: ban.updated_at, reverse=True)

    print("%d ban record(s)%s\n" % (len(bans), " updated after %s" % since if since else ""))
    print(
        "%-18s  %-10s  %-16s  %-5s  %-8s  %-9s  %s"
        % ("steam_id", "reason", "reported by", "srv", "duration", "status", "uploaded")
    )
    print("-" * 110)

    for ban in bans:
        print(
            "%-18s  %-10s  %-16s  %-5d  %-8s  %-9s  %s"
            % (
                ban.steam_id,
                ban.reason,
                ban.server.name[:16],
                ban.reports.server_count,
                ban.duration_label,
                ban.status,
                ban.created_at,
            )
        )

    print("\nmost reported players:")
    for player in client.list_players(limit=5).data:
        print(
            "  %s  servers=%d active=%d permanent=%d"
            % (player.steam_id, player.server_count, player.active_ban_count, player.permanent_count)
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
