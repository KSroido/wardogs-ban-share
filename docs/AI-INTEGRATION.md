# 接入 AI 读本（AI-INTEGRATION）

> 给**接入方服务器自己的 AI/自动化助手**看的一页纸：怎么拿 key、怎么提交 ban、怎么拉名单、
> 哪些字段不能猜。人读版本见 [ONBOARDING.md](ONBOARDING.md)，完整契约见 [openapi.yaml](openapi.yaml)。
>
> 你（AI）可以按本文直接写代码，但**不要**自己尝试注册、探测别人的 key、或修改联盟数据。

---

## 0. 先确认三件事

| 问题 | 答案 |
|---|---|
| 我的成员服 id 是什么？ | 审核通过时维护者会告诉你（形如 `wardogs-main`），**创建后不能改** |
| 我的 key 覆盖范围是什么？ | 一枚 key 对应「一个管理方 + 一个地理位置」（组 key），或只对应一台服（单服 key） |
| 我的地理位置是什么？ | 写进成员服记录，别人拉 ban 时能看到；用来判断「外籍服」 |

**key 从哪来**：仓库 <https://github.com/KSroido/wardogs-ban-share> 的维护者在下发时**私密**给你。
不要从公开渠道拿 key，也不要把它写进代码/仓库/日志。

---

## 1. 基础信息

| 项 | 值 |
|---|---|
| Base URL | `https://wardogs.ksroido.art/api/ban-share/v1` |
| 认证 | `Authorization: Bearer wdb_...` |
| 请求体 | `Content-Type: application/json` |
| 响应 | JSON；每个响应带 `x-request-id`，报障时贴这个 |
| 时间 | 全部 UTC，ISO 8601（`2026-10-21T11:00:00.000Z`） |

---

## 2. reason 枚举（服务端固定，不能自造）

| # | key | 含义 | 是否推断 |
|---|---|---|---|
| 1 | `cheat` | 外挂/透视/自瞄/宏/改档 | 事实类 |
| 2 | `rulebreak` | 卡 BUG、刷物资、恶意卡点、违反服规 | 事实类 |
| 3 | `chattroll` | 刷屏、辱骂、引战 | 事实类 |
| 4 | `gametroll` | 队友伤害、堵门、故意送、破坏对局 | 事实类 |
| 5 | `racism` | 种族/国籍侮辱 | 事实类 |
| 6 | `foreignofserverlocation` | 账号/地区不在本服目标区域（外籍服） | **推断，误伤率高** |
| 7 | `steamrisk` | VAC/游戏封禁、小号、异常库存 | **推断** |
| 8 | `ownreason` | 其他（**必须**在 `note` 里写清楚） | 人工判断 |

> 联盟的定位是**情报**不是判决：不要仅凭 `foreignofserverlocation` / `steamrisk` 自动永久封禁。

---

## 3. 提交 ban

`POST /v1/bans`

```json
{
  "server_id": "wardogs-main",
  "bans": [
    {
      "steam_id": "76561198000000000",
      "reason": "cheat",
      "permanent": true,
      "note": "2026-10-21 03:12 自瞄，录像片段已存",
      "player_name": "SomePlayer",
      "evidence_url": "https://example.com/clip/123",
      "external_case_id": "case-20261021-0007"
    }
  ]
}
```

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `server_id` | **组 key 必填** | 你的成员服 id。组 key（同管理方+同位置多台服）不填会 `400 server_id_required`；单服 key 可省略 |
| `bans` | 是 | 1–100 条，逐条独立校验 |
| `steam_id` | 是 | SteamID64，17 位，`7656119` 开头 |
| `reason` | 是 | 上表的 key |
| `permanent` | 是 | `true` 或 `false` |
| `duration_days` | 限期时必填 | 1–36500；`permanent: true` 时必须省略 |
| `note` | `ownreason` 时必填 | ≤1000 字，写清楚证据 |
| `player_name` | 否 | 游戏内昵称，≤64 字 |
| `evidence_url` | 否 | ≤512 字符 |
| `external_case_id` | 建议 | 你方的工单号（`[A-Za-z0-9._:-]`，≤128）；重试带上同一个 → 不会写出第二条 |

状态码：

| 码 | 含义 | 你怎么处理 |
|---|---|---|
| `201` | 至少一条新建 | 成功 |
| `200` | 全是重复（已存在同服同玩家的生效记录 / 同 `external_case_id`） | 当成成功，不要重试 |
| `207` | 部分成功、部分失败 | 读 `errors[]` 逐条处理，别整批重试 |
| `422` | 全部校验失败 | 按 `errors[].message` 修数据 |
| `401/403` | key 无效/被吊销/服被除名/跨组 | **停下**，找维护者，不要重试 |

幂等建议：`external_case_id` 用你们自己的案件号；网络超时重试时原样带上。

---

## 4. 拉取（增量同步）

```
GET /v1/bans?status=all&since=<上次的 server_time>&limit=200
```

- **一定要用 `status=all`**，否则看不到「撤销」；撤销是软删除，记录还在。
- 把响应里的 `server_time` 存下来，下次作为 `since`。也可以用 `cursor`（响应里的 `next_cursor`）。
- 记录按 `(updated_at, id)` 升序，返回 `data[]`；每条 `ban.server` 带 `{id, name, location}` —— `location` 用来判断是不是外籍服。
- 只查某个玩家：`GET /v1/bans?steam_id=<id>&status=active`（逗号分隔最多 50 个）。
- 按 reason 过滤：`reason=cheat,steamrisk`。

玩家聚合（进服拦截用这个最快）：

```
GET /v1/players/76561198000000000
→ { steam_id, reports: { active_server_count, permanent_count, reason_counts:{...} }, bans: [...] }
```

成员服名录（含位置）：`GET /v1/servers` → `data[]`，每项 `{id, name, owner, location, status}`。

---

## 5. 撤销

```
POST /v1/bans/<ban_id>/revoke
{ "reason": "误封：录像复核为正常操作" }
```

只能撤自己 key 覆盖范围（本组）的记录，撤别人的 → `403`。

---

## 6. 本地白名单

SDK 支持把「本服免检的玩家」放在本地，命中时**不发起任何请求**：

- TS：`new BanListClient({ baseUrl, apiKey, whitelist: ['7656…'] })`
- Python：`BanListClient(base_url, api_key, whitelist=["7656…"])`
- Go：`banlist.NewWithWhitelist(baseURL, apiKey, ids)`

白名单只影响**读**（不查、不拦），不影响**写**（该举报的还是举报）。

---

## 7. 最小可运行示例

```bash
# 提交
curl -sS -X POST https://wardogs.ksroido.art/api/ban-share/v1/bans \
  -H "Authorization: Bearer $BANLIST_KEY" \
  -H 'content-type: application/json' \
  -d '{"server_id":"your-server","bans":[{"steam_id":"76561198000000000","reason":"cheat","permanent":true,"note":"aimbot"}]}'

# 拉增量
curl -sS "https://wardogs.ksroido.art/api/ban-share/v1/bans?status=all&since=2026-10-21T00:00:00.000Z&limit=200" \
  -H "Authorization: Bearer $BANLIST_KEY"
```

TypeScript：

```ts
import { BanListClient } from '@wardogs/banlist';

const client = new BanListClient({ baseUrl, apiKey: process.env.BANLIST_KEY!, whitelist: [] });
await client.submitBans(
  [{ steam_id: '76561198000000000', reason: 'cheat', permanent: true }],
  { serverId: 'your-server' },
);
const page = await client.listBans({ status: 'all', since: cursor });
cursor = page.server_time;
```

Python / Go 的完整示例在 [../examples](../examples)（`submit` 与 `pull` 各一份）。

---

## 8. 硬性约束（写代码时别违反）

1. **key 只进环境变量/secret**，不写进仓库、不打印日志、不发到聊天。
2. 不要在客户端硬编码联盟地址之外的镜像；只有 `https://wardogs.ksroido.art/api/ban-share` 是官方。
3. 不要批量转卖/公开导出名单；仅用于本服的反作弊与社区管理。
4. 误封自己撤，联盟不替你裁决申诉。
5. 频率：目前没有服务端限流（ROADMAP P0），**请自觉**：读 ≤300 次/分、写 ≤60 次/分，增量同步间隔 ≥1 分钟。
6. 遇到 `server_id_required` 就是组 key 没带 `server_id`，加上即可，不要改 key。
