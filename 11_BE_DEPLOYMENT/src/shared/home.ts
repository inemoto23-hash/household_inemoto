/**
 * 自宅の判定。
 *
 * 記録の入口すべてでこれを通し、自宅の範囲なら座標を捨てる。
 * 画面側でも同じ判定をしているが、それは表示のためだけ。
 * normalizeEntry が種別ごとの項目を必ず落とすのと同じで、
 * 画面が座標を送ってきても、ここで確実に落ちる。
 */
import { getPool, sql } from '../db/pool';
import { HomeLocation, isAtHome } from '../domain/geo';

/** 世帯の自宅設定。未登録なら null */
export async function getHome(householdId: number): Promise<HomeLocation | null> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('hid', sql.BigInt, householdId)
    .query(
      `SELECT home_lat, home_lng, home_radius_m FROM dbo.households WHERE id = @hid`
    );

  const row = r.recordset[0];
  if (!row || row.home_lat === null || row.home_lng === null) return null;

  return {
    lat: Number(row.home_lat),
    lng: Number(row.home_lng),
    radiusM: Number(row.home_radius_m),
  };
}

export interface Located {
  lat: number | null;
  lng: number | null;
  locationAccuracy: number | null;
}

/**
 * 自宅の範囲なら座標を落とす。
 *
 * 「保存した上で地図側で除外する」形にはしない。
 * 除外条件が地図・分析・店名候補の3か所に散らばり、いずれ抜けるため。
 * 入口で持たせなければ、下流は今のままで正しく動く。
 */
export async function stripIfAtHome(
  householdId: number,
  input: { lat?: number | null; lng?: number | null; locationAccuracy?: number | null }
): Promise<{ located: Located; atHome: boolean }> {
  const lat = input.lat ?? null;
  const lng = input.lng ?? null;
  const accuracy = input.locationAccuracy ?? null;

  if (lat === null || lng === null) {
    return { located: { lat: null, lng: null, locationAccuracy: accuracy }, atHome: false };
  }

  const home = await getHome(householdId);
  if (!isAtHome(home, { lat, lng })) {
    return { located: { lat, lng, locationAccuracy: accuracy }, atHome: false };
  }

  return { located: { lat: null, lng: null, locationAccuracy: null }, atHome: true };
}
