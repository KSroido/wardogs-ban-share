# API 参考

- **Base URL**：`https://wardogs.ksroido.art/api/ban-share`
- **契约**：[`openapi.yaml`](openapi.yaml)（OpenAPI 3.1）
- **编码**：请求和响应均为 JSON（`application/json; charset=utf-8`）
- **时间**：所有时间戳为 ISO 8601 UTC，毫秒精度，例如 `2026-10-19T12:00:00.000Z`
- **SteamID**：始终是字符串。17 位 SteamID64，必须以 `7656119` 开头；不要用 JSON number。

## 认证

成员服接口使用 Bearer key：

```http
Authorization: Bearer wdb_...
```

- key 在签发时绑定到一个服务器，请求体里的任何 `server` / `server_id` 字段都会被忽略。
- key 只有两个 scope：`bans:read`、`bans:write`（或 `*`）。默认签发时两个都给。
- key 被吊销或所属服被 `defederated` 后，所有请求返回 `401` / `403`。

维护者接口使用独立的管理员令牌：

```http
X-Admin-Token: <ADMIN_TOKEN>
```

或 `Authorization: Bearer <ADMIN_TOKEN>`。管理员接口不在 OpenAPI 公开契约里，见文末[管理接口](#管理接口)。

## 通用响应头

| 头 | 说明 |
|---|---|
| `X-Request-Id` | 每次请求的 id；出错时也会返回，报障时贴这一行即可 |
| `Retry-After` | 预留；SDK 在 `429` / `5xx` 时会读取 |

客户端可以自带 `X-Request-Id`（`[A-Za-z0-9._:-]{1,64}`），便于串联日志。

## 错误格式

```json
{
  "error": {
    "code": "invalid_steam_id",
    "message": "steam_id must be a 17-digit SteamID64 starting with 7656119."
  },
  "request_id": "0f8fad5b-d9cb-469f-a165-70867728950e"
}
```

`code` 是稳定值，请按它分支，不要匹配 `message`。

| HTTP | 常见 `code` | 含义 |
|---|---|---|
| 400 | `invalid_request` / `invalid_json` | 字段缺失、类型错误、JSON 解析失败 |
| 400 | `invalid_steam_id` | 不是 17 位 SteamID64 |
| 400 | `invalid_reason` | 不在 8 个标签内 |
| 400 | `invalid_duration` | 时长缺失、非整数、超出 1–36500 |
| 400 | `invalid_evidence_url` | 不是 http(s) 绝对 URL |
| 400 | `invalid_external_case_id` | 含非法字符 |
| 400 | `invalid_cursor` | 游标损坏 |
| 400 | `batch_too_large` | 单次超过 100 条 |
| 401 | `unauthorized` / `key_revoked` | 缺少、错误或已吊销的 key |
| 403 | `forbidden` | scope 不足，或试图撤销别的服的记录 |
| 403 | `server_defederated` | 服务器已被移出联盟 |
| 404 | `not_found` | 记录不存在 |
| 413 | `payload_too_large` | 请求体超过 1 MB |
| 422 | 逐条错误代码 | 提交的 ban 全部校验失败 |

批量提交时单条失败不会中断其他条目，错误放在响应的 `errors` 数组里。

## 限制

| 项 | 限制 |
|---|---|
| 请求体 | 1 MB |
| 单次提交 | 100 条 |
| 列表 `limit` | 默认 100，最大 500 |
| 玩家榜 `limit` | 默认 50，最大 200；`offset` ≤ 10000 |
| 单玩家详情 `limit` | 默认 200，最大 500 |
| `steam_id` 过滤 | 最多 50 个 |
| `server` 过滤 | 最多 50 个 |
| `reason` 过滤 | 最多 8 个 |

目前**没有请求频率限制**，见 [ROADMAP.md](ROADMAP.md)。

---

## `GET /health`

无需认证。也提供 `/api/ban-share/health` 与根路径 `/health`。

```json
{ "ok": true, "time": "2026-10-19T16:49:02.793Z", "version": "0.1.0" }
```

## `GET /v1/bans`

拉取封禁记录，按 `(updated_at, id)` 升序。

需要 `bans:read`。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `status` | enum | `active` | `active` / `expired` / `revoked` / `all`。同步请用 `all` |
| `since` | ISO 时间 | — | 只返回 `updated_at > since` 的记录（不含等于） |
| `cursor` | string | — | 上一页的 `next_cursor`；与 `since` 同时存在时两者取交集（更严格的条件生效） |
| `limit` | int | 100 | 1–500 |
| `reason` | csv | — | 例如 `cheat,racism` |
| `steam_id` | csv | — | 精确匹配，最多 50 个 |
| `server` | csv | — | 服务器 slug，最多 50 个 |
| `permanent` | bool | — | `true` / `false` |

`status` 的判定：

- `active`：未撤销，且 `expires_at` 为空或晚于当前时间
- `expired`：未撤销，且 `expires_at` 已过
- `revoked`：已撤销（不看是否过期）
- `all`：不过滤

响应：

```json
{
  "data": [
    {
      "id": "ban_01J9Z6Q3K8V2M4T7R1C5B0N8XA",
      "server": { "id": "wardogs-main", "name": "Wardogs Main" },
      "steam_id": "76561198000000001",
      "player_name": "example_player",
      "reason": "cheat",
      "note": "Aimbot, spectator clip attached.",
      "evidence_url": "https://example.com/clips/aimbot.mp4",
      "permanent": true,
      "duration_days": null,
      "expires_at": null,
      "status": "active",
      "external_case_id": "case-2026-10-19-001",
      "created_at": "2026-10-19T12:00:00.000Z",
      "updated_at": "2026-10-19T12:00:00.000Z",
      "revoked_at": null,
      "revoke_reason": null,
      "reports": {
        "steam_id": "76561198000000001",
        "server_count": 3,
        "active_server_count": 2,
        "ban_count": 4,
        "active_ban_count": 2,
        "permanent_count": 3,
        "reason_counts": { "cheat": 3, "chattroll": 1 },
        "first_reported_at": "2026-05-01T00:00:00.000Z",
        "last_reported_at": "2026-10-19T12:00:00.000Z",
        "updated_at": "2026-10-19T12:00:00.000Z"
      }
    }
  ],
  "next_cursor": "MjAyNi0xMC0xOVQxMjowMDowMC4wMDBafGJhbl8wMUo5...",
  "has_more": false,
  "server_time": "2026-10-19T12:05:00.000Z"
}
```

- `reports` 是该 SteamID 的跨服聚合，每条记录都会带。
- `has_more` 为 `true` 时，把 `next_cursor` 原样回传取下一页。
- 增量同步请把 `server_time` 存下来作为下次的 `since`；不要用本机时间，避免时钟漂移漏记录。

## `POST /v1/bans`

提交 1–100 条封禁。需要 `bans:write`。

```json
{
  "bans": [
    {
      "steam_id": "76561198000000001",
      "reason": "cheat",
      "permanent": true,
      "player_name": "example_player",
      "note": "Aimbot, spectator clip attached.",
      "evidence_url": "https://example.com/clips/aimbot.mp4",
      "external_case_id": "case-2026-10-19-001"
    },
    {
      "steam_id": "76561198000000002",
      "reason": "chattroll",
      "permanent": false,
      "duration_days": 7,
      "external_case_id": "case-2026-10-19-002"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `steam_id` | 是 | 17 位 SteamID64 字符串 |
| `reason` | 是 | 8 个标签之一 |
| `permanent` | 是 | `true` 永久，`false` 需要 `duration_days` |
| `duration_days` | 条件 | 1–36500 的整数；`permanent: true` 时必须省略 |
| `note` | 条件 | ≤1000 字符；`reason: "ownreason"` 时必填 |
| `player_name` | 否 | ≤64 字符，最后已知游戏名 |
| `evidence_url` | 否 | ≤512 字符，http(s) 绝对 URL |
| `external_case_id` | 否 | ≤128 字符，`[A-Za-z0-9._:-]`，用于幂等 |

响应结构：

```json
{
  "created": [ Ban ],
  "duplicates": [
    { "index": 1, "id": "ban_...", "steam_id": "76561198000000002", "reason": "chattroll", "status": "active" }
  ],
  "errors": [
    { "index": 2, "code": "invalid_reason", "message": "reason must be one of: cheat, ..." }
  ]
}
```

`index` 是提交数组里的下标。

| HTTP | 条件 |
|---|---|
| `201` | 至少新建了一条，且没有错误 |
| `200` | 没有新建，也没有错误（全部是重复） |
| `207` | 有错误，同时有新建或重复 |
| `422` | 全部条目都校验失败 |

重复判定（按顺序）：

1. 同一服务器下 `external_case_id` 已存在 → 重复；
2. 同一服务器下该玩家已有未撤销且未过期的 ban → 重复。

两种情况都返回已有记录的 `id`，不会写入新行。

## `POST /v1/bans/{id}/revoke`

撤销自己的记录。需要 `bans:write`；只能撤销 `server_id` 与 key 一致的记录，否则 `403`。

请求体可选：

```json
{ "reason": "appeal accepted, evidence was inconclusive" }
```

`reason` ≤500 字符。重复调用是幂等的：已撤销的记录再次调用仍返回 `200` 和当前状态。

响应是更新后的完整 `Ban`（`status: "revoked"`，带 `revoked_at` / `revoke_reason`）。

## `GET /v1/players`

跨服举报人数排行榜。只读 `player_stats`，不返回封禁细节。

需要 `bans:read`。

| 参数 | 默认 | 说明 |
|---|---|---|
| `sort` | `servers` | `servers` / `active_servers` / `bans` / `active_bans` / `last_reported_at`，均为降序 |
| `limit` | 50 | 1–200 |
| `offset` | 0 | 0–10000 |

```json
{
  "data": [
    {
      "steam_id": "76561198000000001",
      "server_count": 3,
      "active_server_count": 2,
      "ban_count": 4,
      "active_ban_count": 2,
      "permanent_count": 3,
      "reason_counts": { "cheat": 3, "chattroll": 1 },
      "first_reported_at": "2026-05-01T00:00:00.000Z",
      "last_reported_at": "2026-10-19T12:00:00.000Z",
      "updated_at": "2026-10-19T12:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

所有撤销记录都被移除的玩家不会出现在这里。

## `GET /v1/players/{steamId}`

单个玩家的完整档案：聚合 + 所有封禁记录（最新在前）。

需要 `bans:read`。

| 参数 | 默认 | 说明 |
|---|---|---|
| `status` | `all` | `active` / `expired` / `revoked` / `all`，只影响 `bans` 数组 |
| `limit` | 200 | 1–500 |

```json
{
  "steam_id": "76561198000000001",
  "reports": { "...": "同上" },
  "bans": [ Ban, Ban ]
}
```

`reports` 始终是完整聚合（不受 `status` 影响）。如果读模型暂时落后，会现场从 `bans` 计算。

## `GET /v1/servers`

成员服列表。需要 `bans:read`。

```json
{
  "data": [
    {
      "id": "wardogs-main",
      "name": "Wardogs Main",
      "status": "active",
      "note": null,
      "created_at": "2026-10-01T00:00:00.000Z"
    }
  ]
}
```

`status` 为 `defederated` 的服务器历史记录仍会出现在 ban 列表里；接入方可以按 `server.id` 自行过滤。

---

## 管理接口

`https://wardogs.ksroido.art/api/ban-share/admin`，全部需要 `X-Admin-Token`。这些接口只给维护者用，不对成员开放。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/servers` | 列出服务器（含 key 数、ban 数） |
| `POST` | `/servers` | 建服：`{ "name": "...", "id?": "slug", "note?": "..." }` |
| `PATCH` | `/servers/{id}` | 改 `name` / `status` / `note` |
| `POST` | `/servers/{id}/keys` | 签 key：`{ "label?": "...", "scopes?": ["bans:read","bans:write"] }`，明文只返回一次 |
| `GET` | `/servers/{id}/keys` | 列出 key（只有前缀和状态） |
| `POST` | `/keys/{id}/revoke` | 吊销 key |
| `POST` | `/bans/{id}/revoke` | 紧急撤销任意记录 |
| `POST` | `/reindex` | 从 `bans` 重建 `player_stats` |
| `GET` | `/audit?limit=100&action=ban.create` | 审计日志 |
| `GET` | `/players/{steamId}` | 直接读聚合（不经过缓存） |

日常操作封装在 [`scripts/admin.mjs`](../scripts/admin.mjs) 里，一般不需要手写请求。

## 迁移与兼容性

- 路径带 `/v1`，破坏性变更会升到 `/v2`；新增字段不视为破坏性变更。
- 客户端应忽略未知字段。
- `GET /v1/bans` 的排序键是 `(updated_at, id)`；不要假设 `created_at` 顺序。
- `cursor` 不透明，不要解析或跨版本缓存。
