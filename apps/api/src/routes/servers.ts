import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireApiKey, requireScope } from '../auth';
import { requireSandboxConfig, sandboxServer } from '../sandbox';

export const serversRoutes = new Hono<AppEnv>();

/** The roster of member servers. Public ban records reference these names. */
serversRoutes.get('/', async (c) => {
  const auth = await requireApiKey(c);
  requireScope(auth, 'bans:read');

  // 测试 key 只看到沙盒自己那一条，真实成员名单不外泄。
  if (auth.sandbox) {
    const config = requireSandboxConfig(c.env.SANDBOX);
    return c.json({ data: [sandboxServer(config)], sandbox: true });
  }

  const result = await c.env.DB.prepare(
    `SELECT id, name, owner, location, status, note, created_at FROM servers ORDER BY location ASC, name ASC`,
  ).all<{
    id: string;
    name: string;
    owner: string | null;
    location: string | null;
    status: 'active' | 'defederated';
    note: string | null;
    created_at: string;
  }>();

  return c.json({ data: result.results ?? [] });
});
