# 项目状态（STATUS）

> 这是**跨会话的共同锚点**：QQ 机器人、桌面 app、CLI 里的任何一次对话，接手这个项目前先读本文件。
> 会话上下文不会跨平台传递，事实以本文件 + 仓库代码为准。
> 最后更新：2026-10-21

## 一句话

Wardogs 社区服的联邦 ban 名单：成员服用各自密钥提交封禁记录，所有成员服增量拉取，按 SteamID 聚合出「被几个服封过」。已上线运行。

| 项 | 值 |
|---|---|
| 线上入口 | `https://wardogs.ksroido.art/api/ban-share` |
| 版本 | `0.1.0`（API `/v1`） |
| 仓库 | [KSroido/wardogs-ban-share](https://github.com/KSroido/wardogs-ban-share)（public） |
| 部署 | Cloudflare Workers + 单个 D1，无服务器、无自建库 |
| 维护者面板 | `https://wardogs.ksroido.art/ban-share`（`ADMIN_TOKEN` 登录；建服 / 发 key / 撤 ban / 审计） |

## 线上部署

| 项 | 值 |
|---|---|
| Worker | `wardogs-ban-share` |
| 路由 | `wardogs.ksroido.art/api/ban-share` 与 `/api/ban-share/*`（zone `ksroido.art`） |
| D1 | `wardogs_bans`（`database_id` 见 `apps/api/wrangler.jsonc`，migrations 目录 `apps/api/migrations`） |
| Cron | `0 4 * * *` —— 夜间重建 `player_stats` 读模型（写入时已增量更新，cron 只兜底） |
| CI/CD | Workers Builds，trigger `Deploy production`，分支 `main` |
| Build | `npm ci && npm run ci` |
| Deploy | `npx wrangler d1 migrations apply wardogs_bans --remote --config apps/api/wrangler.jsonc && npx wrangler deploy --config apps/api/wrangler.jsonc` |
| 预览分支 | 未启用（避免预览构建误跑生产 D1 迁移） |

**往 `main` push 即自动上线**（密钥扫描 → 类型检查 → 22 个测试 → D1 迁移 → deploy）。上次验证：commit `cd180c6` 触发构建成功，Worker 版本 `54b22132-a9dc-492f-a074-f2c6199f5a92`，100% 流量；`/api/ban-share/health` 返回 `{"ok":true,...}`。

> 遗留项：Builds 用的是由早期 Cloudflare API Token 生成的 build token `wardogs-ban-share CI`，**那个 Token 一旦轮换/删除，构建会失败**。建议换成一个最小权限专用 Token（Account: Workers Scripts `Edit` + D1 `Edit`；Zone `ksroido.art`: Workers Routes `Edit`）。

## 架构

- **服务端**：Hono on Workers，`apps/api/src/index.ts` 挂载 `/health`、`/v1/bans`、`/v1/players`、`/v1/servers`、`/admin`；统一 `x-request-id`，错误体 `{error:{code,message,details},request_id}`。
- **数据模型**：`servers` / `api_keys`（只存 `SHA-256(key)` + `prefix` 索引）/ `bans` / `player_stats`（按 SteamID 聚合）/ `audit`。迁移 `0001_init.sql`、`0002_fix_steam_id_check.sql`。
- **鉴权**：`wdb_` 前缀密钥 → 映射到唯一 server，提交时不能声明「我是谁」；scope 目前只有 `bans:read` / `bans:write`。维护者接口 `/admin/*` 用 `ADMIN_TOKEN`（`x-admin-token` 或 Bearer，≥24 字符），未配置时返回 `503 admin_disabled`。
- **写到线上的是密钥之外的一切**：`ADMIN_TOKEN`、CF Token 只走 Workers Secrets / 环境变量，绝不入库。
- **成员服字段**：`owner`（管理方）+ `location`（地理位置，申请必填）。一个 key 挂在 (owner, location) 组上；组里多台服时提交用顶层 `server_id` 指明具体服务器。
- **reason 枚举**（8 个，服务端固定）：`cheat` `rulebreak` `chattroll` `gametroll` `racism` `foreignofserverlocation` `steamrisk` `ownreason`。
- **记录语义**：只增不改，解封是软删除 `revoked`；`external_case_id` 做幂等；`permanent` 或 `duration_days`（1–36500）换算 `expires_at`；批量上限 100，部分失败返回 `207` + 逐条错误。
- **读接口**：`/v1/players/{steamId}` 给出 `server_count` / `active_server_count` / `ban_count` / `active_ban_count` / `permanent_count`。读也需要 key（不做公开匿名查询）。

## 客户端

- SDK：`sdks/go`（`banlist` 包）、`sdks/python`（`wardogs_banlist`）、`packages/sdk-ts`（`@wardogs/banlist`，未发布）。
- 场景示例：`examples/ts`、`examples/python`、`examples/go` 各有 `submit` 和 `pull`。
- 契约：`docs/openapi.yaml`（OpenAPI 3.1，版本 0.1.0）；接入文档 `docs/API.md`、`docs/DEPLOY.md`、`docs/ONBOARDING.md`。

## 质量门

`npm run ci` = `check:secrets` → `typecheck` → `test`。

- 测试 22 个：TS SDK 7（`packages/sdk-ts/test/client.test.ts`）+ 校验/映射 15（`apps/api/test/validation.test.ts`）。
- `scripts/check-secrets.mjs` 只扫**git 可见文件**（tracked + 未忽略的 untracked），非 git 环境才回退到遍历工作树。

## 未完成项

按 `docs/ROADMAP.md` 的优先级：

**P0**
- [ ] 限流 / 配额：按 key + IP 滑动窗口，写 60/min、读 300/min，超出 `429` + `Retry-After`（目前完全没有频率限制，泄露的 key 在吊销前可持续写入）
- [ ] Worker 集成测试：`@cloudflare/vitest-pool-workers`，真跑 D1 迁移 + 路由（现在只有纯函数和 SDK 单测）
- [ ] D1 → R2 每周备份，保留 8 周

**P1**
- [ ] key 作用域细分：`bans:read:full`（含证据 URL）/ `bans:read:aggregate`（只读人数）
- [ ] 每条记录加 `appeal_url`
- [ ] 证据托管到 R2（私有 bucket + 签名 URL）
- [ ] 过期记录保留 / 按服导出

**P2**
- [ ] Webhook（`ban.created` / `ban.revoked`，HMAC 签名 + 重试）
- [ ] CSV / `bans.sqlite` 批量导入（dry-run + 逐行报告）
- [ ] 维护者管理 UI（必须走 Cloudflare Access）
- [ ] SDK 发布：npm / PyPI / Go tag
- [ ] 三套 SDK 跑同一组 fixture 的一致性测试
- [ ] RCON / 插件接入片段、定时同步 demo

**P3**：联盟治理文档、公开匿名统计页、多区域、告警。

## 联合成员与集成（2026-10-21）

| 项 | 值 |
|---|---|
| 成员服 id | `wardogs`（Wardogs 社区服） |
| key scope | `bans:read bans:write`（一枚 key，QQ 机器人与 anticheat cron 共用） |
| key 存放 | Workers secret `BAN_SHARE_KEY`（`wardogs-qqbot` / `wardogs-anticheat-cron`）；GitHub Secret 同名 |
| 面板 token | Workers secret `ADMIN_TOKEN`（32 位随机，仅本服务使用，独立于 anticheat `/dashboard`） |

- **QQ 机器人**（`D:/wardogs-qqbot`）：`/ban <steamId 或 steam 名字> <理由序号 1–8>` → Nightwatch 永久封 + 联合库提交；不带序号只回理由表；`/unban` → NW 解封 + 撤销本服联合记录。
- **反作弊 cron**（`D:/wardogs-anti-cheat`）：每分钟拿在线名单对照联合库，命中 `cheat` 默认**踢出**（理由 `来自社区服联合反作弊数据: cheat`）；可用 D1 `settings.banshare_reasons` 放开到别的 reason，`flag banshare_enforce='0'` 一键关；本地白名单 = 豁免名单（含赞助商/预留位）+ `settings.banshareWhitelist`。region.ts 自己判定的 Steam 风险永久封会以 `steamrisk` 上报。

## 决策记录

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-10-20 | Ban 名单只做情报，不自动踢人；不做公开匿名查询 | SteamID64 属个人信息；执行策略归各服 |
| 2026-10-21 | **本地未提交、未部署的内容里出现密钥不算泄露**，不轮换、不脱敏 | 只有进了 git 或部署出去才算暴露；`opencode-history/` 等本地导出属资料，已 gitignore |
| 2026-10-21 | `check-secrets` 改为只扫 git 可见文件 | 原实现遍历工作树，把 gitignore 的本地转录音频报成 CI 红灯（假阳性） |
| 2026-10-21 | 不把 pinned 的桌面会话 `/handoff` 到 QQ，改用本文件当跨会话锚点 | 那个会话只有 2 条导入消息；handoff 会顶掉当前 QQ 会话，收益为零 |
| 2026-10-21 | 对话历史导出留在 `opencode-history/`（gitignored） | 真历史在 opencode 导出里，导入的 Hermes 会话只有摘要 |
| 2026-10-21 | 面板 ADMIN_TOKEN 独立于 anticheat `/dashboard`，各自轮换 | 一处泄露不影响另一处；面板只发/吊销 key、撤 ban |
| 2026-10-21 | 联合库记录默认只对 `cheat` 执行踢出，其他 reason 只当情报 | 名单是提示不是判决；要更严就改 `settings.banshare_reasons`，不改代码 |

## 怎么继续

1. 先读本文件 + `docs/ROADMAP.md`，再看 `git log --oneline -5`。
2. 改动前先对齐范围；`npm run ci` 必须绿。
3. 提交信息说清「做了什么 / 为什么」；push 到 `main` 即自动部署，注意 D1 迁移也会自动跑。
4. 密钥只写 `.env` / Workers Secrets；`check:secrets` 会在 CI 拦截 git 里的凭据。
