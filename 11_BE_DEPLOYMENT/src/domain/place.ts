/**
 * 記録をどの場所マスタに紐付けるか。
 *
 * ここは純粋関数だけで構成する。DB にも HTTP にも触れない。
 * 判定を間違えると「同じ店が2つに割れる」「別の店が1つにまとまる」という
 * 形でしか気付けないため、単体で確かめられるようにしておく。
 */
import { distanceMeters } from './geo';

/**
 * 同じ店とみなす距離（メートル）。
 *
 * 店名候補の `NEARBY_DEGREES`（約150m）より少し広く取る。
 * 大きな店舗は入口と駐車場で 100m 以上離れるうえ、GPS のばらつきも乗るため。
 * 広げすぎると隣接する別店舗を飲み込むので、この辺りが上限。
 */
export const SAME_PLACE_RADIUS_M = 200;

export interface PlaceCandidate {
  id: number;
  name: string;
  lat: number | null;
  lng: number | null;
}

export interface PlaceMatch {
  /** 紐付ける先。null なら新しく作る */
  placeId: number | null;
  /** 新しく作るべきか */
  create: boolean;
  /** 既存の座標なしマスタに座標を書き込むべきか */
  adoptCoords?: boolean;
  /** なぜそう決めたか。ログと動作確認のために残す */
  reason:
    | 'matched-by-distance'
    | 'matched-only-candidate'
    | 'adopted-coordless'
    | 'new-place'
    | 'ambiguous-no-coords'
    | 'no-coords-no-master'
    | 'no-name';
}

/** 表記の揺れのうち、機械的に潰せるものだけ潰す。名寄せはしない */
export function normalizePlaceName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/[\s　]+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 紐付け先を決める。
 *
 * - 座標がある: 同名の候補のうち `SAME_PLACE_RADIUS_M` 以内で**いちばん近い**もの。
 *   無ければ新しく作る（同じ「イオン」でも離れていれば別の店）
 * - 座標が無い: 同名の候補が**ちょうど1件**ならそれ。
 *   複数あるならどれか決められないので**紐付けない**。
 *   ここで当てずっぽうに選ぶと、金額が別の店に混ざって後から気付けない
 *
 * 座標を持たない候補（自宅・一括登録しかない店）も、座標なしの記録からは選べる。
 * 座標つきの記録からは距離を測れないので選ばない——新しく作って、
 * 座標つきのマスタとして育てるほうが正しい。
 */
export function matchPlace(
  input: { name: string | null; lat: number | null; lng: number | null },
  candidates: PlaceCandidate[]
): PlaceMatch {
  const name = normalizePlaceName(input.name);
  if (!name) return { placeId: null, create: false, reason: 'no-name' };

  const sameName = candidates.filter((c) => normalizePlaceName(c.name) === name);

  const located = sameName.filter((c) => c.lat !== null && c.lng !== null);
  const coordless = sameName.filter((c) => c.lat === null || c.lng === null);

  if (input.lat !== null && input.lng !== null) {
    let best: { id: number; distance: number } | null = null;
    for (const c of located) {
      const distance = distanceMeters(input.lat, input.lng, c.lat!, c.lng!);
      if (distance <= SAME_PLACE_RADIUS_M && (best === null || distance < best.distance)) {
        best = { id: c.id, distance };
      }
    }
    if (best) return { placeId: best.id, create: false, reason: 'matched-by-distance' };

    /*
     * 座標を持たないマスタを**育てる**。
     *
     * 一括登録や自宅での記録しか無かった店は、座標なしのマスタになっている。
     * そこへ初めて現地から記録したとき、新しく作ってしまうと同じ店が2つに割れ、
     * 片方に一括登録ぶん、もう片方に現地ぶんが溜まる。
     *
     * 座標つきのマスタが既にあるなら育てない。その場合は「離れた場所にある同名の店」
     * なので、新しい店として作るのが正しい。
     */
    if (located.length === 0 && coordless.length === 1) {
      return {
        placeId: coordless[0].id,
        create: false,
        adoptCoords: true,
        reason: 'adopted-coordless',
      };
    }

    return { placeId: null, create: true, reason: 'new-place' };
  }

  /*
   * 座標が無い。
   *
   * **座標なしのマスタは新しく作らない。** マスタの本体は座標のかたまりなので、
   * 座標が無いものを作っても店を区別できないうえ、後から現地で記録したときに
   * 別のマスタができて店が2つに割れる。紐付けずに置けば、集計は今までどおり
   * 店名で行われる（`shared/places.ts` の COALESCE）。
   *
   * 既にマスタが1件だけあるならそれを指す。複数あるならどれか決められないので
   * 紐付けない。**当てずっぽうに選ぶと、金額が別の店に混ざって後から気付けない。**
   */
  if (sameName.length === 1) {
    return { placeId: sameName[0].id, create: false, reason: 'matched-only-candidate' };
  }
  if (sameName.length === 0) {
    return { placeId: null, create: false, reason: 'no-coords-no-master' };
  }
  return { placeId: null, create: false, reason: 'ambiguous-no-coords' };
}

/**
 * 表示名。**DB の計算列 `display_name` と同じ規則にすること。**
 * 片方だけ直すと、作った直後だけ名前が違うという分かりにくい状態になる。
 */
export function displayName(name: string, areaName: string | null): string {
  return areaName ? `${name}（${areaName}）` : name;
}
