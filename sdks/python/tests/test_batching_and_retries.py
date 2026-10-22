"""Batching, retry and failure-mode coverage for the Python SDK.

The behaviour under test is what a 24/7 server actually depends on:
  - a batch over 100 is split, and duplicate/error indexes stay correct across chunks
  - a group key always sends server_id
  - 429/5xx are retried before giving up
  - a dead network surfaces as BanListError(code="network_error"), not a raw OSError
  - lookups are chunked at 50 ids
"""

import json
import socket
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from wardogs_banlist import BanListClient, BanListError


def ban_payload(steam_id="76561198000000001", ban_id="ban_1"):
    return {
        "id": ban_id,
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
        "reports": {"steam_id": steam_id, "server_count": 1, "active_server_count": 1,
                    "ban_count": 1, "active_ban_count": 1, "permanent_count": 1,
                    "reason_counts": {"cheat": 1}},
    }


def empty_page():
    return {"data": [], "next_cursor": None, "has_more": False,
            "server_time": "2026-10-01T00:00:00.000Z"}


class State:
    def __init__(self):
        self.requests = []
        self.responders = []
        self.lock = threading.Lock()

    def next_response(self, method, path, query, body):
        with self.lock:
            index = len(self.requests) - 1
        responder = self.responders[min(index, len(self.responders) - 1)]
        return responder(method, path, query, body)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
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
            state.requests.append({"method": method, "path": parsed.path,
                                   "query": parse_qs(parsed.query), "body": body})
        status, payload = state.next_response(method, parsed.path, parse_qs(parsed.query), body)
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class Server(ThreadingHTTPServer):
    daemon_threads = True


def make_ban(steam_id, case_id):
    return {"steam_id": steam_id, "reason": "cheat", "permanent": True,
            "external_case_id": case_id}


class BatchingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(("127.0.0.1", 0), Handler)
        cls.server.state = State()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.state = self.server.state
        self.state.requests = []
        self.state.responders = []
        self.client = BanListClient(self.base, "wdb_test_key", retries=0)

    def test_submit_splits_at_100_and_shifts_duplicate_indexes(self):
        def first(*_):
            return 201, {"created": [ban_payload(ban_id="ban_a")], "duplicates": [], "errors": []}

        def second(*_):
            return 207, {"created": [], "duplicates": [
                {"index": 0, "id": "ban_dup", "steam_id": "76561198000000001",
                 "reason": "cheat", "status": "active"}], "errors": []}

        self.state.responders = [first, second]

        bans = [make_ban("7656119%010d" % i, "case-%d" % i) for i in range(150)]
        result = self.client.submit_bans(bans)

        self.assertEqual(len(self.state.requests), 2, "150 bans must go out as 100 + 50")
        self.assertEqual(len(self.state.requests[0]["body"]["bans"]), 100)
        self.assertEqual(len(self.state.requests[1]["body"]["bans"]), 50)
        self.assertEqual(self.state.requests[1]["body"]["bans"][0]["external_case_id"], "case-100")
        self.assertEqual(len(result.created), 1)
        self.assertEqual(len(result.duplicates), 1)
        self.assertEqual(result.duplicates[0]["index"], 100,
                         "index from the second chunk must be offset by 100")

    def test_group_key_always_sends_server_id(self):
        self.state.responders = [
            lambda *_: (201, {"created": [ban_payload()], "duplicates": [], "errors": []})
        ]
        self.client.submit_bans([make_ban("76561198000000001", "case-1")], server_id="wardogs-main")

        body = self.state.requests[0]["body"]
        self.assertEqual(body.get("server_id"), "wardogs-main")

    def test_single_server_key_sends_no_server_id(self):
        self.state.responders = [
            lambda *_: (201, {"created": [ban_payload()], "duplicates": [], "errors": []})
        ]
        self.client.submit_bans([make_ban("76561198000000001", "case-1")])
        self.assertNotIn("server_id", self.state.requests[0]["body"])

    def test_retries_5xx_then_succeeds(self):
        client = BanListClient(self.base, "wdb_test_key", retries=2)
        self.state.responders = [
            lambda *_: (500, {"error": {"code": "internal", "message": "boom"}}),
            lambda *_: (201, {"created": [ban_payload()], "duplicates": [], "errors": []}),
        ]

        result = client.submit_bans([make_ban("76561198000000001", "case-1")])
        self.assertEqual(len(self.state.requests), 2, "a 500 must be retried")
        self.assertEqual(len(result.created), 1)

    def test_retries_429_then_succeeds(self):
        client = BanListClient(self.base, "wdb_test_key", retries=1)
        self.state.responders = [
            lambda *_: (429, {"error": {"code": "rate_limited", "message": "slow down"}}),
            lambda *_: (201, {"created": [ban_payload()], "duplicates": [], "errors": []}),
        ]

        result = client.submit_bans([make_ban("76561198000000001", "case-1")])
        self.assertEqual(len(self.state.requests), 2)
        self.assertEqual(len(result.created), 1)

    def test_gives_up_after_retries_and_preserves_the_error_code(self):
        client = BanListClient(self.base, "wdb_test_key", retries=2)
        self.state.responders = [
            lambda *_: (503, {"error": {"code": "unavailable", "message": "nope"}})
        ]

        with self.assertRaises(BanListError) as caught:
            client.list_bans(limit=1)

        self.assertEqual(len(self.state.requests), 3, "one try plus two retries")
        self.assertEqual(caught.exception.code, "unavailable")

    def test_4xx_is_not_retried(self):
        self.state.responders = [
            lambda *_: (401, {"error": {"code": "unauthorized", "message": "Unknown API key."}})
        ]
        with self.assertRaises(BanListError) as caught:
            self.client.list_bans(limit=1)

        self.assertEqual(len(self.state.requests), 1, "401 must fail immediately")
        self.assertEqual(caught.exception.code, "unauthorized")

    def test_lookup_splits_at_50(self):
        self.state.responders = [lambda *_: (200, empty_page())]
        ids = ["7656119%010d" % i for i in range(120)]

        self.client.lookup_steam_ids(ids)

        self.assertEqual(len(self.state.requests), 3, "120 ids must go out as 50 + 50 + 20")
        sizes = [len(r["query"]["steam_id"][0].split(",")) for r in self.state.requests]
        self.assertEqual(sizes, [50, 50, 20])
        self.assertTrue(all(r["query"]["status"] == ["active"] for r in self.state.requests))

    def test_dead_endpoint_raises_ban_list_error_not_os_error(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()

        client = BanListClient("http://127.0.0.1:%d" % port, "wdb_test_key", retries=0, timeout=1.0)
        with self.assertRaises(BanListError) as caught:
            client.list_bans(limit=1)

        self.assertEqual(caught.exception.code, "network_error")
        self.assertEqual(caught.exception.status, 0)

    def test_get_player_rejects_a_non_steam_id_locally(self):
        with self.assertRaises(ValueError):
            self.client.get_player("12345")
        self.assertEqual(self.state.requests, [], "a malformed id must not hit the network")

    def test_empty_batch_is_rejected_locally(self):
        with self.assertRaises(ValueError):
            self.client.submit_bans([])
        self.assertEqual(self.state.requests, [])


if __name__ == "__main__":
    unittest.main()
