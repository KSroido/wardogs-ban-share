"""本地白名单：命中时必须是 0 次 HTTP。

这里把 ``urllib.request.urlopen`` 换成可计数的假实现，
断言白名单命中的路径完全没有碰到网络。
"""

import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from wardogs_banlist import BanListClient, Whitelist

BASE_URL = "https://bans.test"
API_KEY = "wdb_test_key"
WHITELISTED = "76561198000000001"
OTHER = "76561198000000002"


def ban_payload(steam_id):
    return {
        "id": "ban_1",
        "server": {"id": "demo", "name": "Demo Server"},
        "steam_id": steam_id,
        "player_name": None,
        "reason": "cheat",
        "note": None,
        "evidence_url": None,
        "permanent": True,
        "duration_days": None,
        "expires_at": None,
        "status": "active",
        "external_case_id": None,
        "created_at": "2026-10-01T00:00:00.000Z",
        "updated_at": "2026-10-01T00:00:00.000Z",
        "revoked_at": None,
        "revoke_reason": None,
        "reports": {
            "steam_id": steam_id,
            "server_count": 2,
            "active_server_count": 1,
            "ban_count": 2,
            "active_ban_count": 1,
            "permanent_count": 1,
            "reason_counts": {"cheat": 1},
            "first_reported_at": "2026-09-01T00:00:00.000Z",
            "last_reported_at": "2026-10-01T00:00:00.000Z",
            "updated_at": "2026-10-01T00:00:00.000Z",
        },
    }


class FakeResponse:
    def __init__(self, payload):
        self._raw = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class WhitelistTest(unittest.TestCase):
    def setUp(self):
        self.urlopen = mock.patch("wardogs_banlist.client.request.urlopen").start()
        self.addCleanup(mock.patch.stopall)

    def client(self, whitelist=None):
        return BanListClient(BASE_URL, API_KEY, retries=0, whitelist=whitelist)

    def respond(self, payload):
        self.urlopen.return_value = FakeResponse(payload)

    def seen_url(self):
        return self.urlopen.call_args[0][0].full_url

    # -------------------------------------------------------------- 短路

    def test_get_player_returns_local_detail_without_http(self):
        client = self.client([WHITELISTED])

        player = client.get_player(WHITELISTED)

        self.assertEqual(self.urlopen.call_count, 0)
        self.assertEqual(player.steam_id, WHITELISTED)
        self.assertTrue(player.whitelisted)
        self.assertEqual(player.bans, [])
        self.assertEqual(player.reports.server_count, 0)
        self.assertEqual(player.reports.ban_count, 0)
        self.assertEqual(player.reports.reason_counts, {})
        self.assertIsNone(player.reports.first_reported_at)

    def test_get_player_still_queries_for_others(self):
        self.respond({"steam_id": OTHER, "reports": ban_payload(OTHER)["reports"], "bans": [ban_payload(OTHER)]})
        client = self.client([WHITELISTED])

        player = client.get_player(OTHER)

        self.assertEqual(self.urlopen.call_count, 1)
        self.assertFalse(player.whitelisted)
        self.assertEqual(len(player.bans), 1)
        self.assertEqual(player.reports.server_count, 2)

    def test_lookup_skips_whitelisted_ids(self):
        self.respond(
            {
                "data": [ban_payload(OTHER)],
                "next_cursor": None,
                "has_more": False,
                "server_time": "2026-10-01T00:00:00.000Z",
            }
        )
        client = self.client([WHITELISTED])

        bans = client.lookup_steam_ids([WHITELISTED, OTHER])

        self.assertEqual(self.urlopen.call_count, 1)
        self.assertIn("steam_id=" + OTHER, self.seen_url())
        self.assertNotIn(WHITELISTED, self.seen_url())
        self.assertEqual([ban.steam_id for ban in bans], [OTHER])

    def test_lookup_makes_no_request_when_every_id_is_whitelisted(self):
        client = self.client([WHITELISTED, OTHER])

        bans = client.lookup_steam_ids([WHITELISTED, OTHER])

        self.assertEqual(self.urlopen.call_count, 0)
        self.assertEqual(bans, [])

    def test_list_bans_returns_local_empty_page_for_whitelisted_filter(self):
        client = self.client([WHITELISTED])

        page = client.list_bans(steam_id=[WHITELISTED], status="all")

        self.assertEqual(self.urlopen.call_count, 0)
        self.assertEqual(page.data, [])
        self.assertFalse(page.has_more)
        self.assertIsNone(page.next_cursor)

    def test_list_bans_narrows_mixed_filter(self):
        self.respond({"data": [], "next_cursor": None, "has_more": False, "server_time": "x"})
        client = self.client([WHITELISTED])

        client.list_bans(steam_id=[WHITELISTED, OTHER])

        url = self.seen_url()
        self.assertIn("steam_id=" + OTHER, url)
        self.assertNotIn(WHITELISTED, url)
        self.assertEqual(self.urlopen.call_count, 1)

    def test_iter_bans_yields_nothing_for_whitelisted_filter(self):
        client = self.client([WHITELISTED])

        bans = list(client.iter_bans(steam_id=[WHITELISTED], status="all"))

        self.assertEqual(bans, [])
        self.assertEqual(self.urlopen.call_count, 0)

    # ---------------------------------------------------------- partition

    def test_partition_dedupes_and_keeps_order(self):
        client = self.client({WHITELISTED})

        parts = client.partition_steam_ids([OTHER, WHITELISTED, OTHER, WHITELISTED])

        self.assertEqual(parts.whitelisted, [WHITELISTED])
        self.assertEqual(parts.others, [OTHER])

    def test_empty_whitelist_means_everything_is_queried(self):
        client = self.client([])

        parts = client.partition_steam_ids([WHITELISTED, OTHER])

        self.assertEqual(parts.whitelisted, [])
        self.assertEqual(parts.others, [WHITELISTED, OTHER])

    # ------------------------------------------------------------- 来源

    def test_accepts_json_array_file(self):
        path = self.write_temp("wl.json", json.dumps([WHITELISTED]))
        client = self.client(path)

        self.assertTrue(client.is_whitelisted(WHITELISTED))
        self.assertEqual(client.whitelist_size, 1)

        client.get_player(WHITELISTED)
        self.assertEqual(self.urlopen.call_count, 0)

    def test_accepts_json_array_with_integers(self):
        path = self.write_temp("wl.json", "[76561198000000001]")

        whitelist = Whitelist(path)

        self.assertTrue(whitelist.has(WHITELISTED))

    def test_accepts_integer_entries_in_memory(self):
        whitelist = Whitelist([76561198000000001])

        self.assertTrue(whitelist.has(WHITELISTED))

    def test_rejects_non_string_entries(self):
        with self.assertRaises(ValueError):
            Whitelist([None])

    def test_accepts_line_file_with_comments(self):
        path = self.write_temp(
            "wl.txt", "# 手工维护\n\n76561198000000001\n   \n# 下一位\n76561198000000002\n"
        )

        whitelist = Whitelist(path)

        self.assertEqual(whitelist.size, 2)
        self.assertTrue(whitelist.has(WHITELISTED))
        self.assertTrue(whitelist.has(OTHER))
        self.assertEqual(whitelist.file_path, path)

    def test_reload_picks_up_edits(self):
        path = self.write_temp("wl.txt", WHITELISTED + "\n")
        client = self.client(path)

        self.assertFalse(client.is_whitelisted(OTHER))

        with open(path, "w", encoding="utf-8") as handle:
            handle.write("%s\n%s\n" % (WHITELISTED, OTHER))

        self.assertTrue(client.reload_whitelist())
        self.assertTrue(client.is_whitelisted(OTHER))
        self.assertEqual(client.whitelist_size, 2)

        client.get_player(OTHER)
        self.assertEqual(self.urlopen.call_count, 0)

    def test_reload_is_noop_for_memory_list(self):
        client = self.client([WHITELISTED])

        self.assertFalse(client.reload_whitelist())
        self.assertTrue(client.is_whitelisted(WHITELISTED))

    def test_set_whitelist_replaces_memory_list(self):
        client = self.client([WHITELISTED])

        client.set_whitelist([OTHER])

        self.assertFalse(client.is_whitelisted(WHITELISTED))
        self.assertTrue(client.is_whitelisted(OTHER))

    def test_invalid_json_array_raises(self):
        path = self.write_temp("wl.json", "[not json")

        with self.assertRaises(ValueError):
            Whitelist(path)

    # ----------------------------------------------------------- helpers

    def write_temp(self, name, content):
        directory = tempfile.mkdtemp(prefix="wardogs-whitelist-")
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        return path


if __name__ == "__main__":
    unittest.main()
