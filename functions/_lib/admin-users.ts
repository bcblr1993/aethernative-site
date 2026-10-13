const PAGE_SIZE = 50;
export interface UserQuery { q: string; status: string; cursor?: { at: number; id: string } }

export function parseUserQuery(params: URLSearchParams): UserQuery | null {
  const q = (params.get('q') ?? '').trim();
  const status = params.get('status') ?? '';
  if (q.length > 120 || !['', 'active', 'disabled', 'admin'].includes(status)) return null;
  let cursor: UserQuery['cursor'];
  if (params.has('cursor')) {
    try {
      const value = JSON.parse(params.get('cursor')!);
      if (!Number.isSafeInteger(value.at) || value.at < 0 || typeof value.id !== 'string' || !value.id || value.id.length > 128) return null;
      cursor = { at: value.at, id: value.id };
    } catch { return null; }
  }
  return { q, status, cursor };
}

export async function listUsers(db: D1Database, opts: UserQuery, now = Date.now()) {
  const where: string[] = ['1=1'];
  const args: (string | number)[] = [];
  if (opts.q) {
    where.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.id = ?)");
    const query = `%${opts.q.replace(/[\\%_]/g, '\\$&')}%`;
    args.push(query, query, opts.q);
  }
  if (opts.status === 'admin') where.push('u.is_admin = 1');
  if (opts.status === 'active') where.push('u.disabled_at IS NULL');
  if (opts.status === 'disabled') where.push('u.disabled_at IS NOT NULL');
  const filter = where.join(' AND ');
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${filter}`).bind(...args).first<{ n: number }>();
  if (opts.cursor) {
    where.push('(u.created_at < ? OR (u.created_at = ? AND u.id < ?))');
    args.push(opts.cursor.at, opts.cursor.at, opts.cursor.id);
  }
  const { results } = await db.prepare(`SELECT u.id, u.name, u.email, u.is_admin, u.disabled_at, u.created_at, u.last_login_at,
    (SELECT GROUP_CONCAT(provider) FROM identities WHERE user_id = u.id) AS providers,
    (SELECT COUNT(*) FROM feedback WHERE user_id = u.id) AS feedback_count,
    (SELECT COUNT(*) FROM sessions WHERE user_id = u.id AND expires_at > ?) AS sessions
    FROM users u WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC, u.id DESC LIMIT ?`)
    .bind(now, ...args, PAGE_SIZE + 1).all<{
      id: string; name: string; email: string | null; is_admin: number; disabled_at: number | null;
      created_at: number; last_login_at: number; providers: string | null; feedback_count: number; sessions: number;
    }>();
  const rows = results.slice(0, PAGE_SIZE);
  const last = rows.at(-1);
  const summary = await db.prepare(`SELECT COUNT(*) AS total, SUM(is_admin = 1) AS admins,
    SUM(disabled_at IS NOT NULL) AS disabled FROM users`).first<{ total: number; admins: number | null; disabled: number | null }>();
  return {
    users: rows.map((u) => ({ id: u.id, name: u.name, email: u.email, isAdmin: u.is_admin === 1,
      disabledAt: u.disabled_at, createdAt: u.created_at, lastLoginAt: u.last_login_at,
      providers: (u.providers ?? '').split(',').filter(Boolean).sort(), feedbackCount: u.feedback_count, sessions: u.sessions })),
    total: total?.n ?? 0,
    next: results.length > PAGE_SIZE && last ? JSON.stringify({ at: last.created_at, id: last.id }) : null,
    summary: { total: summary?.total ?? 0, admins: summary?.admins ?? 0, disabled: summary?.disabled ?? 0 },
  };
}
