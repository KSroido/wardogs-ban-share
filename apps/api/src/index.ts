import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Env } from './env';
import { ApiError } from './errors';
import { adminRoutes } from './routes/admin';
import { bansRoutes } from './routes/bans';
import { panelRoutes } from './routes/panel';
import { playersRoutes } from './routes/players';
import { serversRoutes } from './routes/servers';
import { reindexAll } from './stats';

const API_PREFIX = '/api/ban-share';
const VERSION = '0.1.0';

const app = new Hono<AppEnv>();

/**
 * 用量守卫：wardogs-guard 在超额 $1 时往 KV 写 halt:<service>。
 * 这里读一次（KV 读很便宜），命中就整体 503 —— 不再产生新的请求/D1 行数。
 * 健康检查放行，方便外部监控还知道服务活着。
 */
async function guardHalt(env: AppEnv['Bindings']): Promise<string | null> {
  try {
    const [w, d] = await Promise.all([env.GUARD?.get('halt:workers'), env.GUARD?.get('halt:d1')]);
    return w ?? d ?? null;
  } catch {
    return null; // 守卫不可用不能连累业务
  }
}

// Every response carries a request id, including errors, so a member server can
// quote one line when asking the maintainers for help.
app.use('*', async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId =
    incoming && /^[A-Za-z0-9._:-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();

  c.set('requestId', requestId);
  await next();
  c.header('x-request-id', requestId);
});

// Browser panels call the read endpoints directly. Auth is a bearer header, not
// a cookie, so a wildcard origin does not expose anything ambient.
app.use(
  `${API_PREFIX}/v1/*`,
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    exposeHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 86_400,
  }),
);

app.get('/', (c) =>
  c.json({
    name: 'wardogs-ban-share',
    version: VERSION,
    api: `${new URL(c.req.url).origin}${API_PREFIX}/v1`,
    docs: 'https://github.com/KSroido/wardogs-ban-share',
  }),
);

app.use('*', async (c, next) => {
  if (c.req.path === '/health' || c.req.path === `${API_PREFIX}/health`) return next();
  const stopped = await guardHalt(c.env);
  if (stopped) {
    return c.json(
      {
        error: { code: 'service_halted', message: 'Usage guard tripped; service paused.', detail: stopped },
        request_id: c.get('requestId') ?? null,
      },
      503,
    );
  }
  return next();
});

app.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString(), version: VERSION }));
app.get(`${API_PREFIX}/health`, (c) =>
  c.json({ ok: true, time: new Date().toISOString(), version: VERSION }),
);

app.get(API_PREFIX, (c) =>
  c.json({
    name: 'wardogs-ban-share',
    version: VERSION,
    api: `${new URL(c.req.url).origin}${API_PREFIX}/v1`,
    reasons: [
      'cheat',
      'rulebreak',
      'chattroll',
      'gametroll',
      'racism',
      'foreignofserverlocation',
      'steamrisk',
      'ownreason',
    ],
  }),
);

app.route(`${API_PREFIX}/v1/bans`, bansRoutes);
app.route(`${API_PREFIX}/v1/players`, playersRoutes);
app.route(`${API_PREFIX}/v1/servers`, serversRoutes);
app.route(`${API_PREFIX}/admin`, adminRoutes);
// 维护者面板：https://wardogs.ksroido.art/ban-share（同一个 ADMIN_TOKEN）
// 同时挂 '/ban-share/'：带尾斜杠的请求也进得来（通配符路由下它会到 Worker 这里）
app.route('/ban-share', panelRoutes);
app.route('/ban-share/', panelRoutes);

app.notFound((c) =>
  c.json(
    { error: { code: 'not_found', message: 'Route not found.' }, request_id: c.get('requestId') },
    404,
  ),
);

app.onError((error, c) => {
  const requestId = c.get('requestId') ?? crypto.randomUUID();

  if (error instanceof ApiError) {
    return c.json(
      {
        error: { code: error.code, message: error.message, details: error.details },
        request_id: requestId,
      },
      error.status,
    );
  }

  console.error('unhandled error', error);
  return c.json(
    { error: { code: 'internal', message: 'Internal server error.' }, request_id: requestId },
    500,
  );
});

/**
 * Nightly repair of the stats read model. Writes already refresh the affected
 * player, so this only matters after a partial failure or a manual import.
 */
async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(
    reindexAll(env.DB, new Date().toISOString()).catch((error) => {
      console.error('scheduled reindex failed', error);
    }),
  );
}

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
