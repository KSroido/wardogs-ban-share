# @wardogs/banlist

Wardogs 联合 ban 名单的 TypeScript 客户端。零依赖，Node ≥ 18 / 任意有 `fetch` 的运行时。

## 安装

没有发到 npm。从本仓库的 release 装：

```bash
npm i https://github.com/KSroido/wardogs-ban-share/releases/download/v0.1.1/wardogs-banlist-0.1.1.tgz
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

## 本地白名单

把自己服的“免检名单”传给客户端。命中的玩家在**发请求之前**直接拿到本地结果，
HTTP 调用次数是 0：

```ts
const client = new BanListClient({
  baseUrl: 'https://wardogs.ksroido.art/api/ban-share',
  apiKey: process.env.BANLIST_KEY!,
  whitelist: ['76561198000000001', '76561198000000002'], // 数组 / Set
  // whitelist: './whitelist.txt',                       // 或文件路径
});
```

| 调用 | 命中白名单时 |
|---|---|
| `getPlayer(id)` | 本地返回 `whitelisted: true`、`reports` 全零、`bans: []`，无 HTTP |
| `lookupSteamIds(ids)` | 白名单 ID 不进查询串；全部命中时 0 次请求 |
| `listBans({ steam_id })` / `iterateBans()` | 过滤条件里的白名单 ID 被剔除；全部命中时返回本地空页 |

白名单纯粹是本地策略：**不会**伪造 ban 记录，也**不会**改变 `submitBans` 的行为
（给白名单玩家提交 ban 仍照常上传）。

```ts
client.isWhitelisted('76561198000000001');                      // true，纯内存
const { whitelisted, others } = client.partitionSteamIds(ids);  // 去重、保序
client.whitelistSize;                                           // 条目数

// 热加载：只有文件来源有效，内存列表返回 false
fs.writeFileSync('./whitelist.txt', nextList);
client.reloadWhitelist();
client.setWhitelist(['76561198000000003']);                     // 直接换掉内存名单
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

JSON 数组里的 SteamID64 **必须写成字符串**：17 位数字超出 JS 安全整数范围，
SDK 宁可报错也不静默截断。读文件走 Node 的同步 `fs`（Node ≥ 22.3，通过
`process.getBuiltinModule` 惰性获取，不会给 Worker 打包引入 `node:fs`）；
Worker / 浏览器请直接传数组。

Python 与 Go SDK 行为完全一致，字段名都是 `whitelisted`：

```python
BanListClient(url, api_key, whitelist=[...])   # is_whitelisted() / partition_steam_ids() / reload_whitelist()
```

```go
banlist.NewWithWhitelist(url, key, ids)        // IsWhitelisted / PartitionSteamIDs / ReloadWhitelist
```

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
