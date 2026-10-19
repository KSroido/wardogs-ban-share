"""Wire models. Field names mirror the JSON API (snake_case)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

BAN_REASONS = (
    "cheat",
    "rulebreak",
    "chattroll",
    "gametroll",
    "racism",
    "foreigner",
    "steamrisk",
    "ownreason",
)


@dataclass(frozen=True)
class ServerRef:
    id: str
    name: str

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ServerRef":
        return cls(id=str(data.get("id", "")), name=str(data.get("name", "")))


@dataclass(frozen=True)
class Server(ServerRef):
    status: str
    note: Optional[str]
    created_at: str

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Server":
        return cls(
            id=str(data.get("id", "")),
            name=str(data.get("name", "")),
            status=str(data.get("status", "active")),
            note=data.get("note"),
            created_at=str(data.get("created_at", "")),
        )


@dataclass(frozen=True)
class PlayerReports:
    """How many servers reported one SteamID. The headline field is server_count."""

    steam_id: str
    server_count: int
    active_server_count: int
    ban_count: int
    active_ban_count: int
    permanent_count: int
    reason_counts: Dict[str, int] = field(default_factory=dict)
    first_reported_at: Optional[str] = None
    last_reported_at: Optional[str] = None
    updated_at: str = ""

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PlayerReports":
        return cls(
            steam_id=str(data.get("steam_id", "")),
            server_count=int(data.get("server_count") or 0),
            active_server_count=int(data.get("active_server_count") or 0),
            ban_count=int(data.get("ban_count") or 0),
            active_ban_count=int(data.get("active_ban_count") or 0),
            permanent_count=int(data.get("permanent_count") or 0),
            reason_counts={
                str(reason): int(count or 0)
                for reason, count in (data.get("reason_counts") or {}).items()
            },
            first_reported_at=data.get("first_reported_at"),
            last_reported_at=data.get("last_reported_at"),
            updated_at=str(data.get("updated_at", "")),
        )


@dataclass(frozen=True)
class Ban:
    id: str
    server: ServerRef
    steam_id: str
    player_name: Optional[str]
    reason: str
    note: Optional[str]
    evidence_url: Optional[str]
    permanent: bool
    duration_days: Optional[int]
    expires_at: Optional[str]
    status: str
    external_case_id: Optional[str]
    created_at: str
    updated_at: str
    revoked_at: Optional[str]
    revoke_reason: Optional[str]
    reports: PlayerReports

    @property
    def duration_label(self) -> str:
        return "permanent" if self.permanent else "%dd" % (self.duration_days or 0)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Ban":
        reports = PlayerReports.from_dict(data.get("reports") or {})
        return cls(
            id=str(data.get("id", "")),
            server=ServerRef.from_dict(data.get("server") or {}),
            steam_id=str(data.get("steam_id", "")),
            player_name=data.get("player_name"),
            reason=str(data.get("reason", "")),
            note=data.get("note"),
            evidence_url=data.get("evidence_url"),
            permanent=bool(data.get("permanent")),
            duration_days=data.get("duration_days"),
            expires_at=data.get("expires_at"),
            status=str(data.get("status", "active")),
            external_case_id=data.get("external_case_id"),
            created_at=str(data.get("created_at", "")),
            updated_at=str(data.get("updated_at", "")),
            revoked_at=data.get("revoked_at"),
            revoke_reason=data.get("revoke_reason"),
            reports=reports,
        )


@dataclass
class SubmitBansResult:
    created: List[Ban]
    duplicates: List[Dict[str, Any]]
    errors: List[Dict[str, Any]]


@dataclass
class ListBansResult:
    data: List[Ban]
    next_cursor: Optional[str]
    has_more: bool
    server_time: str

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ListBansResult":
        return cls(
            data=[Ban.from_dict(item) for item in data.get("data") or []],
            next_cursor=data.get("next_cursor"),
            has_more=bool(data.get("has_more")),
            server_time=str(data.get("server_time", "")),
        )


@dataclass
class PlayerDetail:
    steam_id: str
    reports: PlayerReports
    bans: List[Ban]

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PlayerDetail":
        return cls(
            steam_id=str(data.get("steam_id", "")),
            reports=PlayerReports.from_dict(data.get("reports") or {}),
            bans=[Ban.from_dict(item) for item in data.get("bans") or []],
        )


@dataclass
class ListPlayersResult:
    data: List[PlayerReports]
    total: int
    limit: int
    offset: int

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ListPlayersResult":
        return cls(
            data=[PlayerReports.from_dict(item) for item in data.get("data") or []],
            total=int(data.get("total") or 0),
            limit=int(data.get("limit") or 0),
            offset=int(data.get("offset") or 0),
        )
