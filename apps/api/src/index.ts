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
