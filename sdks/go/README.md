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

Errors are always `*banlist.APIError` (use `errors.As`), with stable `Code`,
`Status`, `Details` and `RequestID`.
