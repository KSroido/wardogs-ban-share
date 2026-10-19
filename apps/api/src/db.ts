import { newId } from './ids';

export interface AuditEntry {
  actorType: 'server' | 'admin';
  actorId: string;
  action: string;
  target?: string | null;
  detail?: unknown;
}

export function auditStatement(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, target, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('aud'),
      entry.actorType,
      entry.actorId,
      entry.action,
      entry.target ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      new Date().toISOString(),
    );
}

export async function logAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  try {
    await auditStatement(db, entry).run();
  } catch (error) {
    // Audit must never break the request that succeeded.
    console.error('audit write failed', error);
  }
}
