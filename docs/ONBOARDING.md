# 接入指南

面向服务器管理员：从申请、拿 key 到完成第一次同步。

---

## 1. 申请

打开 [服务器申请表](https://github.com/KSroido/wardogs-ban-share/issues/new?template=server-application.yml)，填写：

| 字段 | 说明 |
|---|---|
| 服务器名称 | 展示在 ban 记录里的名字，例如 `Wardogs Main` |
| 服务器 ID（slug） | 小写字母、数字、短横线，2–31 位，例如 `wardogs-main`。**创建后不能改** |
| 联系方式 | Discord / QQ / 邮箱，用于审核和密钥下发 |
| 服务器地区 | 例如 `CN`、`Asia`、`EU` |
| 大致在线人数 | 帮助判断接入规模 |
| 管理规范 | 你们的封禁标准、申诉渠道；有链接最好 |
| 申请理由 | 为什么需要联合名单，能提供什么 |

**不要在 Issue 里贴 API key、密码、token。** key 是审核通过后由维护者单独下发的。

## 2. 审核

维护者会看：

- 服务器真实可访问，名称和社区信息对得上；
- 有公开或半公开的规则/申诉渠道；
- 愿意对自己提交的封禁负责（误封要能撤销）；
- 同意 [SECURITY.md](../SECURITY.md) 里的数据使用约定：名单只用于本服反作弊/管理，不公开转卖或批量泄露。

审核结果会回复在 Issue 里。通过后维护者执行：

```bash
node scripts/admin.mjs create-server --name "Wardogs Main" --id wardogs-main
node scripts/admin.mjs issue-key --server wardogs-main --label prod
```

然后把 `wdb_...` 通过私密渠道发给你，并告知对应的服务器 slug。

## 3. 保存 key

- 只放在服务器的环境变量 / secret 管理器里，例如：

  ```bash
  # /etc/wardogs/banlist.env  (chmod 600)
  BANLIST_KEY=wdb_...
  BANLIST_URL=https://wardogs.ksroido.art/api/ban-share
  ```

- 不要写进代码、配置文件、Dockerfile、Git 仓库、聊天记录。
- 一个 key 对应一个服，**不要多个服共用**。需要多台机器时可申请多个 key（便于单独吊销）。
- 怀疑泄露：立刻让维护者 `revoke-key --id key_...`，然后重新签发。

## 4. 第一次全量同步

目标：把联盟里所有记录落到本地，之后只拉增量。

### TypeScript

```ts
import { BanListClient } from '@wardogs/banlist';

const client = new BanListClient({
  baseUrl: process.env.BANLIST_URL!,
  apiKey: process.env.BANLIST_KEY!,
});

let lastSync: string | undefined;

for await (const ban of client.iterateBans({ status: 'all', limit: 500 })) {
  upsertLocalBan(ban);          // 按 ban.id upsert
}
```

`iterateBans` 会自动跟 `next_cursor`。

### Python

```python
import os
from wardogs_banlist import BanListClient

client = BanListClient(os.environ["BANLIST_URL"], os.environ["BANLIST_KEY"])

for ban in client.iter_bans(status="all", limit=500):
    upsert_local_ban(ban)
```

### Go

```go
client := banlist.New(os.Getenv("BANLIST_URL"), os.Getenv("BANLIST_KEY"))

err := client.ForEachBan(ctx, banlist.ListBansQuery{
    Status: "all",
    Limit:  500,
}, func(ban banlist.Ban) error {
    return upsertLocalBan(ban)
})
```

### 裸 HTTP

```bash
curl -G "$BANLIST_URL/v1/bans" \
  -H "Authorization: Bearer $BANLIST_KEY" \
  --data-urlencode "status=all" \
  --data-urlencode "limit=500"
```

跟着 `next_cursor` 翻页，直到 `has_more=false`。

## 5. 增量同步

每次同步保存服务端返回的 `server_time`，下次作为 `since`：

```bash
curl -G "$BANLIST_URL/v1/bans" \
  -H "Authorization: Bearer $BANLIST_KEY" \
  --data-urlencode "status=all" \
  --data-urlencode "since=$LAST_SERVER_TIME" \
  --data-urlencode "limit=500"
```

规则：

1. **必须 `status=all`**。只用 `active` 会看不到 `revoked`，被撤销的玩家会永远留在你的黑名单里。
2. 用 `server_time`，不要用本机时间；本机时钟快几秒就会漏记录。
3. 按 `id` upsert，不要按 `steam_id`：同一个人可能有多条不同服的记录。
4. 记录状态以响应里的 `status` 为准：
   - `active`：加入本地黑名单；
   - `expired`：可以移出（或保留为历史）；
   - `revoked`：立即移出，除非本地还有自己的独立封禁。
5. 建议每 1–5 分钟同步一次；数据量小时直接全量拉也很快。

## 6. 在玩家进服前检查

最省事的方式是按 SteamID 批量查：

```bash
curl -G "$BANLIST_URL/v1/bans" \
  -H "Authorization: Bearer $BANLIST_KEY" \
  --data-urlencode "steam_id=76561198000000001,76561198000000002" \
  --data-urlencode "status=active"
```

单次最多 50 个 SteamID。或者直接读本地缓存（推荐，零延迟）。

需要“被几个服举报”时调用：

```bash
curl "$BANLIST_URL/v1/players/76561198000000001" \
  -H "Authorization: Bearer $BANLIST_KEY"
```

建议的处置策略（自行决定）：

| `reports.active_server_count` | 建议 |
|---|---|
| 0 | 正常放行 |
| 1 | 提示管理员，人工确认 |
| 2–3 | 进服观察 / 限制白名单 |
| ≥4 | 直接拒绝，除非有本地申诉 |

不要仅凭 `foreigner` / `steamrisk` 标签自动封禁；它们误伤率高。

## 7. 提交你们服的封禁

```bash
curl -X POST "$BANLIST_URL/v1/bans" \
  -H "Authorization: Bearer $BANLIST_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "bans": [{
      "steam_id": "76561198000000001",
      "reason": "cheat",
      "permanent": true,
      "evidence_url": "https://.../clip.mp4",
      "external_case_id": "your-case-001"
    }]
  }'
```

建议：

- 保留 `external_case_id`：重试安全，也方便日后对账。
- 有时长的封禁传 `permanent: false` + `duration_days`；到期后服务端自动按 `expired` 处理。
- 误封直接撤销：

  ```bash
  curl -X POST "$BANLIST_URL/v1/bans/<ban_id>/revoke" \
    -H "Authorization: Bearer $BANLIST_KEY" \
    -H "Content-Type: application/json" \
    -d '{"reason":"appeal accepted"}'
  ```

  只能撤销自己服的记录。撤销后其他服下次增量同步会收到 `status: revoked`。

## 8. 退盟 / 停止接入

- 临时停用：让维护者吊销 key 即可，历史记录保留。
- 正式退盟：维护者执行 `set-status --server <id> --status defederated`：
  - 该服所有 key 立刻失效；
  - 历史记录仍可被查询，但会标明来源；
  - 其他服可自行决定是否过滤该来源。
- 数据删除请求由维护者评估；已同步到其他服本地的数据无法回收，这是联邦制本身的边界。

## 9. 常见问题

**Q：key 泄露了怎么办？**
立即联系维护者吊销并换新。旧 key 在吊销前写入的记录仍在审计日志里，可追溯。

**Q：可以一个 key 给多个服吗？**
不可以。key 即身份，共用会导致来源标注错误，也无法单独吊销。

**Q：为什么提交返回 `duplicates`？**
同一服务器下该玩家已有未撤销且未过期的 ban，或 `external_case_id` 重复。响应里有已有记录的 `id`。

**Q：为什么拉不到刚提交的记录？**
确认 `status` 不是默认的 `active` 之外的值，并检查 `since` 是否用了未来时间。列表按 `updated_at` 升序，刚写入的记录会在第一页。

**Q：`server_count` 和 `active_server_count` 有什么区别？**
前者统计所有未撤销记录涉及的服务器数；后者只统计**当前仍在生效**的。用后者做实时拦截更准确。

**Q：能直接改一条已提交的记录吗？**
不能。撤销旧记录，再提交一条新记录。
