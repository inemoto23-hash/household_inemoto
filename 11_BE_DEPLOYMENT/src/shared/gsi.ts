/**
 * 座標から地名を引く（国土地理院）。
 *
 * **API キーが要らない。** 「接続文字列とAPIキーをどこにも保持しない」という
 * 方針を崩さずに地名が取れる唯一の手段だったので、これを使う。
 *
 * Azure Maps の POI 検索・逆ジオコーディングは日本ではローマ字しか返さず、
 * コンビニ・スーパー・飲食店がそもそも登録されていなかったため不採用にした
 * （91_UPDATE/21/20260811_updatefix_schedule.md）。
 * こちらは行政地名そのものが本業なので、日本語で正しく返る。
 *
 * ただし地理院地図向けの提供で **SLA が無い**。
 * 「地理院地図からの利用を想定しており、必ずしも常に、また長期的に提供できるとは
 * 限らず、仕様や利用方法は予告なく変更する場合があります」と明記されている。
 *
 * そのため **取れたものは保存して二度と呼ばない**。
 * 止まっても既存のマスタは動き続け、新規登録に地名が付かなくなるだけで済む。
 * 記録の保存そのものは、この呼び出しに一切依存させない（定時ジョブが後から埋める）。
 */
import { muniName, prefName } from '../domain/muni';

const ENDPOINT = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const TIMEOUT_MS = 8_000;

export interface AreaName {
  /** 市区町村コード。11216 */
  muniCd: string;
  /** 市区町村。羽生市 */
  areaName: string;
  /** 町名。東六丁目。取れないことがある */
  areaDetail: string | null;
  /** 都道府県。埼玉県 */
  prefecture: string | null;
}

/**
 * 逆ジオコーディング。
 *
 * 見つからない・応答が想定と違う場合は null を返す（例外にしない）。
 * 地名は飾りなので、取れないことは異常ではない。
 * 通信そのものの失敗だけ例外として投げ、呼び出し側が失敗回数を数える。
 */
export async function reverseGeocode(lat: number, lng: number): Promise<AreaName | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `${ENDPOINT}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`国土地理院が ${response.status} を返しました`);
    }

    const body = (await response.json()) as { results?: { muniCd?: string; lv01Nm?: string } };
    const muniCd = body?.results?.muniCd;
    if (!muniCd) return null;

    const areaName = muniName(muniCd);
    // 表が古くて名前にできないコードは、地名なしとして扱う。
    // コードだけ残しても画面には出せない
    if (!areaName) return null;

    const detail = body.results?.lv01Nm ?? null;

    return {
      muniCd,
      areaName,
      areaDetail: detail && detail !== '' ? detail : null,
      prefecture: prefName(muniCd),
    };
  } finally {
    clearTimeout(timer);
  }
}
