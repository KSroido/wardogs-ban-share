# wardogs-banlist (Python)

Standard library only. Install the wheel from this repo's release:

```bash
pip install https://github.com/KSroido/wardogs-ban-share/releases/download/v0.1.1/wardogs_banlist-0.1.1-py3-none-any.whl
```

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

## 本地白名单

把自己服的“免检名单”传给客户端。命中的玩家在**发请求之前**直接拿到本地结果，
HTTP 调用次数是 0：

```python
client = BanListClient(
    "https://wardogs.ksroido.art/api/ban-share",
    api_key="<your server key>",
    whitelist=["76561198000000001"],   # list / set
    # whitelist="./whitelist.txt",     # 或文件路径
)
```

| 调用 | 命中白名单时 |
|---|---|
| `get_player(id)` | 本地返回 `whitelisted=True`、`reports` 全零、`bans=[]`，无 HTTP |
| `lookup_steam_ids(ids)` | 白名单 ID 不进查询串；全部命中时 0 次请求 |
| `list_bans(steam_id=...)` / `iter_bans()` | 过滤条件里的白名单 ID 被剔除；全部命中时返回本地空页 |

白名单纯粹是本地策略：**不会**伪造 ban 记录，也**不会**改变 `submit_bans` 的行为
（给白名单玩家提交 ban 仍照常上传）。

```python
client.is_whitelisted("76561198000000001")     # True，纯内存
parts = client.partition_steam_ids(ids)        # parts.whitelisted / parts.others，去重保序
client.whitelist_size                          # 条目数

client.reload_whitelist()                      # 重新读文件；内存名单返回 False
client.set_whitelist(["76561198000000003"])    # 直接换掉内存名单
```

文件格式自动识别，两种都行：

```text
# 每行一个，# 开头的整行是注释
76561198000000001
76561198000000002
```

```json
["76561198000000001", "76561198000000002"]
```

JSON 数组里字符串和整数都接受（Python 的 `int` 是精确的）；
`whitelist_size`、`partition_steam_ids`、`reload_whitelist` 与 Go / TypeScript SDK
同名同义，`PlayerDetail.whitelisted` 字段三语言一致。

```typescript
new BanListClient({ whitelist: [...] })        // isWhitelisted / partitionSteamIds / reloadWhitelist
```

```go
banlist.NewWithWhitelist(url, key, ids)        // IsWhitelisted / PartitionSteamIDs / ReloadWhitelist
```

## Errors

Every failure is a `BanListError` with `status`, `code`, `message`, `details`
and `request_id`. `code` is stable; branch on it, not on the message.
