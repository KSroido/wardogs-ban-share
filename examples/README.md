# 示例

“提交 ban” 和 “拉取 ban” 两个场景，各三种语言。都直接指向线上 API，换成自己的 `BANLIST_URL` 即可。

| 语言 | 提交 | 拉取 |
|---|---|---|
| TypeScript | [`ts/submit.ts`](ts/submit.ts) | [`ts/pull.ts`](ts/pull.ts) |
| Python | [`python/submit.py`](python/submit.py) | [`python/pull.py`](python/pull.py) |
| Go | [`go/submit/main.go`](go/submit/main.go) | [`go/pull/main.go`](go/pull/main.go) |

密钥从环境变量读，**不要**写进文件：

```bash
export BANLIST_URL=https://wardogs.ksroido.art/api/ban-share
export BANLIST_KEY=wdb_...
```

## TypeScript

```bash
npm install                    # 仓库根目录，装 workspace 依赖
cd examples/ts
npx tsx submit.ts
npx tsx pull.ts
npx tsx pull.ts 2026-10-01T00:00:00.000Z   # 增量
```

## Python

纯标准库，不需要 `pip install`；脚本会自动把 `sdks/python` 加进 `sys.path`。

```bash
python examples/python/submit.py
python examples/python/pull.py
python examples/python/pull.py 2026-10-01T00:00:00.000Z
```

## Go

`examples/go/go.mod` 通过 `replace` 指向本地 SDK，不需要先发布。

```bash
cd examples/go
go run ./submit
go run ./pull
go run ./pull 2026-10-01T00:00:00.000Z
```

## 拉取示例做了什么

1. 用 `status=all` 拉取（包含 `revoked`，否则撤销永远同步不到）；
2. 自动跟 `next_cursor` 翻页；
3. 打印 `server` / `reason` / `duration` / `status` / `reports.server_count`；
4. 最后列出被最多服务器举报的玩家。

生产环境不要把结果只打印出来：按 `ban.id` upsert 到本地表，用 `status` 决定加入或移出黑名单。完整思路见 [`docs/ONBOARDING.md`](../docs/ONBOARDING.md#5-增量同步)。
