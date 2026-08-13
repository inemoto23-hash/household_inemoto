/**
 * 記録を場所マスタへ紐付ける。無ければ作る。
 *
 * **外部 API を呼ばない。** 地名は定時ジョブ（`placeGeocodeSweep`）が後から埋める。
 * 記録の保存を国土地理院の応答待ちにすると、あちらが遅い日は記帳が遅くなり、
 * 止まっている日は記帳そのものができなくなる。地名は飾りなので、
 * それと引き換えにしてよいものではない。
 *
 * **失敗しても記録は巻き戻さない。** 定期取引の規則づくりと同じ判断で、
 * 「記録は残っているほうが常に良い」。紐付かなければ place_id が NULL のままになり、
 * 集計は今までどおり店名で行われる（`shared/places.ts` の COALESCE）。
 */
import type { ConnectionPool, Transaction } from 'mssql';
import { sql } from '../db/pool';
import { matchPlace, normalizePlaceName, PlaceCandidate } from '../domain/place';

/** ひとつの世帯・ひとつの店名で持つマスタの上限。異常な増え方への歯止め */
const MAX_CANDIDATES = 50;

type Runner = ConnectionPool | Transaction;

function request(runner: Runner) {
  return runner instanceof sql.Transaction ? new sql.Request(runner) : runner.request();
}

/**
 * 店名と座標から place_id を決める。作る必要があれば作る。
 *
 * 紐付けられないとき（店名が無い／座標が無く同名が複数）は null を返す。
 * **当てずっぽうに選ばない。** 選ぶと金額が別の店に混ざり、後から気付けない。
 */
export async function resolvePlaceId(
  runner: Runner,
  householdId: number,
  input: { merchant?: string | null; placeName?: string | null; lat: number | null; lng: number | null }
): Promise<number | null> {
  const name = normalizePlaceName(input.merchant ?? input.placeName ?? null);
  if (!name) return null;

  const found = await request(runner)
    .input('hid', sql.BigInt, householdId)
    .input('name', sql.NVarChar(120), name)
    .input('top', sql.Int, MAX_CANDIDATES)
    .query(
      `SELECT TOP (@top) id, name, lat, lng
         FROM dbo.places
        WHERE household_id = @hid AND is_archived = 0 AND name = @name`
    );

  const candidates: PlaceCandidate[] = found.recordset.map((row: any) => ({
    id: Number(row.id),
    name: row.name,
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
  }));

  const match = matchPlace({ name, lat: input.lat, lng: input.lng }, candidates);

  if (match.placeId !== null) {
    // 座標なしだったマスタを育てる。地名はまだ無いので、定時ジョブが後で拾う
    if (match.adoptCoords && input.lat !== null && input.lng !== null) {
      await request(runner)
        .input('id', sql.BigInt, match.placeId)
        .input('lat', sql.Decimal(9, 6), input.lat)
        .input('lng', sql.Decimal(9, 6), input.lng)
        .query(
          `UPDATE dbo.places
              SET lat = @lat, lng = @lng, updated_at = SYSUTCDATETIME()
            WHERE id = @id AND lat IS NULL`
        );
    }
    return match.placeId;
  }

  if (!match.create) return null;

  const created = await request(runner)
    .input('hid', sql.BigInt, householdId)
    .input('name', sql.NVarChar(120), name)
    .input('lat', sql.Decimal(9, 6), input.lat)
    .input('lng', sql.Decimal(9, 6), input.lng)
    .query(
      `INSERT INTO dbo.places (household_id, name, lat, lng)
       OUTPUT INSERTED.id
       VALUES (@hid, @name, @lat, @lng)`
    );

  return Number(created.recordset[0].id);
}

/**
 * 保存済みの記録に紐付けを書く。
 *
 * 記録の登録そのものとは切り離して呼ぶ。ここで例外が出ても、
 * 呼び出し側は記録を消さずに握りつぶす（記録は残っているほうが常に良い）。
 *
 * `clearIfUnmatched` を立てると、**紐付け先が見つからないときに NULL を書く**。
 * 店名を直したときはこちらを使う。書かずに戻ると古いマスタを指したままになり、
 * 「履歴では ENEOS なのに分析ではガソリンのまま」という形で食い違う。
 * 新規登録のときは元から NULL なので、立てる意味がない。
 */
export async function attachPlace(
  pool: ConnectionPool,
  householdId: number,
  entryId: number,
  input: { merchant?: string | null; placeName?: string | null; lat: number | null; lng: number | null },
  options: { clearIfUnmatched?: boolean } = {}
): Promise<number | null> {
  const placeId = await resolvePlaceId(pool, householdId, input);
  if (placeId === null && !options.clearIfUnmatched) return null;

  await pool
    .request()
    .input('id', sql.BigInt, entryId)
    .input('hid', sql.BigInt, householdId)
    .input('pid', sql.BigInt, placeId)
    .query(`UPDATE dbo.entries SET place_id = @pid WHERE id = @id AND household_id = @hid`);

  return placeId;
}
