# 贡献指南

感谢你愿意改进 Wardogs Ban Share。这个项目是给多个社区服共用的，稳定性和“可预测的行为”比功能数量更重要。

## 项目须知

**禁止把任何密钥写进仓库。** 包括但不限于：Cloudflare token、GitHub token、`ADMIN_TOKEN`、`wdb_` 服务器 key、私钥、`.dev.vars`、D1 导出文件。

提交前必须通过：

```bash
npm run check:secrets
```

CI 会跑同一条命令。发现疑似凭据会直接失败。

## 开发环境

```bash
npm install
npm run migrate:local
cp apps/api/.dev.vars.example apps/api/.dev.vars   # 改掉默认 token
npm run dev
```

- Node.js ≥ 20
- Python ≥ 3.9（改 Python SDK 时）
- Go ≥ 1.21（改 Go SDK 时）
- Wrangler 已包含在 devDependencies 里，不需要全局安装

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地 Worker（`http://127.0.0.1:8787`） |
| `npm run ci` | 密钥扫描 + typecheck + TS 测试 |
| `npm test` | 只跑 TS 测试 |
| `npm run typecheck` | 只跑类型检查 |
| `npm run migrate:local` / `migrate:remote` | 应用 D1 迁移 |
| `npm run deploy` | 手动部署 |
| `npm run build:sdk` | 构建 TS SDK |

Python：

```bash
cd sdks/python
python -m unittest discover -s tests -v
```

Go：

```bash
cd sdks/go
go test ./...
```

## 代码结构

- `apps/api/src/routes/`：路由。每个文件只负责一组端点。
- `apps/api/src/validation.ts`：所有输入校验。**不要**在路由里临时写正则。
- `apps/api/src/mappers.ts`：行 → JSON。状态是派生的，不存 `expired`。
- `apps/api/src/stats.ts`：`player_stats` 读模型。任何写入 ban 的路径都必须刷新该玩家。
- `packages/sdk-ts/src/types.ts`：线上契约的单一来源。改字段时先改这里，再同步 Python/Go 和 OpenAPI。
- `apps/api/migrations/`：只增不改。已发布的迁移不要编辑。

## 修改契约的流程

1. 先改 `packages/sdk-ts/src/types.ts`（wire types）。
2. 改 `apps/api/src/validation.ts` 和对应路由。
3. 同步 `sdks/python/wardogs_banlist/models.py`、`sdks/go/banlist/types.go`。
4. 更新 `docs/openapi.yaml` 和 `docs/API.md`。
5. 补测试：校验、路由（如可）、SDK 解析。
6. 在 PR 描述里写清楚是否破坏兼容性。

兼容性规则：

- 新增字段：向后兼容，客户端应忽略未知字段。
- 改字段语义 / 删除字段 / 改状态码：破坏性，需要 `/v2` 或明确的迁移说明。
- 排序键、游标格式不要随意改。

## 迁移规则

- 文件名：`000N_short_description.sql`，按顺序递增。
- 已合并且已应用到生产的迁移**不可修改**；需要修复就加新迁移。
- D1 对 `GLOB` 模式复杂度有限制，避免长字符类；用 `length()` + 前缀 + 非数字检查代替。
- 重建表的迁移要显式复制所有列、重建所有索引。

## 测试要求

- 纯函数（校验、mapper）必须有单元测试。
- 修 bug 时先写能复现的测试。
- SDK 改动要保证三套实现的字段名、默认值、错误码一致。
- 涉及 D1 的改动，至少手动走一遍：迁移 → 建服 → 发 key → 提交 → 拉取 → 撤销 → 重建索引。

## 代码风格

- TypeScript：严格模式，不用 `any`（除非有注释说明）。
- 所有时间用 ISO 8601 UTC 字符串；SteamID 全程字符串。
- 错误用 `ApiError`（服务端）或 `BanListError`（SDK），带稳定的 `code`。
- 注释解释“为什么”，不解释“是什么”。
- 不引入不必要的依赖；Python SDK 保持纯标准库。

## PR 清单

- [ ] `npm run ci` 通过
- [ ] 相关 Python / Go 测试通过（如果改了对应 SDK）
- [ ] 没有提交任何密钥或本地环境文件
- [ ] 迁移是新增的，没有改历史迁移
- [ ] 契约变更同步了 OpenAPI / API.md / 三语言类型
- [ ] PR 描述包含：动机、行为变化、如何验证、是否破坏兼容

## 提交信息

用简短的祈使句，例如：

```
Add ban revoke reason to audit log
Fix D1 GLOB limit in steam_id check
```

一个 PR 只做一件事。大的重构先开 Issue 讨论。
