/**
 * 2地点の距離。
 *
 * ここは純粋関数だけで構成する。DB にも HTTP にも触れない。
 * 判定を間違えると「自宅なのに店名候補が出る」「店なのに位置が残らない」という
 * 形でしか気付けないため、単体で確かめられるようにしておく。
 *
 * 画面側にも同じものを置いている（FE の lib/geo.ts）。
 * 別デプロイなので共有できない。片方を直したらもう片方も直すこと。
 */

/** 地球の平均半径（メートル） */
const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * ハバサインで2地点の距離を出す。
 * 数十メートルの判定に使うので、地球を球とみなす精度で足りる。
 */
export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface HomeLocation {
  lat: number;
  lng: number;
  radiusM: number;
}

/** 自宅の範囲内か。自宅が未登録なら常に false */
export function isAtHome(
  home: HomeLocation | null,
  point: { lat: number; lng: number } | null
): boolean {
  if (!home || !point) return false;
  return distanceMeters(home.lat, home.lng, point.lat, point.lng) <= home.radiusM;
}

/**
 * 半径を含む矩形の緯度経度の幅。
 *
 * SQL で候補を絞るために使う。矩形は半径より広く取れるので、
 * これで絞ってから距離で確定する。矩形だけで判定すると
 * 角が半径の約1.4倍まで入ってしまう。
 */
export function boundingBox(home: HomeLocation): {
  latDelta: number;
  lngDelta: number;
} {
  const latDelta = (home.radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  // 経度1度あたりの距離は緯度が高いほど短くなる
  const cos = Math.max(0.01, Math.cos(toRad(home.lat)));
  return { latDelta, lngDelta: latDelta / cos };
}
