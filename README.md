# Wardogs Ban Share

Wardogs 社区服的**联合 ban 名单**。各服管理员用自己服务器专属的密钥提交封禁记录，所有成员服可以增量拉取；同一个玩家被多少个服封过，一眼可见。

- 服务端：Cloudflare Worker（Hono）+ **单个 D1 实例**，无服务器、无自建数据库
- 客户端：TypeScript / Python / Go 三套 SDK，以及“提交”和“拉取”两个场景的完整示例
- 契约：[`docs/openapi.yaml`](docs/openapi.yaml)（OpenAPI 3.1）
- 线上地址：`https://wardogs.ksroido.art/api/ban-share`

> **项目须知：禁止把任何密钥写进仓库。** API key、Cloudflare token、`ADMIN_TOKEN` 只放服务器环境变量或 Workers Secrets。`npm run check:secrets` 会在 CI 里拦截疑似凭据，详见 [SECURITY.md](SECURITY.md)。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [功能](#功能)
- [数据模型](#数据模型)
- [快速开始（本地）](#快速开始本地)
- [提交 ban](#提交-ban)
- [拉取 ban](#拉取-ban)
- [查询某个玩家被多少服举报](#查询某个玩家被多少服举报)
- [加入联盟](#加入联盟)
- [部署](#部署)
- [维护者命令](#维护者命令)
- [仓库结构](#仓库结构)
- [安全](#安全)
- [已知边界](#已知边界)
- [License](#license)

---

## 它解决什么问题

一个服封了外挂，其他服往往要等玩家已经进来、已经杀了人，才发现问题。把封禁记录汇总到一个只有成员服能读写的中心库，就能在玩家进服前完成拦截。

设计上遵循三条：

1. **密钥即身份**：密钥绑定到一个服务器，提交时不需要（也不允许）声明“我是谁”。泄露的密钥无法冒充别的服。
2. **记录只增不改**：解封是软删除（`revoked`），增量同步能拉到“这条已经撤销”，而不是永远看不到。
3. **列表是情报，不是判决**：`foreigner`、`steamrisk` 这类推断性标签默认只做提示；每个服的封禁独立展示，由接入方自己决定是否踢人。

## 功能

| 能力 | 说明 |
|---|---|
| 批量提交 | 单次最多 100 条，逐条校验；部分失败返回 `207` 和逐条错误 |
| 幂等重试 | 客户端带 `external_case_id`，网络重试不会写出第二条 |
| 时长 | `permanent` 或 `duration_days`（1–36500），服务端换算 `expires_at` |
| 跨服举报人数 | 按 SteamID 聚合：`server_count` / `active_server_count` / `ban_count` / `active_ban_count` / `permanent_count` |
| 增量同步 | `since` + 游标分页，按 `(updated_at, id)` 走索引 |
| 撤销 | 只能撤销自己服的记录；维护者可紧急撤销任意记录 |
| 审计 | 建服、发 key、封禁、撤销、重建索引全部写入 `audit_log` |
| 审计密钥 | 库里只存 SHA-256(key) 和前 8 位前缀；明文只在签发时返回一次 |
| 自动修复 | 每天 04:00 UTC 重建 `player_stats` 读模型，也可手动 `POST /admin/reindex` |
| 三语言 SDK | TS（带重试、自动分页）、Python（纯标准库）、Go（`net/http`） |

**尚未实现**：请求频率限制、Webhook 推送、管理后台 UI、证据文件托管（只存 URL）。见 [ROADMAP.md](docs/ROADMAP.md)。

## 数据模型

只有一个 D1 实例（`wardogs_bans`），五张表：

| 表 | 用途 |
|---|---|
| `servers` | 成员服：稳定 slug、显示名、`active` / `defederated` |
| `api_keys` | `sha256(key)` + 8 位前缀 + scopes + 归属服；支持吊销 |
| `bans` | 事实记录；`(server_id, external_case_id)` 唯一 |
| `player_stats` | 按 SteamID 的聚合读模型（可随时从 `bans` 重建） |
| `audit_log` | 所有写操作 |

Ban 的状态是**派生**的，不单独存储过期：

```
revoked_at 非空                -> revoked
expires_at 非空且已过期        -> expired
否则                           -> active
```

`player_stats` 的计数只统计未撤销的记录；`active_*` 再排除已过期的记录。全部撤销后该行会被删除，所以“被举报最多”榜单不会残留幽灵数据。

## 快速开始（本地）

需要 Node.js ≥ 20（Workers 运行时）、Python ≥ 3.9（可选）、Go ≥ 1.21（可选）。

```bash
npm install

# 本地 D1（首次会创建 .wrangler/state）
npm run migrate:local

# 本地管理员令牌；复制模板并改掉默认值
cp apps/api/.dev.vars.example apps/api/.dev.vars

# http://127.0.0.1:8787/api/ban-share
npm run dev
```

另开一个终端，建一个测试服并签发 key：

```bash
export ADMIN_TOKEN=dev-admin-token-please-change-me
export BANLIST_ADMIN_URL=http://127.0.0.1:8787

node scripts/admin.mjs create-server --name "Test Server" --id test-server
node scripts/admin.mjs issue-key --server test-server --label local
# 输出里的 wdb_... 只显示这一次
```

检查：

```bash
curl http://127.0.0.1:8787/api/ban-share/health
```

测试与类型检查：

```bash
npm run ci            # 密钥扫描 + typecheck + 22 个 TS 测试
cd sdks/python && python -m unittest discover -s tests -v
cd sdks/go && go test ./...
```

## 提交 ban

```bash
curl -X POST https://wardogs.ksroido.art/api/ban-share/v1/bans \
  -H "Authorization: Bearer $BANLIST_KEY" \
  -H "Content-Type: application/json" \
  -d '{
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
  }'
```

响应（HTTP `201`；有重复或部分失败时见 [API.md](docs/API.md#post-v1bans)）：

```json
{
  "created": [
    {
      "id": "ban_...",
      "server": { "id": "your-server", "name": "Your Server" },
      "steam_id": "76561198000000001",
      "reason": "cheat",
      "permanent": true,
      "duration_days": null,
      "expires_at": null,
      "status": "active",
      "created_at": "2026-10-19T12:00:00.000Z",
      "reports": { "server_count": 1, "active_server_count": 1, "ban_count": 1 }
    }
  ],
  "duplicates": [],
  "errors": []
}
```

字段规则：

- `steam_id`：17 位 SteamID64 字符串，必须以 `7656119` 开头。**不要用 JS number 传**，会丢精度。
- `reason`：见下表。
- `permanent: true` 时不要传 `duration_days`；`false` 时 `duration_days` 必填。
- `reason: "ownreason"` 时 `note` 必填。
- `evidence_url` 选填，但强烈建议填；它只存链接，不托管文件。
- `external_case_id` 选填但建议填：同一个值重试不会重复入库。

### Reason 标签

| 值 | 含义 | 备注 |
|---|---|---|
| `cheat` | 作弊 / 外挂 | 建议附证据 |
| `rulebreak` | 违反服务器规则 | |
| `chattroll` | 聊天辱骂、刷屏 | |
| `gametroll` | 恶意游戏行为（TK、堵门等） | |
| `racism` | 种族歧视言论 | |
| `foreigner` | 非目标语言/地区玩家 | **推断性标签**，误伤率高，客户端默认只提示 |
| `steamrisk` | Steam 账号风险（小号、被盗等） | **推断性标签**，不能单独作为封禁依据 |
| `ownreason` | 其他 | `note` 必填 |

### 语言示例

- TypeScript：[`examples/ts/submit.ts`](examples/ts/submit.ts)
- Python：[`examples/python/submit.py`](examples/python/submit.py)
- Go：[`examples/go/submit/main.go`](examples/go/submit/main.go)

## 拉取 ban

```bash
# 增量：只要这个时间之后更新过的记录（包括撤销）
curl -G https://wardogs.ksroido.art/api/ban-share/v1/bans \
  -H "Authorization: Bearer $BANLIST_KEY" \
  --data-urlencode "status=all" \
  --data-urlencode "since=2026-10-01T00:00:00.000Z" \
  --data-urlencode "limit=500"
```

```json
{
  "data": [
    {
      "id": "ban_...",
      "server": { "id": "wardogs-main", "name": "Wardogs Main" },
      "steam_id": "76561198000000001",
      "reason": "cheat",
      "permanent": true,
      "duration_days": null,
      "expires_at": null,
      "status": "active",
      "created_at": "2026-10-19T12:00:00.000Z",
      "updated_at": "2026-10-19T12:00:00.000Z",
      "reports": { "server_count": 3, "active_server_count": 2 }
    }
  ],
  "next_cursor": "MjAyNi0xMC0xOVQxMjowMDowMC4wMDBafGJhbl8...",
  "has_more": false,
  "server_time": "2026-10-19T12:05:00.000Z"
}
```

同步建议：

1. 第一次全量：`status=all`，跟着 `next_cursor` 翻页直到 `has_more=false`。
2. 记录本次的 `server_time`，下次作为 `since`。
3. **始终用 `status=all`**，否则永远学不到“某条 ban 被撤销了”。
4. 本地按 `id` 做 upsert，用返回的 `status` 决定加入或移出本地黑名单。
5. `reports.server_count` 是“有多少个服举报过此人”，适合做风险分级；不要把它当成“必须踢”。

按玩家查（进服前最常用）：

```bash
curl -G https://wardogs.ksroido.art/api/ban-share/v1/bans \
  -H "Authorization: Bearer $BANLIST_KEY" \
  --data-urlencode "steam_id=76561198000000001" \
  --data-urlencode "status=active"
```

`steam_id` 支持逗号分隔，单次最多 50 个。

## 查询某个玩家被多少服举报

```bash
curl https://wardogs.ksroido.art/api/ban-share/v1/players/76561198000000001 \
  -H "Authorization: Bearer $BANLIST_KEY"
```

```json
{
  "steam_id": "76561198000000001",
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
  },
  "bans": [ "...每条原始记录，最新在前..." ]
}
```

只看聚合排行（不带封禁细节）：

```bash
curl -G https://wardogs.ksroido.art/api/ban-share/v1/players \
  -H "Authorization: Bearer $BANLIST_KEY" \
  --data-urlencode "sort=servers" --data-urlencode "limit=20"
```

`sort`：`servers`（默认）、`active_servers`、`bans`、`active_bans`、`last_reported_at`。

## 加入联盟

1. 用 [服务器申请表](https://github.com/KSroido/wardogs-ban-share/issues/new?template=server-application.yml) 提交 Issue。
2. 维护者审核后，在库里创建服务器并签发密钥。
3. 密钥**只通过私密渠道**发送一次，不要贴在 Issue 里，也不要提交到仓库。
4. 按 [ONBOARDING.md](docs/ONBOARDING.md) 完成接入和首次全量同步。

审核看的是：服务器真实存在、有明确的社区和管理规范、愿意对自己的封禁负责。联盟不替成员服做申诉裁决；每条记录带各服自己的信息，申诉请找封禁你的服。

## 部署

线上已经部署在 Cloudflare（Workers + D1 + 自定义路由 + 每日 cron）。推荐用 **Cloudflare Workers Builds** 做 CI/CD，GitHub 只存代码；接入步骤见 [docs/DEPLOY.md](docs/DEPLOY.md)。

从零部署、绑定域名、配置 `ADMIN_TOKEN`、迁移数据库的完整步骤见 [docs/DEPLOY.md](docs/DEPLOY.md)。

```bash
# 手动部署（CI 之外）
npm run migrate:remote
npm run deploy
npx wrangler secret put ADMIN_TOKEN --config apps/api/wrangler.jsonc
```

## 维护者命令

`scripts/admin.mjs` 走 `/admin` 接口，生产、本地都能用：

```bash
export BANLIST_ADMIN_URL=https://wardogs.ksroido.art
export ADMIN_TOKEN=...            # Workers Secret，不要写进文件

node scripts/admin.mjs servers
node scripts/admin.mjs create-server --name "Wardogs Main" --id wardogs-main
node scripts/admin.mjs issue-key --server wardogs-main --label prod
node scripts/admin.mjs keys --server wardogs-main
node scripts/admin.mjs revoke-key --id key_...
node scripts/admin.mjs set-status --server wardogs-main --status defederated
node scripts/admin.mjs revoke-ban --id ban_... --reason "appeal accepted"
node scripts/admin.mjs reindex
node scripts/admin.mjs audit --limit 50 --action ban.create
```

## 仓库结构

```
apps/api/            Cloudflare Worker（Hono）+ D1 迁移
packages/sdk-ts/     TypeScript SDK（@wardogs/banlist）
sdks/python/         Python SDK（纯标准库，可 pip 安装）
sdks/go/             Go SDK（可 go get）
examples/            提交 / 拉取，各三种语言
scripts/             admin CLI、密钥扫描
docs/                API、部署、接入、路线图、OpenAPI
.github/             Issue 表单
```

## 安全

- **仓库里不存密钥**：提交前跑 `npm run check:secrets`；CI 也会跑。
- **API key**：32 字节随机数，库里只有 SHA-256；泄露后立即 `revoke-key` 并重新签发。
- **ADMIN_TOKEN**：至少 24 字符，只存在 Worker Secret；管理接口完全不对外公开。
- **SteamID64 是个人信息**：读接口需要成员 key，不提供匿名公开名单。
- **退盟**：`set-status --status defederated` 会立刻停用该服所有 key，但历史记录保留并标注来源。

细节与漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 已知边界

- 没有请求限流；被泄露的 key 在吊销前可以持续写入（审计可追溯）。
- `player_stats` 是最终一致的读模型；写入时会同步刷新该玩家，异常时靠每日重建修复。
- 不支持修改已提交的 ban（改判 = 撤销旧记录 + 提交新记录）。
- 证据只存 URL，联盟不托管文件，链接失效需原服务器自行维护。
- `foreigner` / `steamrisk` 属于主观判断，接入方应自行决定是否自动执行。

## License

[MIT](LICENSE)
