/**
 * 疎通確認用エンドポイント。
 *
 * GET /api/health      … 認証なし。プロセスが生きているかだけを返す
 * GET /api/health/db   … 認証なし。マネージドIDで Azure SQL に到達できるかを検証する
 *                        （Phase 0 の疎通確認用。件数以外のデータは返さない）
 * GET /api/me          … 認証あり。トークン検証と users 引き当てまでを通しで検証する
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getPool } from '../db/pool';
import { ok, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: async (): Promise<HttpResponseInit> =>
    ok({
      status: 'ok',
      service: 'kakeiflow-api',
      node: process.version,
      time: new Date().toISOString(),
    }),
});

app.http('healthDb', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health/db',
  handler: async (_req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> => {
    const startedAt = Date.now();
    try {
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT
          DB_NAME()                                                          AS database_name,
          SUSER_SNAME()                                                      AS connected_as,
          CONVERT(nvarchar(128), DATABASEPROPERTYEX(DB_NAME(), 'Collation')) AS collation,
          (SELECT COUNT(*) FROM sys.tables)                                  AS table_count,
          (SELECT COUNT(*) FROM dbo.schema_migrations)                       AS migration_count
      `);

      return ok({
        status: 'ok',
        elapsedMs: Date.now() - startedAt,
        ...result.recordset[0],
      });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  },
});

app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous', // 認可は withAuth（Entra JWT 検証）で行う
  route: 'me',
  handler: withAuth(async (_req, _ctx, { user, claims }) =>
    ok({
      user,
      token: {
        name: claims.name,
        preferredUsername: claims.preferred_username,
        issuedAt: claims.iat ? new Date(claims.iat * 1000).toISOString() : null,
        expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
      },
    })
  ),
});
