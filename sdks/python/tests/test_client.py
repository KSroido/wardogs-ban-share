import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from wardogs_banlist import BanListClient, BanListError


def ban_payload(**overrides):
    payload = {
        "id": "ban_1",
        "server": {"id": "demo", "name": "Demo Server"},
        "steam_id": "76561198000000001",
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
            "steam_id": "76561198000000001",
            "server_count": 2,
            "active_server_count": 1,
            "ban_count": 2,
            "active_ban_count": 1,
            "permanent_count": 1,
            "reason_counts": {"cheat": 1, "chattroll": 1},
            "first_reported_at": "2026-09-01T00:00:00.000Z",
            "last_reported_at": "2026-10-01T00:00:00.000Z",
            "updated_at": "2026-10-01T00:00:00.000Z",
        },
    }
    payload.update(overrides)
    return payload


class State:
    def __init__(self):
        self.requests = []
        self.responder = None
        self.lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep test output clean
        pass

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def _handle(self, method):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length else None

        state = self.server.state
        with state.lock:
            state.requests.append(
                {
                    "method": method,
                    "path": parsed.path,
                    "query": parse_qs(parsed.query),
                    "body": body,
                    "auth": self.headers.get("Authorization"),
                }
            )

        status, payload = state.responder(method, parsed.path, parse_qs(parsed.query), body)
        raw = json.dumps(payload).encode("utf-8")

        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class TestServer(ThreadingHTTPServer):
    daemon_threads = True


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = TestServer(("127.0.0.1", 0), Handler)
        cls.server.state = State()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.server.state.requests = []
        self.client = BanListClient(self.base_url, "wdb_test_key", retries=0)

    def test_submit_sends_key_and_parses_reports(self):
        self.server.state.responder = lambda *args: (
            201,
            {"created": [ban_payload()], "duplicates": [], "errors": []},
        )

        created = self.client.submit_ban(
            {
                "steam_id": "76561198000000001",
                "reason": "cheat",
                "permanent": True,
                "external_case_id": "case-1",
            }
        )

        request = self.server.state.requests[0]
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["path"], "/v1/bans")
        self.assertEqual(request["auth"], "Bearer wdb_test_key")
        self.assertEqual(request["body"]["bans"][0]["external_case_id"], "case-1")
        self.assertEqual(created.id, "ban_1")
        self.assertEqual(created.reports.server_count, 2)
        self.assertEqual(created.duration_label, "permanent")

    def test_duplicate_raises(self):
        self.server.state.responder = lambda *args: (
            200,
            {
                "created": [],
                "duplicates": [
                    {
                        "index": 0,
                        "id": "ban_9",
                        "steam_id": "76561198000000001",
                        "reason": "cheat",
                        "status": "active",
                    }
                ],
                "errors": [],
            },
        )

        with self.assertRaises(BanListError) as caught:
            self.client.submit_ban(
                {"steam_id": "76561198000000001", "reason": "cheat", "permanent": True}
            )

        self.assertEqual(caught.exception.code, "duplicate_ban")
        self.assertEqual(caught.exception.status, 409)

    def test_list_serialises_filters(self):
        self.server.state.responder = lambda *args: (
            200,
            {
                "data": [ban_payload()],
                "next_cursor": None,
                "has_more": False,
                "server_time": "2026-10-01T00:00:00.000Z",
            },
        )

        page = self.client.list_bans(
            status="all",
            reason=["cheat", "racism"],
            steam_id=["76561198000000001"],
            limit=9999,
        )

        query = self.server.state.requests[0]["query"]
        self.assertEqual(query["status"], ["all"])
        self.assertEqual(query["reason"], ["cheat,racism"])
        self.assertEqual(query["steam_id"], ["76561198000000001"])
        self.assertEqual(query["limit"], ["500"])
        self.assertEqual(page.data[0].duration_label, "permanent")

    def test_iter_follows_next_cursor(self):
        def responder(method, path, query, body):
            if "cursor" in query:
                return 200, {
                    "data": [ban_payload(id="ban_2")],
                    "next_cursor": None,
                    "has_more": False,
                    "server_time": "2026-10-01T00:00:00.000Z",
                }
            return 200, {
                "data": [ban_payload(id="ban_1")],
                "next_cursor": "cursor-2",
                "has_more": True,
                "server_time": "2026-10-01T00:00:00.000Z",
            }

        self.server.state.responder = responder
        ids = [ban.id for ban in self.client.iter_bans(status="all")]
        self.assertEqual(ids, ["ban_1", "ban_2"])
        self.assertEqual(
            self.server.state.requests[1]["query"]["cursor"], ["cursor-2"]
        )

    def test_error_envelope(self):
        self.server.state.responder = lambda *args: (
            403,
            {
                "error": {"code": "forbidden", "message": "A server may only revoke its own bans."},
                "request_id": "req_1",
            },
        )

        with self.assertRaises(BanListError) as caught:
            self.client.revoke_ban("ban_1")

        self.assertEqual(caught.exception.code, "forbidden")
        self.assertTrue(caught.exception.is_auth_error)

    def test_get_player_path(self):
        self.server.state.responder = lambda *args: (
            200,
            {
                "steam_id": "76561198000000001",
                "reports": ban_payload()["reports"],
                "bans": [ban_payload()],
            },
        )

        player = self.client.get_player("76561198000000001")
        self.assertEqual(player.reports.server_count, 2)
        self.assertEqual(len(player.bans), 1)
        self.assertEqual(
            self.server.state.requests[0]["path"], "/v1/players/76561198000000001"
        )


if __name__ == "__main__":
    unittest.main()
