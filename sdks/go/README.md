# wardogs-banlist (Go)

```bash
go get github.com/KSroido/wardogs-ban-share/sdks/go/banlist
```

```go
import (
    "context"
    "github.com/KSroido/wardogs-ban-share/sdks/go/banlist"
)

client := banlist.New("https://wardogs.ksroido.art/api/ban-share", "<your server key>")
```

## Submit

```go
_, err := client.SubmitBan(context.Background(), banlist.SubmitBanInput{
    SteamID:        "76561198000000001",
    Reason:         banlist.ReasonCheat,
    Permanent:      true,
    EvidenceURL:    "https://example.com/clip.mp4",
    ExternalCaseID: "case-2026-10-19-001",
})
```

Duplicate submissions return `*banlist.APIError` with `Code == "duplicate_ban"`.

## Pull

```go
err := client.ForEachBan(ctx, banlist.ListBansQuery{
    Status: "all",
    Since:  "2026-10-01T00:00:00.000Z",
}, func(ban banlist.Ban) error {
    fmt.Println(ban.SteamID, ban.Reason, ban.DurationLabel(), ban.Reports.ServerCount)
    return nil
})
```

`ban.Reports.ServerCount` is the number of servers that reported the player.

Look one player up:

```go
detail, err := client.GetPlayer(ctx, "76561198000000001", "all", 200)
fmt.Println(detail.Reports.ServerCount, detail.Reports.ReasonCounts)
```

## 本地白名单

把自己服的“免检名单”传给客户端。命中的玩家在**发请求之前**直接拿到本地结果，
HTTP 调用次数是 0：

```go
// 内存名单
client := banlist.NewWithWhitelist(baseURL, apiKey, []string{"76561198000000001"})

// 或者从文件：构造时读取，失败返回 error
client, err := banlist.NewWithWhitelistFile(baseURL, apiKey, "./whitelist.txt")
if err != nil {
    log.Fatal(err)
}
```

| 调用 | 命中白名单时 |
|---|---|
| `GetPlayer(ctx, id, ...)` | 本地返回 `Whitelisted: true`、`Reports` 全零、`Bans` 为空，无 HTTP |
| `LookupSteamIDs(ctx, ids)` | 白名单 ID 不进查询串；全部命中时 0 次请求 |
| `ListBans(ctx, ListBansQuery{SteamIDs: ...})` / `ForEachBan` | 过滤条件里的白名单 ID 被剔除；全部命中时返回本地空页 |

白名单纯粹是本地策略：**不会**伪造 ban 记录，也**不会**改变 `SubmitBans` 的行为
（给白名单玩家提交 ban 仍照常上传）。

```go
client.IsWhitelisted("76561198000000001")     // true，纯内存
parts := client.PartitionSteamIDs(ids)        // parts.Whitelisted / parts.Others，去重保序
client.WhitelistSize()                        // 条目数

reloaded, err := client.ReloadWhitelist()     // 重新读文件；没有文件来源时 (false, nil)
err = client.LoadWhitelistFile("./wl.txt")    // 热加载并记住来源
client.SetWhitelist([]string{"76561198000000003"})
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

JSON 数组里字符串和整数都接受（`json.Number` 保留原始文本，不丢精度）。
白名单读写有内部锁保护，`Client` 仍可并发使用。`PlayerDetail.Whitelisted`
与 Python / TypeScript SDK 的 `whitelisted` 同名同义。

```python
BanListClient(url, api_key, whitelist=[...])   # is_whitelisted / partition_steam_ids / reload_whitelist
```

```typescript
new BanListClient({ whitelist: [...] })        // isWhitelisted / partitionSteamIds / reloadWhitelist
```

Errors are always `*banlist.APIError` (use `errors.As`), with stable `Code`,
`Status`, `Details` and `RequestID`.
