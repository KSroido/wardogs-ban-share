from __future__ import annotations

import json
import re
import time
from typing import Any, Dict, Iterable, Iterator, List, Optional
from urllib import error as urlerror
from urllib import parse, request

from .errors import BanListError
from .models import (
    Ban,
    ListBansResult,
    ListPlayersResult,
    PlayerDetail,
    Server,
    SubmitBansResult,
)

MAX_SUBMIT_BATCH = 100
MAX_STEAM_ID_LOOKUP = 50
MAX_PAGE_SIZE = 500
STEAM_ID_PATTERN = re.compile(r"^7656119\d{10}$")


class BanListClient:
    """Synchronous client. Safe to share between threads (no mutable state)."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 15.0,
        retries: int = 2,
        user_agent: str = "wardogs-banlist-python/0.1.0",
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        if not api_key:
            raise ValueError("api_key is required")

        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.retries = max(0, retries)
        self.user_agent = user_agent

    # ---------------------------------------------------------------- writes

    def submit_bans(self, bans: List[Dict[str, Any]]) -> SubmitBansResult:
        """Submit up to 100 bans. Larger lists are chunked and merged."""
        if not bans:
            raise ValueError("submit_bans requires at least one ban")

        created: List[Ban] = []
        duplicates: List[Dict[str, Any]] = []
        errors: List[Dict[str, Any]] = []

        for offset in range(0, len(bans), MAX_SUBMIT_BATCH):
            chunk = bans[offset : offset + MAX_SUBMIT_BATCH]
            payload = self._request("POST", "/v1/bans", body={"bans": chunk}) or {}

            created.extend(Ban.from_dict(item) for item in payload.get("created") or [])

            for item in payload.get("duplicates") or []:
                shifted = dict(item)
                shifted["index"] = int(shifted.get("index") or 0) + offset
                duplicates.append(shifted)

            for item in payload.get("errors") or []:
                shifted = dict(item)
                shifted["index"] = int(shifted.get("index") or 0) + offset
                errors.append(shifted)

        return SubmitBansResult(created=created, duplicates=duplicates, errors=errors)

    def submit_ban(self, ban: Dict[str, Any]) -> Ban:
        """Submit one ban and return the stored record.

        Raises BanListError(code="duplicate_ban") if this server already has an
        active ban for the player.
        """
        result = self.submit_bans([ban])

        if result.created:
            return result.created[0]

        if result.duplicates:
            duplicate = result.duplicates[0]
            raise BanListError(
                409,
                "duplicate_ban",
                "An active ban for %s already exists (%s)."
                % (duplicate.get("steam_id"), duplicate.get("id")),
                details=duplicate,
            )

        failure = result.errors[0] if result.errors else {}
        raise BanListError(
            422,
            str(failure.get("code") or "invalid_request"),
            str(failure.get("message") or "The ban was rejected."),
            details=failure or None,
        )

    def revoke_ban(self, ban_id: str, reason: Optional[str] = None) -> Ban:
        """Lift a ban. Only the issuing server (or a maintainer) may do this."""
        body = {"reason": reason} if reason else {}
        payload = self._request("POST", "/v1/bans/%s/revoke" % parse.quote(ban_id), body=body) or {}
        return Ban.from_dict(payload)

    # ----------------------------------------------------------------- reads

    def list_bans(self, **query: Any) -> ListBansResult:
        """One page. Pass `status="all"` to see revocations and expiries."""
        limit = int(query.pop("limit", 100) or 100)
        query["limit"] = min(max(limit, 1), MAX_PAGE_SIZE)
        payload = self._request("GET", "/v1/bans", query=query) or {}
        return ListBansResult.from_dict(payload)

    def iter_bans(self, **query: Any) -> Iterator[Ban]:
        """Iterate every matching ban, following next_cursor automatically."""
        cursor = query.pop("cursor", None)

        while True:
            page = self.list_bans(cursor=cursor, **query)
            for ban in page.data:
                yield ban
            if not page.has_more or not page.next_cursor:
                return
            cursor = page.next_cursor

    def lookup_steam_ids(self, steam_ids: Iterable[str]) -> List[Ban]:
        """Active bans for a set of players, 50 ids per request."""
        unique = list(dict.fromkeys(steam_ids))
        found: List[Ban] = []

        for offset in range(0, len(unique), MAX_STEAM_ID_LOOKUP):
            chunk = unique[offset : offset + MAX_STEAM_ID_LOOKUP]
            found.extend(self.iter_bans(steam_id=chunk, status="active"))

        return found

    def get_player(self, steam_id: str, status: str = "all", limit: int = 200) -> PlayerDetail:
        """Aggregate plus every ban record for one player."""
        if not STEAM_ID_PATTERN.match(steam_id):
            raise ValueError("%r is not a SteamID64" % steam_id)

        payload = self._request(
            "GET",
            "/v1/players/%s" % parse.quote(steam_id),
            query={"status": status, "limit": min(max(limit, 1), MAX_PAGE_SIZE)},
        )
        return PlayerDetail.from_dict(payload or {})

    def list_players(
        self, sort: str = "servers", limit: int = 50, offset: int = 0
    ) -> ListPlayersResult:
        """Players ranked by how many servers reported them."""
        payload = self._request(
            "GET",
            "/v1/players",
            query={"sort": sort, "limit": min(max(limit, 1), 200), "offset": max(offset, 0)},
        )
        return ListPlayersResult.from_dict(payload or {})

    def list_servers(self) -> List[Server]:
        payload = self._request("GET", "/v1/servers") or {}
        return [Server.from_dict(item) for item in payload.get("data") or []]

    def health(self) -> Dict[str, Any]:
        return self._request("GET", "/health") or {}

    # ------------------------------------------------------------- internals

    def _request(
        self,
        method: str,
        path: str,
        query: Optional[Dict[str, Any]] = None,
        body: Optional[Any] = None,
    ) -> Any:
        url = self.base_url + path

        if query:
            pairs = []
            for key, value in query.items():
                if value is None:
                    continue
                if isinstance(value, (list, tuple)):
                    if not value:
                        continue
                    value = ",".join(str(item) for item in value)
                elif isinstance(value, bool):
                    value = "true" if value else "false"
                pairs.append((key, str(value)))
            if pairs:
                url += "?" + parse.urlencode(pairs)

        headers = {
            "Authorization": "Bearer %s" % self.api_key,
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }

        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        last_error: Optional[BaseException] = None

        for attempt in range(self.retries + 1):
            req = request.Request(url, data=data, headers=headers, method=method)
            try:
                with request.urlopen(req, timeout=self.timeout) as response:
                    raw = response.read().decode("utf-8")
                    return json.loads(raw) if raw else None

            except urlerror.HTTPError as exc:
                raw = exc.read().decode("utf-8", "replace")
                payload = _parse_json(raw)

                if (exc.code == 429 or exc.code >= 500) and attempt < self.retries:
                    time.sleep(_retry_delay(exc.headers, attempt))
                    continue

                raise _error_from(exc.code, payload, exc.headers) from exc

            except (urlerror.URLError, TimeoutError, OSError) as exc:
                last_error = exc
                if attempt < self.retries:
                    time.sleep(0.25 * (2**attempt))
                    continue

        raise BanListError(
            0, "network_error", "Request to %s failed: %s" % (path, last_error)
        ) from last_error


def _parse_json(text: str) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _error_from(status: int, payload: Any, headers: Any) -> BanListError:
    envelope = payload if isinstance(payload, dict) else {}
    error = envelope.get("error") or {}
    code = str(error.get("code") or _fallback_code(status))
    message = str(error.get("message") or "Request failed with HTTP %d" % status)
    request_id = envelope.get("request_id") or (headers.get("X-Request-Id") if headers else None)

    return BanListError(
        status, code, message, details=error.get("details"), request_id=request_id
    )


def _fallback_code(status: int) -> str:
    if status == 401:
        return "unauthorized"
    if status == 403:
        return "forbidden"
    if status == 404:
        return "not_found"
    if status == 409:
        return "conflict"
    if status == 429:
        return "rate_limited"
    if status >= 500:
        return "internal"
    return "invalid_request"


def _retry_delay(headers: Any, attempt: int) -> float:
    raw = headers.get("Retry-After") if headers else None
    if raw:
        try:
            return min(max(float(raw), 0.0), 30.0)
        except ValueError:
            pass
    return min(0.5 * (2**attempt), 8.0)
