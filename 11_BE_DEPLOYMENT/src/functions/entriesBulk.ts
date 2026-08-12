/**
 * リストからの一括登録。
 *
 * 設計の要は2つ。
 *
 * 1. **全か無か。** 検証（zod → normalizeEntry → 参照IDの世帯チェック）を
 *    全行分やり切ってからトランザクションを開く。通常の不備では1行も INSERT されない。
 *    万一 DB 制約（ck_entries_shape / FK）が発火しても1トランザクションなので全部戻る。
 *
 * 2. **行数によらず往復を増やさない。** 参照IDの検証は SELECT を3本並べて1往復、
 *    INSERT は多値 VALUES で1往復。行ごとに Request を回すと 50 行で150往復になり、
 *    Basic 5DTU では持たない。
 *
 * 種別ごとの項目整合は entries.ts と同じ domain/entry.ts の normalizeEntry が担保する。
 * 経路が増えても検証の強さは変えない。
 */
import { app } from '@azure/functions';
import { getPool, sql } from '../db/pool';
import { num } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import {
  bulkEntryInputSchema,
  normalizeEntry,
  BulkRowIssue,
  NormalizedEntry,
} from '../domain/entry';

/**
 * 参照先がすべて同じ世帯のものか、全行まとめて確かめる。
 *
 * entries.ts の assertReferencesInHousehold と目的は同じだが、あちらは1件につき最大3往復する。
 * ここでは ID の集合を作り、SELECT を3本並べて1往復で済ませる（calendarMonth と同じ書き方）。
 *
 * ID をクエリに直接埋めているのは、zod が int かつ正であることを既に保証しているため。
 * 文字列は一切埋め込まない。
 */
async function findMissingReferences(
  entries: NormalizedEntry[],
  householdId: number
): Promise<{ categories: Set<number>; accounts: Set<number>; pools: Set<number> }> {
  const unique = (pick: (e: NormalizedEntry) => number | null) =>
    [...new Set(entries.map(pick).filter((v): v is number => v !== null))];

  const categoryIds = unique((e) => e.budgetCategoryId);
  const accountIds = unique((e) => e.accountId);
  const poolIds = unique((e) => e.poolId);

  // 空の集合はクエリごと省く。順番を覚えておいて recordsets と突き合わせる
  const queries: { key: 'categories' | 'accounts' | 'pools'; sqlText: string }[] = [];
  if (categoryIds.length > 0) {
    queries.push({
      key: 'categories',
      sqlText: `SELECT id FROM dbo.budget_categories WHERE household_id = @hid AND id IN (${categoryIds.join(',')})`,
    });
  }
  if (accountIds.length > 0) {
    queries.push({
      key: 'accounts',
      sqlText: `SELECT id FROM dbo.accounts WHERE household_id = @hid AND id IN (${accountIds.join(',')})`,
    });
  }
  if (poolIds.length > 0) {
    queries.push({
      key: 'pools',
      sqlText: `SELECT id FROM dbo.pools WHERE household_id = @hid AND id IN (${poolIds.join(',')})`,
    });
  }

  const missing = {
    categories: new Set(categoryIds),
    accounts: new Set(accountIds),
    pools: new Set(poolIds),
  };

  if (queries.length === 0) return missing;

  const pool = await getPool();
  const result = await pool
    .request()
    .input('hid', sql.BigInt, householdId)
    .query(queries.map((q) => q.sqlText).join(';\n'));

  const recordsets = result.recordsets as unknown as Record<string, any>[][];
  queries.forEach((q, i) => {
    for (const row of recordsets[i] ?? []) missing[q.key].delete(num(row.id));
  });

  // 引けなかった ID だけが残る
  return missing;
}

app.http('entriesBulkCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'entries/bulk',
  handler: withAuth(async (req, ctx, { user }) => {
    const parsed = bulkEntryInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      // zod の path は ['rows', <行番号>, <項目名>]。行に紐付くものだけ拾い、
      // 行数そのものへの指摘（0行・上限超過）は message だけで返す
      const rows: BulkRowIssue[] = [];
      for (const issue of parsed.error.issues) {
        const [head, index, field] = issue.path;
        if (head !== 'rows' || typeof index !== 'number') continue;
        if (rows.some((r) => r.index === index)) continue;
        rows.push({ index, field: typeof field === 'string' ? field : null, message: issue.message });
      }

      return fail(
        400,
        'VALIDATION_ERROR',
        rows.length > 0 ? `${rows.length} 件の行に不備があります` : '入力内容を確認してください',
        rows.length > 0 ? { rows } : parsed.error.flatten()
      );
    }

    const { rows: inputRows, clientId } = parsed.data;

    // --- 検証 1: 種別ごとの項目整合。1件目で止めず、不備を全部集める -------------
    const issues = new Map<number, BulkRowIssue>();
    const entries: NormalizedEntry[] = [];

    inputRows.forEach((row, index) => {
      const normalized = normalizeEntry(row);
      if (!normalized.ok || !normalized.entry) {
        issues.set(index, {
          index,
          field: normalized.field ?? null,
          message: normalized.error ?? '入力内容を確認してください',
        });
        return;
      }
      entries.push(normalized.entry);
    });

    try {
      // --- 検証 2: 参照先が同じ世帯のものか。往復1回 ---------------------------
      // 正規化を通った行だけを見る。落ちた行の ID は信用できない
      const missing = await findMissingReferences(entries, user.householdId);

      if (missing.categories.size + missing.accounts.size + missing.pools.size > 0) {
        // 同じ不正な ID を複数行が使っていれば、その行すべてに印を付ける
        inputRows.forEach((row, index) => {
          if (issues.has(index)) return;
          if (row.budgetCategoryId && missing.categories.has(row.budgetCategoryId)) {
            issues.set(index, {
              index,
              field: 'budgetCategoryId',
              message: '指定されたカテゴリが見つかりません',
            });
          } else if (row.accountId && missing.accounts.has(row.accountId)) {
            issues.set(index, {
              index,
              field: 'accountId',
              message: '指定された財布が見つかりません',
            });
          } else if (row.poolId && missing.pools.has(row.poolId)) {
            issues.set(index, {
              index,
              field: 'poolId',
              message: '指定されたプールが見つかりません',
            });
          }
        });
      }

      // --- 1行でも不備があれば、ここで止める。まだ何も書いていない -------------
      if (issues.size > 0) {
        const rows = [...issues.values()].sort((a, b) => a.index - b.index);
        return fail(400, 'VALIDATION_ERROR', `${rows.length} 件の行に不備があります`, { rows });
      }

      // --- 書き込み -----------------------------------------------------------
      const pool = await getPool();
      const transaction = new sql.Transaction(pool);

      try {
        await transaction.begin();

        // 再送で二重に登録しない。押し直しやリロードで同じバッチが2回届いても1回だけ入る
        if (clientId) {
          const existing = await new sql.Request(transaction)
            .input('hid', sql.BigInt, user.householdId)
            .input('cid', sql.UniqueIdentifier, clientId)
            .query(
              `SELECT TOP 1 id FROM dbo.entries WHERE household_id = @hid AND client_id = @cid`
            );
          if (existing.recordset[0]) {
            await transaction.commit();
            return ok({ created: 0, ids: [], duplicated: true });
          }
        }

        const request = new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('by', sql.BigInt, user.id);

        /*
         * client_id は**先頭行にだけ**入れる。
         *
         * ux_entries_client_id は (household_id, client_id) のフィルタ付き一意索引なので、
         * 全行に同じ値を入れると2行目で必ず違反する。
         * この値はバッチの受付番号であり、行の識別子ではない。先頭行に刻んでおけば、
         * 上の重複チェックで「このバッチは受付済み」と分かる。
         */
        if (clientId) request.input('cid', sql.UniqueIdentifier, clientId);

        const values = entries.map((entry, i) => {
          request
            .input(`d${i}`, sql.Date, entry.entryDate)
            .input(`k${i}`, sql.NVarChar(10), entry.kind)
            .input(`amt${i}`, sql.BigInt, entry.amount)
            .input(`cat${i}`, sql.BigInt, entry.budgetCategoryId)
            .input(`acc${i}`, sql.BigInt, entry.accountId)
            .input(`pool${i}`, sql.BigInt, entry.poolId)
            .input(`mer${i}`, sql.NVarChar(120), entry.merchant)
            .input(`memo${i}`, sql.NVarChar(500), entry.memo);

          const cid = i === 0 && clientId ? '@cid' : 'NULL';
          return `(@hid, ${cid}, @d${i}, @k${i}, @amt${i}, @cat${i}, @acc${i}, @pool${i}, @mer${i}, @memo${i}, @by)`;
        });

        /*
         * counter_account_id / lat / lng / location_accuracy / place_name / source は
         * 列ごと書かない。NULL と source の既定値 'manual' が入る。
         * 一括も人が手で打ったものなので、由来は通常の記録と同じ。
         */
        const inserted = await request.query(
          `INSERT INTO dbo.entries
             (household_id, client_id, entry_date, kind, amount,
              budget_category_id, account_id, pool_id, merchant, memo, created_by)
           OUTPUT INSERTED.id
           VALUES ${values.join(',\n                  ')}`
        );

        await transaction.commit();

        // OUTPUT の順序は保証されないので、行との対応付けには使わない
        const ids = inserted.recordset.map((r) => num(r.id)).sort((a, b) => a - b);

        /*
         * 場所マスタへ紐付ける。**1文でまとめて行う。**
         * 行ごとに問い合わせると 50 行で 50 往復になり、
         * この機能が往復を増やさないために払った工夫が無駄になる。
         *
         * 一括登録は座標を持たないので、突き合わせは店名だけ。
         * `NOT EXISTS` が「同名のマスタがちょうど1件のときだけ紐付ける」を担う。
         * 複数あるとどの店か決められない——当てずっぽうに選ぶと、
         * 金額が別の店に混ざって後から気付けない。
         *
         * ここで失敗しても登録は巻き戻さない。記録は残っているほうが常に良い。
         */
        await pool
          .request()
          .input('hid', sql.BigInt, user.householdId)
          .query(
            `UPDATE e
                SET place_id = p.id
               FROM dbo.entries e
               JOIN dbo.places p
                 ON p.household_id = e.household_id
                AND p.is_archived = 0
                AND p.name = e.merchant
              WHERE e.household_id = @hid
                AND e.place_id IS NULL
                AND e.id IN (${ids.join(',')})
                AND NOT EXISTS (
                      SELECT 1 FROM dbo.places p2
                       WHERE p2.household_id = e.household_id
                         AND p2.is_archived = 0
                         AND p2.name = e.merchant
                         AND p2.id <> p.id)`
          )
          .catch((e) => ctx.warn(`場所マスタへの紐付けに失敗: ${e}`));

        return ok({ created: ids.length, ids, duplicated: false }, 201);
      } catch (err) {
        await transaction.rollback().catch(() => undefined);

        // 同時に2回押されて上の重複チェックをすり抜けた場合。索引が最終防衛線になる
        const number = (err as { number?: number }).number;
        if (number === 2601 || number === 2627) {
          return fail(409, 'DUPLICATE_BATCH', 'この一覧はすでに登録されています');
        }
        throw err;
      }
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
