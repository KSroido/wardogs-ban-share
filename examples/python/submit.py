#!/usr/bin/env python3
"""Submit bans to the federation.

    BANLIST_KEY=wdb_... python examples/python/submit.py

The key is bound to your server. The Worker derives the server id from the key,
so a leaked key can never post on behalf of another member.
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
        print("Missing BANLIST_KEY. Export the key your server was issued.", file=sys.stderr)
        return 1

    client = BanListClient(
        os.environ.get("BANLIST_URL", "https://wardogs.ksroido.art/api/ban-share"),
        key,
    )

    bans = [
        {
            "steam_id": "76561198000000001",
            "reason": "cheat",
            "permanent": True,
            "player_name": "example_player",
            "note": "Aimbot, caught on spectator camera at 12:31.",
            "evidence_url": "https://example.com/clips/aimbot-1231.mp4",
            "external_case_id": "case-2026-10-19-001",
        },
        {
            "steam_id": "76561198000000002",
            "reason": "chattroll",
            "permanent": False,
            "duration_days": 7,
            "note": "Repeated slurs in global chat after two warnings.",
            "external_case_id": "case-2026-10-19-002",
        },
    ]

    result = client.submit_bans(bans)

    print("created: %d" % len(result.created))
    for ban in result.created:
        print(
            "  %s  %s  %s  %s  (reported by %d server(s))"
            % (
                ban.id,
                ban.steam_id,
                ban.reason,
                ban.duration_label,
                ban.reports.server_count,
            )
        )

    for duplicate in result.duplicates:
        print(
            "  [%s] %s already on file as %s"
            % (duplicate.get("index"), duplicate.get("steam_id"), duplicate.get("id"))
        )

    for error in result.errors:
        print("  [%s] %s: %s" % (error.get("index"), error.get("code"), error.get("message")))

    return 1 if result.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
