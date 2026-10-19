# 部署

本项目只依赖 Cloudflare：

- **Worker**：API 运行时（Hono，TypeScript）
- **D1**：唯一数据库实例 `wardogs_bans`
- **Workers Builds**：CI/CD（GitHub 只存代码，构建和部署在 Cloudflare 完成）
- **Cron Trigger**：每天 04:00 UTC 重建 `player_stats`

线上地址：`https://wardogs.ksroido.art/api/ban-share`

---

## 0. 前置

- Cloudflare 账号，且 `ksroido.art` 这个 zone 在账号里
- Node.js ≥ 20
- 仓库已推到 GitHub（`KSroido/wardogs-ban-share`）
- **不要**把 Cloudflare API Token 或 GitHub Token 写进任何文件

```bash
npm install
npx wrangler login          # 本地手动部署时使用
```

## 1. 创建 D1

```bash
npx wrangler d1 create wardogs_bans
```

把输出的 `database_id` 填进 [`apps/api/wrangler.jsonc`](../apps/api/wrangler.jsonc)：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "wardogs_bans",
    "database_id": "<database_id>",
    "migrations_dir": "migrations"
  }
]
```

> 整个项目**只有一个 D1 实例**。`servers`、`api_keys`、`bans`、`player_stats`、`audit_log` 都是这个库里的表。不要复用其他项目（例如 anti-cheat）的库。

## 2. 应用迁移

```bash
# 本地
npm run migrate:local

# 线上
npm run migrate:remote
```

迁移文件按文件名顺序执行，已执行过的会记录在 `d1_migrations` 表。

> `0002_fix_steam_id_check.sql` 是为规避 D1 的 GLOB 复杂度限制而重建 `bans` 表。新库也必须按顺序执行，不能跳过。

## 3. 配置管理员密钥

`ADMIN_TOKEN` 是 Worker Secret，至少 24 字符：

```bash
# 生成一个
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"

# 写入线上 Worker
npx wrangler secret put ADMIN_TOKEN --config apps/api/wrangler.jsonc
```

本地开发放在 `apps/api/.dev.vars`（已在 `.gitignore` 里）：

```ini
ADMIN_TOKEN=dev-admin-token-please-change-me
```

**这个值不要提交、不要贴 Issue、不要发群。** 泄露后立即重新 `secret put`，旧值立刻失效。

## 4. 首次部署

```bash
npx wrangler deploy --config apps/api/wrangler.jsonc
```

`wrangler.jsonc` 已经包含：

- `main: src/index.ts`
- `compatibility_date: 2026-09-15`
- `workers_dev: true`（同时提供 `*.workers.dev` 地址）
- 路由 `wardogs.ksroido.art/api/ban-share/*`
- 每日 cron `0 4 * * *`

检查：

```bash
curl https://wardogs.ksroido.art/api/ban-share/health
```

返回 `{"ok":true,...}` 即成功。

### 自定义路由 / 域名

当前用的是 **Workers Route**（只拦截 `/api/ban-share/*`），不是 Custom Domain。要求：

1. `ksroido.art` 在该 Cloudflare 账号下，zone 状态为 Active；
2. `wardogs.ksroido.art` 有 DNS 记录，且**代理开启**（橙色云）；
3. 路由 pattern 与 zone 匹配。

如果该主机名已经指向别的服务（例如 anti-cheat），路由只接管 `/api/ban-share/*`，其他路径不受影响。想换成独立域名，把 `routes` 改成：

```jsonc
"routes": [{ "pattern": "bans.example.com", "custom_domain": true }]
```

## 5. 用 Workers Builds 做 CI/CD

目标：`git push` → Cloudflare 自动构建、测试、迁移、部署；GitHub 不需要任何 Actions 或 Secrets。

### 连接仓库

Cloudflare Dashboard → **Workers & Pages** → **Create** → **Connect to Git** → 选择 `KSroido/wardogs-ban-share`。

| 配置项 | 值 |
|---|---|
| Production branch | `main` |
| Root directory | 仓库根目录（留空） |
| Build command | `npm ci && npm run ci` |
| Deploy command | `npx wrangler d1 migrations apply wardogs_bans --remote --config apps/api/wrangler.jsonc && npx wrangler deploy --config apps/api/wrangler.jsonc` |

说明：

- `npm run ci` = 密钥扫描 + TypeScript 类型检查 + TS 测试。任何一步失败都不会部署。
- Deploy command 先迁移再部署。D1 迁移是**前向**的，回滚代码不会回滚表结构。
- Workers Builds 会自动注入 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，不需要手工配置。
- 如果构建镜像里没有 Python/Go，CI 只跑 Node 部分；Python/Go 测试在本地或自己的流水线里跑。

### 预览分支

非 `main` 分支默认生成预览部署，但**不要**让预览分支跑生产 D1 迁移。两种做法：

1. 预览分支只构建不部署（dashboard 里关闭非生产分支的 deploy）；
2. 或者给预览环境单独建一个 D1，用 `--env preview` 配置。

生产迁移只允许在 `main` 上执行。

### 环境变量

| 名称 | 类型 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | Secret | 管理员接口令牌，≥24 字符 |
| `ENVIRONMENT` | 普通变量（可选） | 例如 `production`，仅用于日志标识 |

在 Dashboard → Worker → **Settings → Variables and Secrets** 配置，或：

```bash
npx wrangler secret put ADMIN_TOKEN --config apps/api/wrangler.jsonc
```

## 6. 创建第一个成员服

```bash
export BANLIST_ADMIN_URL=https://wardogs.ksroido.art
export ADMIN_TOKEN=...   # 只存在当前 shell

node scripts/admin.mjs create-server --name "Wardogs Main" --id wardogs-main
node scripts/admin.mjs issue-key --server wardogs-main --label prod
```

`issue-key` 输出的 `wdb_...` **只显示一次**。通过私密渠道发给该服管理员，然后让对方按 [ONBOARDING.md](ONBOARDING.md) 接入。

验证 key：

```bash
curl https://wardogs.ksroido.art/api/ban-share/v1/servers \
  -H "Authorization: Bearer wdb_..."
```

## 7. 日常运维

```bash
# 实时日志
npx wrangler tail wardogs-ban-share --config apps/api/wrangler.jsonc

# 手动重建读模型
node scripts/admin.mjs reindex

# 查看审计
node scripts/admin.mjs audit --limit 50

# 吊销泄露的 key
node scripts/admin.mjs revoke-key --id key_...
```

### 回滚

Dashboard → Worker → **Deployments** → 选择上一个版本 → **Rollback**。

注意：

- 只回滚代码，不回滚 D1 迁移。写迁移时保持向后兼容（先加列/表，再切代码）。
- 回滚后 `ADMIN_TOKEN` 等 Secret 不变。

### 备份

D1 支持导出：

```bash
npx wrangler d1 export wardogs_bans --remote --output backup-$(date +%F).sql
```

建议每周导出一次，保留在私有存储（**不要**提交到仓库）。

## 8. 故障排查

| 现象 | 排查 |
|---|---|
| `503 admin_disabled` | `ADMIN_TOKEN` 未配置或长度 <24 |
| `401 Unknown API key` | key 写错、被吊销，或前缀查不到（确认是 `wdb_` 开头） |
| `403 server_defederated` | 该服被 `set-status --status defederated` |
| `500 internal` | `wrangler tail` 看堆栈；检查 D1 绑定名是否为 `DB` |
| 读到的举报人数不更新 | `node scripts/admin.mjs reindex`；cron 每天 04:00 UTC 也会修 |
| 路由 404 | 确认访问路径带 `/api/ban-share`；确认 DNS 记录已代理 |

## 9. 安全清单（上线前）

- [ ] `npm run check:secrets` 通过
- [ ] 仓库里没有任何 `cfut_` / `ghp_` / `wdb_` / `ADMIN_TOKEN`
- [ ] `ADMIN_TOKEN` 只存在 Worker Secret，长度 ≥ 24
- [ ] `.dev.vars`、`.wrangler/`、`node_modules/` 未被提交
- [ ] 生产 D1 已应用全部迁移
- [ ] 至少建了一个成员服并拿到 key
- [ ] `GET /health`、`GET /v1/servers`（带 key）均正常
- [ ] 泄露过的 GitHub / Cloudflare token 已轮换
