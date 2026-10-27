import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { generateApiKey, hashSecret, keyPrefix } from '../crypto';
import { logAudit } from '../db';
import { newId } from '../ids';
import { parseLocation, parseOwner } from '../validation';

/**
 * 维护者管理面板（`https://wardogs.ksroido.art/ban-share`）。
 *
 * 登录凭证 = 本 Worker 自己的 secret `ADMIN_TOKEN`（32 位随机串，与 anticheat `/dashboard`
 * 的 token 相互独立 —— 泄露一个不影响另一个）。三种传法任意：
 *   - `?token=<ADMIN_TOKEN>`（和其它 dashboard 一致，最顺手）
 *   - `Authorization: Bearer <ADMIN_TOKEN>`
 *   - 登录表单 → HttpOnly cookie（12 小时，Path=/ban-share）
 *
 * 面板只做四件事：建成员服、发/吊销 key、紧急撤销 ban、看审计。所有写操作落 audit_log，
 * 与 `/api/ban-share/admin/*` 共用同一批表，不另开旁路。
 */

const COOKIE = 'bs_admin';
const COOKIE_MAX_AGE = 12 * 60 * 60;
/** 勾了「记住我」给 30 天；浏览器密码管理器保存的是同一个 token，两者互不影响 */
const COOKIE_REMEMBER_AGE = 30 * 24 * 60 * 60;
const SESSION_PATH = '/ban-share';

export const panelRoutes = new Hono<AppEnv>();

panelRoutes.get('/', async (c) => {
  const ok = await isAdmin(c);
  if (!ok) return c.html(loginPage(noticeFor(c)), 200);
  return c.html(await dashboardPage(c), 200);
});

panelRoutes.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token || !(await tokenMatches(c, token))) {
    return c.html(loginPage('token 不对（或者服务端没配 ADMIN_TOKEN）'), 401);
  }
  // 「记住我」→ 30 天持久 cookie；不勾 → 会话 cookie（关浏览器即失效）
  const remember = body.remember !== undefined;
  const maxAge = remember ? `; Max-Age=${COOKIE_REMEMBER_AGE}` : '';
  c.header(
    'set-cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=${SESSION_PATH}; HttpOnly; Secure; SameSite=Lax${maxAge}`,
  );
  return c.redirect(SESSION_PATH, 303);
});

panelRoutes.post('/logout', async (c) => {
  c.header('set-cookie', `${COOKIE}=; Path=${SESSION_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return c.redirect(SESSION_PATH, 303);
});

/** 建成员服（id 可选；不填按名字生成并自动去重） */
panelRoutes.post('/servers', async (c) => {
  if (!(await isAdmin(c))) return c.html(loginPage('登录已过期，请重新登录'), 401);

  const body = await c.req.parseBody();
  const name = str(body.name).trim();
  const note = str(body.note).trim() || null;
  const wanted = str(body.id).trim();

  if (name.length < 2 || name.length > 64) {
    return c.html(await dashboardPage(c, '服务器名字要 2–64 个字符'), 400);
  }
  if (wanted && !/^[a-z0-9][a-z0-9-]{1,23}$/.test(wanted)) {
    return c.html(await dashboardPage(c, 'id 只能用小写字母/数字/连字符（2–24 位）'), 400);
  }

  const db = c.env.DB;
  const id = wanted || (await allocateServerId(db, slugify(name)));

  // 接入申请必填：地理位置；管理方不填就当这台服自己一个管理方
  let location: string;
  let owner: string;
  try {
    location = parseLocation(str(body.location));
    owner = str(body.owner).trim() ? parseOwner(str(body.owner)) : id;
  } catch (error) {
    return c.html(await dashboardPage(c, `位置/管理方不合法：${esc((error as Error).message)}`), 400);
  }

  if (wanted) {
    const exists = await db.prepare('SELECT 1 AS x FROM servers WHERE id = ?').bind(wanted).first();
    if (exists) return c.html(await dashboardPage(c, `服务器 id「${esc(wanted)}」已存在`), 409);
  }

  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO servers (id, name, owner, location, status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(id, name, owner, location, note, nowIso, nowIso)
    .run();

  await logAudit(db, { actorType: 'admin', actorId: 'panel', action: 'server.create', target: id, detail: { name } });
  return c.html(
    await dashboardPage(c, `已建服：${esc(name)}（id=${esc(id)}，管理方=${esc(owner)}，位置=${esc(location)}）`),
    201,
  );
});

/** 发 key：明文只渲染这一次，库里只留 SHA-256 与前缀 */
panelRoutes.post('/keys', async (c) => {
  if (!(await isAdmin(c))) return c.html(loginPage('登录已过期，请重新登录'), 401);

  const body = await c.req.parseBody();
  const serverId = str(body.server_id).trim();
  const label = str(body.label).trim() || null;
  const asGroup = body.group !== undefined;

  const allowWrite = body.write !== undefined;
  const allowRead = body.read !== undefined;
  const scopes: string[] = [];
  if (allowRead) scopes.push('bans:read');
  if (allowWrite) scopes.push('bans:write');
  if (scopes.length === 0) scopes.push('bans:read');

  const db = c.env.DB;
  const server = await db
    .prepare('SELECT id, name, owner, location, status, note FROM servers WHERE id = ?')
    .bind(serverId)
    .first<{ id: string; name: string; owner: string | null; location: string | null; status: string; note: string | null }>();

  if (!server) return c.html(await dashboardPage(c, '没有这个服务器'), 404);
  if (server.status !== 'active') {
    return c.html(await dashboardPage(c, '这个服务器已被联邦除名，不能发 key'), 409);
  }

  if (asGroup && (!server.owner || !server.location)) {
    return c.html(await dashboardPage(c, '这台服没有管理方/位置，不能发组 key'), 409);
  }

  // 没填备注就用服务器备注，key 列表里不用显示空值
  const finalLabel = label || server.note?.trim().slice(0, 100) || null;

  const key = generateApiKey();
  const keyId = newId('key');
  const nowIso = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO api_keys (id, server_id, owner, location, prefix, key_hash, scopes, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      keyId,
      asGroup ? null : server.id,
      asGroup ? server.owner : null,
      asGroup ? server.location : null,
      keyPrefix(key),
      await hashSecret(key),
      scopes.join(' '),
      finalLabel,
      nowIso,
    )
    .run();

  await logAudit(db, {
    actorType: 'admin',
    actorId: 'panel',
    action: 'key.issue',
    target: keyId,
    detail: {
      server_id: asGroup ? null : server.id,
      group: asGroup,
      owner: asGroup ? server.owner : null,
      location: asGroup ? server.location : null,
      scopes,
      label: finalLabel,
    },
  });

  const scopeText = asGroup
    ? `${server.owner} @ ${server.location}（组 key，覆盖该管理方该位置下所有服）`
    : server.id;
  return c.html(issuedPage(server.name, scopeText, key, scopes, finalLabel), 201);
});

/**
 * 生成测试 key：沙盒专用。
 *
 * 跟成员 key 存同一张表（is_test = 1），但请求除认证那一条查询外不碰数据库 ——
 * 提交只校验并回合成记录，拉取只给一条演示数据。哨兵组 ('sandbox','sandbox')
 * 只是为了满足 api_keys 的 CHECK 约束，is_test 会在任何组逻辑之前短路。
 */
panelRoutes.post('/test-keys', async (c) => {
  if (!(await isAdmin(c))) return c.html(loginPage('登录已过期，请重新登录'), 401);

  const body = await c.req.parseBody();
  const label = str(body.label).trim().slice(0, 100) || null;
  const db = c.env.DB;
  const key = generateApiKey();
  const keyId = newId('key');
  const nowIso = new Date().toISOString();
  const scopes = ['bans:read', 'bans:write'];

  await db
    .prepare(
      `INSERT INTO api_keys (id, server_id, owner, location, prefix, key_hash, scopes, label, is_test, created_at)
       VALUES (?, NULL, 'sandbox', 'sandbox', ?, ?, ?, ?, 1, ?)`,
    )
    .bind(keyId, keyPrefix(key), await hashSecret(key), scopes.join(' '), label, nowIso)
    .run();

  await logAudit(db, {
    actorType: 'admin',
    actorId: 'panel',
    action: 'key.issue',
    target: keyId,
    detail: { test: true, scopes, label },
  });

  return c.html(testIssuedPage(key, label, Boolean(c.env.SANDBOX)), 201);
});

/** 改管理方 / 地理位置：建服时填错、或管理方转移时用；组 key 跟着 (owner, location) 走，无需重发 */
panelRoutes.post('/servers/update', async (c) => {
  if (!(await isAdmin(c))) return c.html(loginPage('登录已过期，请重新登录'), 401);

  const body = await c.req.parseBody();
  const id = str(body.server_id).trim();
  if (!id) return c.html(await dashboardPage(c, '缺服务器 id'), 400);

  let owner: string;
  let location: string;
  try {
    owner = parseOwner(str(body.owner));
    location = parseLocation(str(body.location));
  } catch (error) {
    return c.html(await dashboardPage(c, `管理方/位置不合法：${esc((error as Error).message)}`), 400);
  }

  const row = await c.env.DB.prepare('SELECT id, owner, location, note FROM servers WHERE id = ?')
    .bind(id)
    .first<{ id: string; owner: string | null; location: string | null; note: string | null }>();
  if (!row) return c.html(await dashboardPage(c, '没有这个服务器'), 404);

  // 备注：表单里带了这个字段才改（空字符串 = 清空），不带就保持原值
  const hasNote = body.note !== undefined || typeof body.note === 'string';
  const note = hasNote ? str(body.note).trim().slice(0, 500) || null : row.note;

  if (row.owner === owner && row.location === location && note === row.note) {
    return c.html(await dashboardPage(c, '管理方 / 位置 / 备注都没变'), 200);
  }

  const nowIso = new Date().toISOString();
  await c.env.DB.prepare('UPDATE servers SET owner = ?, location = ?, note = ?, updated_at = ? WHERE id = ?')
    .bind(owner, location, note, nowIso, id)
    .run();

  await logAudit(c.env.DB, {
    actorType: 'admin',
    actorId: 'panel',
    action: 'server.group_update',
    target: id,
    detail: {
      from: { owner: row.owner, location: row.location, note: row.note },
      to: { owner, location, note },
    },
  });

  return c.html(
    await dashboardPage(c, `已更新 ${esc(id)}：管理方=${esc(owner)}，位置=${esc(location)}${hasNote ? `，备注=${esc(note ?? '（空）')}` : ''}（组 key 自动跟着走）`),
    200,
  );
});

panelRoutes.post('/keys/revoke', async (c) => {
  if (!(await isAdmin(c))) return c.html(loginPage('登录已过期，请重新登录'), 401);

  const body = await c.req.parseBody();
  const id = str(body.key_id).trim();
  if (!id) return c.html(await dashboardPage(c, '缺 key id'), 400);

  const nowIso = new Date().toISOString();
  await c.env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(nowIso, id)
    .run();
  await logAudit(c.env.DB, { actorType: 'admin', actorId: 'panel', action: 'key.revoke', target: id });
  return c.html(await dashboardPage(c, '已吊销该 key'), 200);
});

/** 紧急撤销：维护者可以撤掉任何成员服的一条 ban */
panelRoutes.post('/bans/revoke', async (c) => {
  if (!(await isAdmin(c))) return c.html(loginPage('登录已过期，请重新登录'), 401);

  const body = await c.req.parseBody();
  const id = str(body.ban_id).trim();
  const reason = str(body.reason).trim() || '维护者紧急撤销';
  if (!id) return c.html(await dashboardPage(c, '缺 ban id'), 400);

  const nowIso = new Date().toISOString();
  const row = await c.env.DB.prepare('SELECT steam_id, status FROM bans WHERE id = ?')
    .bind(id)
    .first<{ steam_id: string; status: string }>();
  if (!row) return c.html(await dashboardPage(c, '没有这条 ban'), 404);

  if (row.status !== 'revoked') {
    await c.env.DB.prepare(
      `UPDATE bans SET status = 'revoked', revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso, reason, nowIso, id)
      .run();
    // 读模型跟着更新；失败不影响撤销本身
    await c.env.DB.prepare(`UPDATE player_stats SET updated_at = ? WHERE steam_id = ?`)
      .bind(nowIso, row.steam_id)
      .run()
      .catch(() => undefined);
  }

  await logAudit(c.env.DB, {
    actorType: 'admin',
    actorId: 'panel',
    action: 'ban.revoke',
    target: id,
    detail: { reason },
  });
  return c.html(await dashboardPage(c, `已撤销 ban ${esc(id)}`), 200);
});

// ---------------------------------------------------------------- auth

async function isAdmin(c: Context<AppEnv>): Promise<boolean> {
  const provided = providedToken(c);
  return provided ? tokenMatches(c, provided) : false;
}

function providedToken(c: Context<AppEnv>): string | null {
  const query = new URL(c.req.url).searchParams.get('token');
  if (query) return query;

  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (bearer) return bearer;

  const cookie = parseCookie(c.req.header('cookie') ?? '', COOKIE);
  if (cookie) return cookie;

  return c.req.header('x-admin-token') ?? null;
}

/** 哈希比较：长度和内容都不落进分支时序（token 本身是 32+ 位随机串） */
async function tokenMatches(c: Context<AppEnv>, provided: string): Promise<boolean> {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected || expected.length < 24) return false;
  const [a, b] = await Promise.all([hashSecret(expected), hashSecret(provided)]);
  return a === b;
}

function noticeFor(c: Context<AppEnv>): string {
  if (!c.env.ADMIN_TOKEN || c.env.ADMIN_TOKEN.length < 24) {
    return '服务端还没配 ADMIN_TOKEN（Worker secret），面板和 /admin API 都是关的。先 `wrangler secret put ADMIN_TOKEN`。';
  }
  if (new URL(c.req.url).searchParams.has('token')) return 'token 不对，或者已轮换。';
  return '';
}

// ---------------------------------------------------------------- pages

function loginPage(notice: string): string {
  return layout(
    '登录',
    `<form class="card login" method="post" action="${SESSION_PATH}/login">
       <h2>维护者登录</h2>
       <p class="muted">用联合 Ban 自己的 <code>ADMIN_TOKEN</code> 登录（和 <code>/dashboard</code> 的 token 不是同一个）。</p>
       ${
         notice
           ? `<p class="err">${esc(notice)}</p>`
           : ''
       }
       <label class="field">
         <span>用户名</span>
         <input name="username" type="text" value="maintainer" autocomplete="username" readonly>
       </label>
       <label class="field">
         <span>密码（ADMIN_TOKEN）</span>
         <input name="token" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password" autofocus required>
       </label>
       <label class="check"><input type="checkbox" name="remember" checked> 记住我（30 天）</label>
       <button type="submit">登录</button>
       <p class="muted small">
         浏览器会提示「保存密码」——用户名随便，密码就是这串 token，下次自动填。
         也可以直接在地址后面带 <code>?token=…</code>，或者用 <code>Authorization: Bearer …</code> 调 API。
       </p>
     </form>`,
  );
}

async function dashboardPage(c: Context<AppEnv>, flash = ''): Promise<string> {
  const db = c.env.DB;

  const servers = await db
    .prepare(
      `SELECT s.id, s.name, s.owner, s.location, s.status, s.note, s.created_at,
              (SELECT COUNT(*) FROM api_keys k WHERE k.server_id = s.id AND k.revoked_at IS NULL) AS active_keys,
              (SELECT COUNT(*) FROM bans b WHERE b.server_id = s.id) AS ban_count
         FROM servers s ORDER BY s.created_at ASC`,
    )
    .all<{ id: string; name: string; owner: string | null; location: string | null; status: string; note: string | null; created_at: string; active_keys: number; ban_count: number }>();

  const keys = await db
    .prepare(
      `SELECT k.id, k.server_id, k.owner, k.location, k.prefix, k.scopes, k.label, k.created_at, k.last_used_at, k.revoked_at, k.is_test
         FROM api_keys k ORDER BY k.created_at DESC LIMIT 50`,
    )
    .all<{ id: string; server_id: string | null; owner: string | null; location: string | null; prefix: string; scopes: string; label: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null; is_test: number }>();

  const bans = await db
    .prepare(
      `SELECT b.id, b.steam_id, b.reason, b.server_id, b.status, b.permanent, b.created_at, b.updated_at
         FROM bans b ORDER BY b.updated_at DESC LIMIT 15`,
    )
    .all<{ id: string; steam_id: string; reason: string; server_id: string; status: string; permanent: number; created_at: string; updated_at: string }>();

  const audit = await db
    .prepare(
      `SELECT actor_type, actor_id, action, target, created_at FROM audit_log ORDER BY created_at DESC LIMIT 15`,
    )
    .all<{ actor_type: string; actor_id: string; action: string; target: string | null; created_at: string }>();

  const serverNote = new Map<string, string>(
    (servers.results ?? []).map((s) => [s.id, s.note ?? '']),
  );

  const serverRows = (servers.results ?? [])
    .map(
      (s) => `<tr>
        <td><code>${esc(s.id)}</code></td>
        <td>${esc(s.name)}</td>
        <td><code>${esc(s.location ?? '—')}</code></td>
        <td class="muted">${esc(s.owner ?? '—')}</td>
        <td class="muted" title="${esc(s.note ?? '')}">${
          s.note ? esc(s.note.length > 28 ? `${s.note.slice(0, 28)}…` : s.note) : '—'
        }</td>
        <td>${s.status === 'active' ? '<span class="ok">active</span>' : '<span class="warn">defederated</span>'}</td>
        <td class="num">${s.active_keys}</td>
        <td class="num">${s.ban_count}</td>
        <td>
          ${
            s.status === 'active'
              ? `<form class="inline" method="post" action="${SESSION_PATH}/keys">
                   <input type="hidden" name="server_id" value="${esc(s.id)}">
                   <input name="label" placeholder="备注（可选）" size="12">
                   <label><input type="checkbox" name="read" checked> 读</label>
                   <label><input type="checkbox" name="write" checked> 写</label>
                   <label title="覆盖同管理方、同位置的所有服"><input type="checkbox" name="group"> 组 key</label>
                   <button type="submit">发 key</button>
                 </form>`
              : '<span class="muted">—</span>'
          }
        </td>
        <td>
          <details>
            <summary>改组</summary>
            <form class="inline" method="post" action="${SESSION_PATH}/servers/update">
              <input type="hidden" name="server_id" value="${esc(s.id)}">
              <input name="owner" value="${esc(s.owner ?? '')}" placeholder="管理方" size="10" required>
              <input name="location" value="${esc(s.location ?? '')}" placeholder="位置" size="8" required>
              <input name="note" value="${esc(s.note ?? '')}" placeholder="备注（会公开在 /v1/servers）" size="24">
              <button type="submit">保存</button>
            </form>
          </details>
        </td>
      </tr>`,
    )
    .join('');

  const keyRows = (keys.results ?? [])
    .map(
      (k) => `<tr>
        <td><code>wdb_${esc(k.prefix)}…</code></td>
        <td>${
          k.is_test
            ? '<span class="warn">测试</span> <span class="muted">沙盒，只读演示数据</span>'
            : k.server_id
              ? `<code>${esc(k.server_id)}</code>`
              : `<span class="ok">组</span> <span class="muted">${esc(k.owner ?? '')} @ ${esc(k.location ?? '')}</span>`
        }</td>
        <td>${esc(k.scopes)}</td>
        <td>${esc(k.label || (k.server_id ? serverNote.get(k.server_id) || '' : ''))}</td>
        <td class="muted">${esc(shortTime(k.created_at))}</td>
        <td class="muted">${esc(k.last_used_at ? shortTime(k.last_used_at) : '—')}</td>
        <td>${
          k.revoked_at
            ? `<span class="warn">已吊销 ${esc(shortTime(k.revoked_at))}</span>`
            : `<form class="inline" method="post" action="${SESSION_PATH}/keys/revoke">
                 <input type="hidden" name="key_id" value="${esc(k.id)}">
                 <button class="danger" type="submit">吊销</button>
               </form>`
        }</td>
      </tr>`,
    )
    .join('');

  const banRows = (bans.results ?? [])
    .map(
      (b) => `<tr>
        <td><code>${esc(b.steam_id)}</code></td>
        <td>${esc(b.reason)}</td>
        <td>${esc(b.server_id)}</td>
        <td>${b.permanent ? '永久' : '限期'}</td>
        <td>${b.status === 'active' ? '<span class="ok">active</span>' : '<span class="muted">revoked</span>'}</td>
        <td class="muted">${esc(shortTime(b.updated_at))}</td>
        <td>${
          b.status === 'active'
            ? `<form class="inline" method="post" action="${SESSION_PATH}/bans/revoke">
                 <input type="hidden" name="ban_id" value="${esc(b.id)}">
                 <input name="reason" placeholder="撤销理由" size="14">
                 <button class="danger" type="submit">撤销</button>
               </form>`
            : '—'
        }</td>
      </tr>`,
    )
    .join('');

  const auditRows = (audit.results ?? [])
    .map(
      (a) => `<tr>
        <td class="muted">${esc(shortTime(a.created_at))}</td>
        <td>${esc(a.actor_id)}</td>
        <td><code>${esc(a.action)}</code></td>
        <td class="muted">${esc(a.target ?? '—')}</td>
      </tr>`,
    )
    .join('');

  return layout(
    '管理面板',
    `<div class="toolbar">
       <span class="muted">登录中：ADMIN_TOKEN</span>
       <form class="inline" method="post" action="${SESSION_PATH}/logout"><button type="submit">退出</button></form>
     </div>
     ${flash ? `<p class="notice">${flash}</p>` : ''}

     <form class="card" method="post" action="${SESSION_PATH}/servers">
       <h2>建成员服</h2>
       <div class="row">
         <input name="name" placeholder="服务器名字（2–64 字）" required>
         <input name="id" placeholder="id（可选，小写字母/数字/连字符）">
       </div>
       <div class="row">
         <input name="owner" placeholder="管理方（可选，默认=id；同管理方同位置共用一个 key）">
         <input name="location" placeholder="地理位置（必填，例：cn / eu-frankfurt / us-west）" required>
       </div>
       <div class="row">
         <input name="note" placeholder="备注（可选）">
         <button type="submit">创建</button>
       </div>
     </form>

     <section class="card">
       <h2>成员服</h2>
       <table>
         <thead><tr><th>id</th><th>名字</th><th>位置</th><th>管理方</th><th>备注</th><th>状态</th><th>有效 key</th><th>ban 数</th><th>发 key</th><th>编辑</th></tr></thead>
         <tbody>${serverRows || `<tr><td colspan="10" class="muted">还没有成员服</td></tr>`}</tbody>
       </table>
     </section>

     <section class="card">
       <h2>API key</h2>
       <table>
         <thead><tr><th>前缀</th><th>服务器</th><th>scope</th><th>备注</th><th>创建</th><th>最后使用</th><th></th></tr></thead>
         <tbody>${keyRows || `<tr><td colspan="7" class="muted">还没有 key</td></tr>`}</tbody>
       </table>
     </section>

     <section class="card">
       <h2>测试 key</h2>
       <p class="muted small">
         给接入方试跑用：提交照常校验，但只回 <code>200</code> 和合成记录；拉取只返回一条演示数据；
         <code>/v1/servers</code> 只返回沙盒那台服。除认证那一条查询外不访问数据库，拿不到真实名单，也写不进任何东西。
         吊销就在上面的 key 列表里操作。
       </p>
       ${
         c.env.SANDBOX
           ? ''
           : '<p class="err">没配 <code>SANDBOX</code> 变量，生成的测试 key 会一律返回 <code>503 sandbox_unconfigured</code>。</p>'
       }
       <form class="inline" method="post" action="${SESSION_PATH}/test-keys">
         <input name="label" placeholder="备注（发给谁，可选）" size="26">
         <button type="submit">生成测试 key</button>
       </form>
     </section>

     <section class="card">
       <h2>最近 ban</h2>
       <table>
         <thead><tr><th>steamId</th><th>reason</th><th>上报服</th><th>时长</th><th>状态</th><th>更新</th><th>操作</th></tr></thead>
         <tbody>${banRows || `<tr><td colspan="7" class="muted">还没有 ban 记录</td></tr>`}</tbody>
       </table>
     </section>

     <section class="card">
       <h2>审计</h2>
       <table>
         <thead><tr><th>时间</th><th>actor</th><th>动作</th><th>目标</th></tr></thead>
         <tbody>${auditRows || `<tr><td colspan="4" class="muted">空</td></tr>`}</tbody>
       </table>
     </section>`,
  );
}

function issuedPage(serverName: string, serverId: string, key: string, scopes: string[], label: string | null): string {
  return layout(
    'key 已生成',
    `<div class="card">
       <h2>key 已生成 · ${esc(serverName)}</h2>
       <p class="err">这串明文只显示这一次（库里只存 SHA-256）。现在复制走。</p>
       <pre class="key">${esc(key)}</pre>
       <p class="muted">服务器：<code>${esc(serverId)}</code>　scope：<code>${esc(scopes.join(' '))}</code>${label ? `　备注：${esc(label)}` : ''}</p>
       <h3>怎么用</h3>
       <pre class="code">curl -H "Authorization: Bearer ${esc(key)}" \\
  https://wardogs.ksroido.art/api/ban-share/v1/players/76561198000000000</pre>
       <p class="muted small">提交 ban：<code>POST /api/ban-share/v1/bans</code>，读：<code>GET /api/ban-share/v1/bans</code>。完整契约见仓库 <code>docs/openapi.yaml</code>。</p>
       <p><a href="${SESSION_PATH}">← 回面板</a></p>
     </div>`,
  );
}

function testIssuedPage(key: string, label: string | null, sandboxConfigured: boolean): string {
  return layout(
    '测试 key 已生成',
    `<div class="card">
       <h2>测试 key 已生成</h2>
       <p class="err">明文只显示这一次（库里只存 SHA-256）。现在复制走。</p>
       <pre class="key">${esc(key)}</pre>
       <p class="muted">用途：沙盒${label ? `　备注：${esc(label)}` : ''}　scope：<code>bans:read bans:write</code></p>
       ${
         sandboxConfigured
           ? ''
           : '<p class="err">这个部署还没配 <code>SANDBOX</code> 变量，这枚 key 现在用会返回 <code>503 sandbox_unconfigured</code>。</p>'
       }
       <h3>这枚 key 能看到什么</h3>
       <ul class="muted">
         <li>提交：校验规则和真实提交一致，返回 <code>200</code> 加合成记录，不落库</li>
         <li>拉取：只有一条演示记录，过滤条件照常生效</li>
         <li><code>/v1/servers</code>：只有沙盒那台服</li>
         <li>撤销：只认演示记录的 id</li>
       </ul>
       <p class="muted small">真实 ban 名单和它完全隔离。停用：回面板在 key 列表里点「吊销」。</p>
       <p><a href="${SESSION_PATH}">← 回面板</a></p>
     </div>`,
  );
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · WARDogs 联合 Ban</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0f1115; color: #e6e6e6;
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 0 0 12px; color: #fff; }
  h3 { font-size: 13px; margin: 18px 0 6px; color: #bbb; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { background: #1b1f27; padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
  pre.code { background: #12151b; border: 1px solid #232833; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; }
  pre.key { background: #1b2330; border: 1px solid #2f6f4f; color: #8ef0b6; padding: 14px; border-radius: 8px;
            font-size: 14px; word-break: break-all; user-select: all; }
  .card { background: #151922; border: 1px solid #232833; border-radius: 10px; padding: 16px; margin: 0 0 16px; max-width: 1100px; }
  .row { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .row input { flex: 1 1 200px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; max-width: 1100px; margin-bottom: 16px; }
  input, button { background: #11151c; color: #e6e6e6; border: 1px solid #2a3140; border-radius: 7px;
                  padding: 7px 10px; font: inherit; }
  form.login { display: flex; flex-direction: column; gap: 10px; max-width: 380px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field > span { color: #9aa4b2; font-size: 12px; }
  .check { display: flex; align-items: center; gap: 6px; color: #c9d1d9; font-size: 13px; }
  .check input { padding: 0; }
  input:focus { outline: 2px solid #2f6f4f; outline-offset: -1px; }
  button { cursor: pointer; background: #1d2a22; border-color: #2f6f4f; }
  button:hover { background: #24362b; }
  button.danger { background: #2a1a1c; border-color: #6f2f35; }
  button.danger:hover { background: #3a2225; }
  form.inline { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #1d232e; vertical-align: top; }
  th { color: #9aa4b2; font-weight: 500; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #8a93a1; }
  .small { font-size: 12px; }
  .ok { color: #6fdc9a; }
  .warn { color: #e6b45c; }
  .err { color: #f08a8a; }
  .notice { color: #8ef0b6; }
  a { color: #7fc7ff; }
  .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
            max-width: 1100px; margin: 0 0 20px; }
  .topbar h1 { margin: 0 0 4px; }
  .topbar p { margin: 0; }
  a.gh { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; flex: none;
         border: 1px solid #232833; border-radius: 8px; background: #151922;
         color: #c9d1d9; text-decoration: none; font-size: 13px; white-space: nowrap; }
  a.gh:hover { background: #1b212b; border-color: #35404f; color: #fff; }
  a.gh svg { flex: none; }
</style>
</head><body>
<header class="topbar">
  <div>
    <h1>WARDogs 联合 Ban</h1>
    <p class="muted small">联邦封禁名单 · 维护者面板</p>
  </div>
  <a class="gh" href="https://github.com/KSroido/wardogs-ban-share" target="_blank" rel="noopener noreferrer" title="GitHub 仓库：KSroido/wardogs-ban-share">
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
    <span>GitHub</span>
  </a>
</header>
${body}
</body></html>`;
}

// ---------------------------------------------------------------- helpers

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function shortTime(iso: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 16) : '';
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'server';
}

async function allocateServerId(db: D1Database, base: string): Promise<string> {
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const exists = await db.prepare('SELECT 1 AS x FROM servers WHERE id = ?').bind(candidate).first();
    if (!exists) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}
