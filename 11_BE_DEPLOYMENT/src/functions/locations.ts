/**
 * 保存済みの位置情報の棚卸しと消去。
 *
 * PC のブラウザは Wi-Fi と IP アドレスから現在地を推定するため、誤差が数km 出る。
 * その座標が残っていると、支出マップのピンが見知らぬ土地に立ち、
 * 店名の候補も無関係な店から引かれる。
 *
 * 消すのは**座標だけ**。金額・店名・カテゴリはそのまま残す。
 * 自宅登録時の一括除去（shared/home.ts の clearNearby）と同じ扱いにしてある。
 * あちらが「自宅の円内」で選ぶのに対し、こちらは「誤差の大きさ」で選ぶ。
 *
 * 座標は復元できないので、消す前に必ず件数を見せる。
 * 月次締めがプレビューと承認の2段階になっているのと同じ考え方。
 */
import { app } from '@azure/functions';
import { z } from 'zod';
import { getPool, sql } from '../db/pool';
import { num } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import { MAX_USEFUL_ACCURACY_M } from '../domain/geo';

/**
 * 件数を数える誤差の段階。
 *
 * どれを消すかを選べるようにするために複数返す。
 * 実際の分布を見ないまま閾値を決め打ちすると、
 * 残すべきものまで消すか、消したいものが残るかのどちらかになる。
 */
const BUCKETS = [200, MAX_USEFUL_ACCURACY_M, 1000] as const;

const clearInputSchema = z.object({
  /** この誤差（メートル）を**超える**ものを消す */
  minAccuracy: z.coerce.number().int().min(0).max(1_000_000),
  /**
   * 誤差が分からない（`location_accuracy IS NULL`）ものも消すか。
   *
   * 既定は消さない。値が無いことは「悪い」ことの証拠にならないため。
   * ただし逃げ道が無いと、混ざってしまった座標を消す手段が一切なくなる。
   * 画面では別のボタンにしてあり、誤差の大きいものと**まとめて押せない**。
   */
  includeUnknown: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------
// 棚卸し
// ---------------------------------------------------------------
app.http('locationsSummary', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'locations/summary',
  handler: withAuth(async (_req, ctx, { user }) => {
    try {
      const pool = await getPool();

      // 段階ごとの件数を1往復で数える。行数ぶん往復すると Basic 5DTU では重い
      const counts = BUCKETS.map(
        (m) => `
        SELECT ${m} AS threshold,
               (SELECT COUNT(*) FROM dbo.entries
                 WHERE household_id = @hid AND is_deleted = 0
                   AND lat IS NOT NULL AND location_accuracy > ${m}) AS entries,
               (SELECT COUNT(*) FROM dbo.entry_stock
                 WHERE household_id = @hid
                   AND lat IS NOT NULL AND location_accuracy > ${m}) AS stock`
      );

      const result = await pool.request().input('hid', sql.BigInt, user.householdId).query(
        `${counts.join(';')};

         -- 位置つきの総数と、誤差が分からないもの。判断材料を隠さない
         SELECT (SELECT COUNT(*) FROM dbo.entries
                  WHERE household_id = @hid AND is_deleted = 0 AND lat IS NOT NULL) AS located,
                (SELECT COUNT(*) FROM dbo.entries
                  WHERE household_id = @hid AND is_deleted = 0
                    AND lat IS NOT NULL AND location_accuracy IS NULL) AS unknown,
                (SELECT MAX(location_accuracy) FROM dbo.entries
                  WHERE household_id = @hid AND is_deleted = 0 AND lat IS NOT NULL) AS worst`
      );

      const sets = result.recordsets as unknown as Record<string, any>[][];
      const overall = sets[BUCKETS.length][0];

      return ok({
        /** 段階ごとに「これを超えるものが何件あるか」 */
        buckets: BUCKETS.map((threshold, i) => ({
          threshold,
          entries: num(sets[i][0].entries),
          stock: num(sets[i][0].stock),
        })),
        /** 位置を持っている記録の総数 */
        located: num(overall.located),
        /** 位置はあるが誤差が分からないもの。消す対象には含めない */
        unknownAccuracy: num(overall.unknown),
        /** いちばん悪い誤差。null なら位置つきの記録が無い */
        worstAccuracy: overall.worst === null ? null : num(overall.worst),
        /** 今後の登録で捨てる境目。画面の案内に使う */
        cutoff: MAX_USEFUL_ACCURACY_M,
      });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 消去
// ---------------------------------------------------------------
app.http('locationsClear', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'locations/clear',
  handler: withAuth(async (req, ctx, { user }) => {
    const parsed = clearInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '誤差の指定を確認してください', parsed.error.flatten());
    }
    const { minAccuracy, includeUnknown } = parsed.data;

    try {
      const pool = await getPool();
      const transaction = new sql.Transaction(pool);

      try {
        await transaction.begin();

        /*
         * 誤差が分からない（NULL）ものは、指定されたときだけ消す。
         * 既定で消さないのは、値が無いことが「悪い」ことの証拠にならないため。
         *
         * 消すのは座標の3列だけで、merchant / place_name / 金額はそのまま。
         */
        const target = includeUnknown
          ? `(location_accuracy > @acc OR location_accuracy IS NULL)`
          : `location_accuracy > @acc`;

        const cleared = await new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('acc', sql.Int, minAccuracy)
          .query(
            `UPDATE dbo.entries
                SET lat = NULL, lng = NULL, location_accuracy = NULL,
                    updated_at = SYSUTCDATETIME()
              WHERE household_id = @hid AND is_deleted = 0
                AND lat IS NOT NULL AND ${target};
             SELECT @@ROWCOUNT AS n;

             UPDATE dbo.entry_stock
                SET lat = NULL, lng = NULL, location_accuracy = NULL
              WHERE household_id = @hid
                AND lat IS NOT NULL AND ${target};
             SELECT @@ROWCOUNT AS n;`
          );

        await transaction.commit();

        const sets = cleared.recordsets as unknown as Record<string, any>[][];
        return ok({
          entries: num(sets[0][0].n),
          stock: num(sets[1][0].n),
          minAccuracy,
          includeUnknown,
        });
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
