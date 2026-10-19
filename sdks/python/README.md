# wardogs-banlist (Python)

Standard library only — `pip install wardogs-banlist` or copy the package.

```python
from wardogs_banlist import BanListClient, BanListError

client = BanListClient(
    "https://wardogs.ksroido.art/api/ban-share",
    api_key="<your server key>",
)
```

## Submit

```python
result = client.submit_bans([
    {
        "steam_id": "76561198000000001",
        "reason": "cheat",
        "permanent": True,
        "evidence_url": "https://example.com/clip.mp4",
        "external_case_id": "case-2026-10-19-001",
    },
    {
        "steam_id": "76561198000000002",
        "reason": "chattroll",
        "permanent": False,
        "duration_days": 7,
    },
])

print(result.created, result.duplicates, result.errors)
```

`submit_ban()` raises `BanListError` with `code == "duplicate_ban"` when the player
is already banned by your server.

## Pull

```python
for ban in client.iter_bans(status="all", since="2026-10-01T00:00:00.000Z"):
    print(ban.steam_id, ban.reason, ban.duration_label, ban.reports.server_count)
```

`ban.reports.server_count` is the number of servers that reported the player.

Look a player up directly:

```python
player = client.get_player("76561198000000001")
print(player.reports.server_count, player.reports.reason_counts)

for ban in player.bans:
    print(ban.server.name, ban.reason, ban.created_at, ban.status)
```

## Errors

Every failure is a `BanListError` with `status`, `code`, `message`, `details`
and `request_id`. `code` is stable; branch on it, not on the message.
