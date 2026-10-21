"""Client for the Wardogs federated ban list.

Zero runtime dependencies: only the Python standard library.

    from wardogs_banlist import BanListClient

    client = BanListClient("https://wardogs.ksroido.art/api/ban-share", api_key)
    for ban in client.iter_bans(status="all"):
        print(ban.steam_id, ban.reason, ban.reports.server_count)
"""

from .client import BanListClient
from .errors import BanListError
from .models import (
    BAN_REASONS,
    Ban,
    ListBansResult,
    ListPlayersResult,
    PlayerDetail,
    PlayerReports,
    Server,
    ServerRef,
    SubmitBansResult,
)
from .whitelist import SteamIdPartition, Whitelist, parse_whitelist_text

__all__ = [
    "BAN_REASONS",
    "Ban",
    "BanListClient",
    "BanListError",
    "ListBansResult",
    "ListPlayersResult",
    "PlayerDetail",
    "PlayerReports",
    "Server",
    "ServerRef",
    "SteamIdPartition",
    "SubmitBansResult",
    "Whitelist",
    "parse_whitelist_text",
]

__version__ = "0.1.0"
