# @wardogs/banlist

Wardogs 联合 ban 名单的 TypeScript 客户端。零依赖，Node ≥ 18 / 任意有 `fetch` 的运行时。

## 安装

当前通过 workspace 使用（尚未发布到 npm）：

```bash
npm install
```

```ts
import { BanListClient, BanListError } from '@wardogs/banlist';
```

## 初始化

```ts
const client = new BanListClient({
  baseUrl: 'https://wardogs.ksroido.art/api/ban-share',
  apiKey: process.env.BANLIST_KEY!,   // wdb_...
  // timeoutMs: 15_000,
  // retries: 2,
});
```

`baseUrl` 不要带 `/v1`。

## 提交

```ts
const result = await client.submitBans([
  {
    steam_id: '76561198000000001',
    reason: 'cheat',
    permanent: true,
    evidence_url: 'https://example.com/clip.mp4',
    external_case_id: 'case-001',
  },
  {
    steam_id: '76561198000000002',
    reason: 'chattroll',
    permanent: false,
    duration_days: 7,
  },
]);

// result.created / result.duplicates / result.errors
```

- 超过 100 条会自动分块，`index` 已换算成原始数组下标。
- `submitBan()` 是单条版本：重复时抛 `duplicate_ban`，校验失败抛对应 `code`。

## 拉取

```ts
// 一页
const page = await client.listBans({ status: 'all', limit: 500, since: lastSync });

// 自动翻页
for await (const ban of client.iterateBans({ status: 'all', since: lastSync })) {
  // upsert by ban.id; use ban.status
}

// 按 SteamID 批量查（每批 50 个）
const bans = await client.lookupSteamIds(['76561198000000001', '76561198000000002']);
```

**同步时始终传 `status: 'all'`**，否则收不到撤销。把响应的 `server_time` 存下来作为下次的 `since`。

## 玩家

```ts
const player = await client.getPlayer('76561198000000001');
console.log(player.reports.server_count, player.reports.reason_counts);

const top = await client.listPlayers({ sort: 'servers', limit: 20 });
const servers = await client.listServers();
```

## 撤销

```ts
await client.revokeBan(banId, 'appeal accepted');
```

只能撤销自己服的记录。重复调用幂等。

## 错误

所有失败都是 `BanListError`：

```ts
try {
  await client.submitBan(input);
} catch (error) {
  if (error instanceof BanListError) {
    console.error(error.status, error.code, error.requestId, error.message);
  }
}
```

字段：`status`、`code`、`message`、`details`、`requestId`。`code` 稳定，请按它分支。

- `network_error`（`status: 0`）：网络失败且重试耗尽
- `duplicate_ban`（`409`）：`submitBan()` 遇到重复
- 401 / 403 等直接透传 API 错误码

`429` / `5xx` 会按 `Retry-After` 或指数退避重试；其他 4xx 不重试。

## 类型

所有 wire type 从包根导出：`Ban`、`BanReason`、`PlayerReports`、`SubmitBanInput`、`ListBansQuery` 等。字段名与 JSON 一致（snake_case）。
