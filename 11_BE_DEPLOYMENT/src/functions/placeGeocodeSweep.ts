/**
 * 場所マスタに地名を埋める。15分ごと。
 *
 * **記録の保存とは切り離す。** 保存の途中で国土地理院を呼ぶと、
 * あちらが遅い日は記帳が遅くなり、止まっている日は記帳できなくなる。
 * 地名は表示のための飾りなので、それと引き換えにしてよいものではない。
 *
 * 一度書いたら二度と引かない（`geocoded_at` が入る）。
 * 国土地理院は地理院地図向けの提供で SLA が無く、仕様の変更もありうるため、
 * **こちらの動作を継続的な可用性に依存させない**。止まっても、
 * 既存のマスタは動き続け、新しい店に地名が付かなくなるだけで済む。
 */
import { app, InvocationContext, Timer } from '@azure/functions';
import { getPool, sql } from '../db/pool';
import { reverseGeocode } from '../shared/gsi';

/** 1回の実行で引く上限。詰まっても次の実行が続きを拾う */
const BATCH = 20;
/** 続けて叩かない。公共の提供なので間を空ける */
const GAP_MS = 400;
/** これだけ続けて失敗したら諦める。無限に叩き続けない */
const MAX_FAILS = 3;

interface Pending {
  id: number;
  lat: number;
  lng: number;
}

export async function sweepPlaceGeocode(ctx: InvocationContext): Promise<void> {
  const pool = await getPool();

  const pending = await pool.request().input('top', sql.Int, BATCH).query(
    `SELECT TOP (@top) id, lat, lng
       FROM dbo.places
      WHERE geocoded_at IS NULL
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND is_archived = 0
        AND geocode_fails < ${MAX_FAILS}
      ORDER BY id`
  );

  const rows: Pending[] = pending.recordset.map((r: any) => ({
    id: Number(r.id),
    lat: Number(r.lat),
    lng: Number(r.lng),
  }));

  if (rows.length === 0) return;
  ctx.log(`地名の取得: ${rows.length} 件`);

  let filled = 0;
  let missing = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const area = await reverseGeocode(row.lat, row.lng);

      if (area) {
        await pool
          .request()
          .input('id', sql.BigInt, row.id)
          .input('muni', sql.NVarChar(10), area.muniCd)
          .input('area', sql.NVarChar(80), area.areaName)
          .input('detail', sql.NVarChar(80), area.areaDetail)
          .query(
            `UPDATE dbo.places
                SET muni_cd = @muni, area_name = @area, area_detail = @detail,
                    geocoded_at = SYSUTCDATETIME(), geocode_fails = 0,
                    updated_at = SYSUTCDATETIME()
              WHERE id = @id`
          );
        filled++;
      } else {
        /*
         * 海の上など、地名が無い座標。**済みとして印を付ける。**
         * 失敗ではないので、毎回引き直しても結果は変わらない。
         */
        await pool
          .request()
          .input('id', sql.BigInt, row.id)
          .query(
            `UPDATE dbo.places
                SET geocoded_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
              WHERE id = @id`
          );
        missing++;
      }
    } catch (err) {
      // 通信そのものの失敗。回数を数え、上限に達したら以後拾わない
      await pool
        .request()
        .input('id', sql.BigInt, row.id)
        .query(`UPDATE dbo.places SET geocode_fails = geocode_fails + 1 WHERE id = @id`)
        .catch(() => undefined);
      failed++;
      ctx.warn(`地名の取得に失敗 (place ${row.id}): ${err instanceof Error ? err.message : err}`);
    }

    await new Promise((resolve) => setTimeout(resolve, GAP_MS));
  }

  ctx.log(`地名の取得: 付与 ${filled} / 地名なし ${missing} / 失敗 ${failed}`);
}

app.timer('placeGeocodeSweep', {
  // 15分ごと。記録した直後に地名が付いてほしいが、公共の提供を叩き続けもしない
  schedule: '0 */15 * * * *',
  handler: async (_timer: Timer, ctx: InvocationContext) => {
    try {
      await sweepPlaceGeocode(ctx);
    } catch (err) {
      // 地名が付かなくても家計簿は使える。次の実行で拾い直す
      ctx.error(`地名の取得でエラー: ${err instanceof Error ? err.message : err}`);
    }
  },
});
