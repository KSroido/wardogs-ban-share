import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireApiKey, requireScope } from '../auth';

export const serversRoutes = new Hono<AppEnv>();

/** The roster of member servers. Public ban records reference these names. */
serversRoutes.get('/', async (c) => {
  const auth = await requireApiKey(c);
  requireScope(auth, 'bans:read');

  const result = await c.env.DB.prepare(
    `SELECT id, name, status, note, created_at FROM servers ORDER BY name ASC`,
  ).all<{
    id: string;
    name: string;
    status: 'active' | 'defederated';
    note: string | null;
    created_at: string;
  }>();

  return c.json({ data: result.results ?? [] });
});
