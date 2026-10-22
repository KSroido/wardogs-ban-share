# Wardogs Ban Share

某个服封掉的外挂，隔壁服往往要等他进来、杀了人、被人举报，才知道这人早就该拦。

这个仓库把封禁记录放进一个成员服共享的库：谁封的、为什么、封多久、还有多少服封过他，一次查清。玩家在进服前就能被拦下，而不是在论坛上被追问。

线上地址 `https://wardogs.ksroido.art/api/ban-share`，维护者面板在 <https://wardogs.ksroido.art/ban-share>。

## 一条记录长这样

```bash
curl -X POST https://wardogs.ksroido.art/api/ban-share/v1/bans \
  -H "Authorization: Bearer wdb_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "bans": [{
      "steam_id": "76561198000000001",
      "reason": "cheat",
      "permanent": true,
      "player_name": "example_player",
      "note": "自瞄，录像已附",
      "evidence_url": "https://example.com/clips/aimbot.mp4",
      "external_case_id": "case-2026-10-19-001"
    }]
  }'
```

返回值里最该看的是 `reports`：

```json
{
  "created": [{
    "id": "ban_01J...",
    "server": { "id": "wardogs", "name": "Wardogs 社区服" },
    "steam_id": "76561198000000001",
    "reason": "cheat",
    "status": "active",
    "reports": { "server_count": 3, "active_server_count": 2, "ban_count": 4 }
  }],
  "duplicates": [],
  "errors": []
}
```

`server_count: 3` 的意思是这号已经被三个服封过。它是判断风险的依据，不是判决书，踢不踢由你自己定。

## 接入要做的三件事

1. 找维护者要一枚 `wdb_` 开头的 key。key 绑的是「管理方 + 地理位置」这一组，不是某一台服。同组有多台服时，提交要带 `server_id` 说明是哪台；写别的组的服会 403。
2. 有封禁就往 `POST /v1/bans` 推。一次最多 100 条，带 `external_case_id` 就天然幂等，网络重试不会写出第二条。
3. 玩家进服前查一次 `GET /v1/bans?steam_id=...`，一次最多 50 个 ID。查到 `active` 的记录，再看 `reports.server_count` 决定怎么处理。

想先跑通再接真实数据，找维护者要一枚**测试 key**：提交照常校验但只回 HTTP 200 和合成记录，拉取只给你一条演示记录，`/v1/servers` 也只返回沙盒那台服。这类请求除认证那一条查询外完全不碰数据库，详情见 [docs/API.md](docs/API.md#测试-key沙盒)。

增量同步用 `since` 加游标翻页：

```bash
curl -G https://wardogs.ksroido.art/api/ban-share/v1/bans \
  -H "Authorization: Bearer wdb_xxxxx" \
  --data-urlencode "status=all" \
  --data-urlencode "since=2026-10-01T00:00:00.000Z" \
  --data-urlencode "limit=500"
```

`status` 一定写 `all`。只拉 `active` 的话，你永远学不到「某条 ban 已经被撤销」，本地黑名单只会越来越脏。

## 三套 SDK 都在本仓库的 Releases 里

没有上传到 npm、PyPI 或 Go 的模块代理，安装包直接挂在 [Releases](https://github.com/KSroido/wardogs-ban-share/releases) 上，每个包带 sha256 校验清单。

TypeScript，`packages/sdk-ts/`：

```bash
npm i https://github.com/KSroido/wardogs-ban-share/releases/download/v0.1.1/wardogs-banlist-0.1.1.tgz
```

```ts
import { BanListClient } from '@wardogs/banlist';

const client = new BanListClient({
  baseUrl: 'https://wardogs.ksroido.art/api/ban-share',
  apiKey: process.env.BANLIST_KEY!,
});

// 进服前：自动按 50 个一批查，命中本地白名单的一个请求都不发
const hits = await client.lookupSteamIds(['76561198000000001']);

// 全量同步：拿到的是异步迭代器，翻页不用自己写
for await (const ban of client.iterateBans({ status: 'all', since: lastSeen })) {
  upsert(ban);
}
```

`lookupSteamIds` 内部按 50 切块，`iterateBans` 自动跟游标，5xx 按退避重试。

Python，`sdks/python/`，纯标准库：

```bash
pip install https://github.com/KSroido/wardogs-ban-share/releases/download/v0.1.1/wardogs_banlist-0.1.1-py3-none-any.whl
```

```python
from wardogs_banlist import BanListClient

client = BanListClient(base_url="https://wardogs.ksroido.art/api/ban-share", api_key=key)

for ban in client.iter_bans(status="all", since=last_seen):
    upsert(ban)                    # 按 id 覆盖，按 status 决定加还是删

detail = client.get_player("76561198000000001")
```

Go，`sdks/go/banlist`，只用 `net/http`：

```bash
go get github.com/KSroido/wardogs-ban-share/sdks/go/banlist@v0.1.1
```

```go
client := banlist.NewWithWhitelistFile(baseURL, apiKey, "./whitelist.txt")

err := client.ForEachBan(ctx, banlist.ListBansQuery{Status: "all", Since: lastSeen}, func(b banlist.Ban) error {
    return upsert(b)
})

hits, err := client.LookupSteamIDs(ctx, ids)
```

三种语言的「提交」和「拉取」完整脚本在 [`examples/`](examples/)，环境变量是 `BANLIST_KEY`。

打包发版走 `node scripts/release.mjs`：先跑完三套测试（TS/API、Python、Go）才写产物，任何一步失败都不出包。

## 本地白名单

自己的服总有几个不想拦的老玩家，或者 bots 的副号。白名单放在你这边，服务端不知道它存在：整批命中时一次 HTTP 都不会发生，而且不会伪造任何 ban 数据，只标 `whitelisted: true`。TS 可以传数组或文件路径，文件每行一个 ID，`#` 开头当注释；Python 用 `set_whitelist`，Go 用 `NewWithWhitelistFile`。

## reason 只有这八个

| 值 | 意思 | 备注 |
|---|---|---|
| `cheat` | 作弊、外挂 | 建议附证据 |
| `rulebreak` | 违反服规 | |
| `chattroll` | 聊天辱骂、刷屏 | |
| `gametroll` | TK、堵门这类恶意行为 | |
| `racism` | 种族歧视言论 | |
| `foreignofserverlocation` | 非目标语言或地区的玩家 | 推断性标签，误伤率高 |
| `steamrisk` | 小号、疑似被盗号 | 推断性标签，不能单独当封禁理由 |
| `ownreason` | 其他 | `note` 必填 |

后两个是主观判断。客户端默认只提示、不自动踢，你也该这么用。

## HTTP 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/v1/bans` | 批量提交，部分失败返回 `207` 和逐条错误 |
| `GET` | `/v1/bans` | 按 `since`、游标、`steam_id`、`reason`、`server` 查 |
| `POST` | `/v1/bans/:id/revoke` | 撤销自己服的记录 |
| `GET` | `/v1/players/:steam_id` | 一个人的聚合数据加原始记录 |
| `GET` | `/v1/players` | 排行，`sort=servers\|active_servers\|bans\|active_bans\|last_reported_at` |
| `GET` | `/v1/servers` | 联盟里有谁 |
| `GET` | `/health` | 不需要 key |

`/admin/*` 是维护者用的，走 `x-admin-token`，不对外。字段级细节和错误码在 [docs/API.md](docs/API.md)，机器可读的契约是 [docs/openapi.yaml](docs/openapi.yaml)。

## 几个约束，写在明处

- `steam_id` 是 17 位字符串，必须以 `7656119` 开头。用 JS number 传会丢精度。
- 时长二选一：`permanent: true`，或者 `duration_days`（1 到 36500），`expires_at` 由服务端算。
- 状态是算出来的：有 `revoked_at` 就是 `revoked`，过了 `expires_at` 就是 `expired`，否则 `active`。
- 已提交的记录不能改。改判就是撤销旧的、提交新的。
- 证据只存 URL，不托管文件。
- 没有限流，也没有 webhook。key 泄露在吊销之前能一直写，所以泄露了要马上换。
- 只有一个 D1 实例，五张表（`servers`、`api_keys`、`bans`、`player_stats`、`audit_log`）。`api_keys` 里只有 `SHA-256(key)` 和前 8 位前缀，明文只在签发那一次返回。`player_stats` 是读模型，每天 04:00 UTC 重建。

## 本地跑起来

```bash
npm install
npm run migrate:local
cp apps/api/.dev.vars.example apps/api/.dev.vars   # 改掉默认 token，至少 24 位
npm run dev                                        # http://127.0.0.1:8787/api/ban-share

# 另开一个终端
export ADMIN_TOKEN=...                    # 和 .dev.vars 里的一样
export BANLIST_ADMIN_URL=http://127.0.0.1:8787
node scripts/admin.mjs create-server --name "Test Server" --id test-server
node scripts/admin.mjs issue-key --server test-server --label local   # 输出的 wdb_ 只显示一次

npm run ci                                # 密钥扫描 + typecheck + 22 个 TS 测试
```

部署、域名、secret 怎么配看 [docs/DEPLOY.md](docs/DEPLOY.md)。接一个新服要走什么流程看 [docs/ONBOARDING.md](docs/ONBOARDING.md)。想知道线上现在什么状态看 [docs/STATUS.md](docs/STATUS.md)。想让 AI 助手帮你接入，让它先读 [docs/AI-INTEGRATION.md](docs/AI-INTEGRATION.md)。

## 密钥

API key 和 `ADMIN_TOKEN` 都不进仓库。`npm run check:secrets` 会在 CI 里拦下疑似凭据，漏洞报告方式见 [SECURITY.md](SECURITY.md)。SteamID64 算个人信息，读接口要 key，没有匿名公开名单。

MIT
