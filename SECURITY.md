# 安全策略

## 项目须知：禁止提交密钥

这是一个公开仓库。以下内容**永远不能**出现在提交里：

- Cloudflare API Token（`cfut_...`）、Global API Key
- GitHub Token（`ghp_...`、`github_pat_...`）
- 本项目签发的服务器 key（`wdb_...`）
- `ADMIN_TOKEN`
- 任何私钥、`.dev.vars`、`.env`、D1 导出文件

提交前本地跑：

```bash
npm run check:secrets
```

CI（Workers Builds 的 `npm run ci`）也会跑同一个脚本，发现疑似凭据会直接失败。

如果不小心提交了：

1. **立刻轮换**该凭据（不是删 commit 就安全了，历史里仍然存在）；
2. 用 `git filter-repo` 或 BFG 清理历史；
3. 检查 Cloudflare 审计日志 / GitHub 安全日志是否有异常使用；
4. 在安全渠道通知维护者。

## 密钥模型

| 凭据 | 存储位置 | 泄露后的影响 | 处置 |
|---|---|---|---|
| 服务器 API key | D1 里只有 `sha256(key)` + 8 位前缀 | 可以以该服身份读写，直到被吊销 | `revoke-key`，重新签发 |
| `ADMIN_TOKEN` | Worker Secret | 完全控制（建服、发 key、撤记录） | `wrangler secret put` 覆盖，旧值立即失效 |
| Cloudflare API Token | 只在部署环境 / 本机 | 取决于 scope，可能控制整个账号 | Cloudflare Dashboard 轮换 |
| GitHub Token | 只在推送时使用 | 取决于 scope，可能改仓库 | GitHub Settings 轮换 |

### API key

- 32 字节随机（`wdb_` + base64url），256 位熵；
- 用 SHA-256 存储。因为熵足够高，不需要慢哈希；
- 前缀（8 位）只用于索引，认证仍然比较完整哈希；
- 每个 key 绑定一个服务器，提交时无法冒充其他服；
- 支持多 key（便于按机器吊销）、`last_used_at`（每小时最多更新一次）。

### 管理员令牌

- 至少 24 字符，推荐 32 字节随机；
- 请求头 `X-Admin-Token` 或 `Authorization: Bearer`；
- 比较时先哈希，避免长度泄漏；
- 所有管理路由统一鉴权，未配置时返回 `503`，不会降级为“无鉴权”。

## 数据与隐私

- **SteamID64 是个人信息**。读接口需要成员 key，不提供匿名公开名单。
- 提交的 `player_name`、`note`、`evidence_url` 会展示给所有成员服；不要写无关的个人信息。
- 证据只存 URL，联盟不托管文件；请确保链接本身不包含敏感 token（例如带签名的私有链接会过期或泄露）。
- 日志里不要打印完整 key；`audit_log` 只记录 `key_id`。
- D1 导出文件包含全部数据，必须存放在私有位置，禁止提交。

## 滥用与治理

- 误封由上报服负责撤销；联盟提供 `revoke` 和审计，但不替成员服裁决申诉。
- 恶意上报、批量刷记录、泄露名单的服务器会被 `defederated`：所有 key 立即失效，历史记录保留但标注来源。
- 发现某个来源不可信时，接入方可以按 `server.id` 过滤。

## 报告漏洞

请不要在公开 Issue 里贴利用细节或真实 key。通过仓库维护者的私密联系方式报告，或开一个只写“需要安全联系方式”的 Issue。

请包含：

- 受影响的端点 / 版本；
- 复现步骤（不要用真实玩家数据）；
- 影响评估；
- 你希望的披露时间。

我们会在确认后尽快修复，并在致谢里注明（如果你愿意）。

## 部署安全清单

见 [docs/DEPLOY.md](docs/DEPLOY.md#9-安全清单上线前)。
