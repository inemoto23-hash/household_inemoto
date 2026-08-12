/**
 * 支出マップの画像。**渡された地点を渡された順に描くだけ。**
 *
 * ここは順位を決めない。DB も引かない。
 * 以前は分析画面とは別にこの関数が集計と並べ替えを行っていたため、
 * 「一覧の①」と「画像の①」が違う店を指すことがあった。
 * 同じ SQL を2回実行する形にしても、実行が2回ある限り食い違う余地は消えない
 * （同額のときの並び、キャッシュの寿命の違い）。
 *
 * **番号を数えるのは一度きり**にして、その結果をここへ渡す。
 * 番号は受け取った並びの位置そのもの。ラベルを別に受け取らないので、
 * 「番号と座標がずれて渡る」という事故が起こせない。
 * Azure Maps のラベルが ASCII しか解釈できない制約も、これで自動的に守られる。
 *
 * 画像そのものを返すのは、地図をブラウザ側で組み立てさせないため。
 * ブラウザから Azure Maps を直接呼ぶには、キーを配るか、
 * 利用者ひとりひとりに Azure のロールを割り当てるかのどちらかになる。
 */
import { app } from '@azure/functions';
import { fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import { fetchStaticMap, isMapsConfigured, MapPin } from '../shared/maps';
import { monthRange } from '../domain/entry';
import { MAX_PINS } from '../shared/places';

/**
 * `p=緯度,経度;緯度,経度;…` を読む。
 *
 * 順位の判断はしない。**受け取った順のまま**で、上限を超えたぶんだけ落とす。
 * 上限は安全弁であって、どれを載せるかの判断ではない。
 */
export function parsePins(raw: string | null): MapPin[] | { error: string } {
  if (!raw) return [];

  const pins: MapPin[] = [];
  for (const part of raw.split(';')) {
    if (!part) continue;
    const [latText, lngText] = part.split(',');
    const lat = Number(latText);
    const lng = Number(lngText);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { error: `地点の書式が不正です: ${part.slice(0, 40)}` };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { error: `地点が範囲外です: ${part.slice(0, 40)}` };
    }

    pins.push({ lat, lng, label: String(pins.length + 1) });
    if (pins.length >= MAX_PINS) break;
  }
  return pins;
}

app.http('analyticsMap', {
  methods: ['GET'],
  authLevel: 'anonymous',
  // 月は問い合わせには使わない（地点は呼び出し側が渡す）。
  // URL を読んで何の地図か分かるようにするためと、古い経路を 404 にしないために残す
  route: 'analytics/{ym}/map',
  handler: withAuth(async (req, ctx) => {
    if (!monthRange(req.params.ym)) {
      return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');
    }

    if (!isMapsConfigured()) {
      return fail(503, 'MAPS_NOT_CONFIGURED', '地図は現在利用できません');
    }

    const width = Number(req.query.get('w') ?? 720);
    const height = Number(req.query.get('h') ?? 480);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return fail(400, 'VALIDATION_ERROR', '画像の大きさが不正です');
    }

    const parsed = parsePins(req.query.get('p'));
    if (!Array.isArray(parsed)) {
      return fail(400, 'VALIDATION_ERROR', parsed.error);
    }

    // 地点が無い。画面側は地図を出さずに済ませる。
    // 400 にしないのは、デプロイの前後で古い画面がエラー表示になるのを避けるため
    if (parsed.length === 0) return { status: 204 };

    try {
      const image = await fetchStaticMap({ pins: parsed, width, height });

      return {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          /*
           * 長めに持たせてよい。**URL が中身で決まる**ため。
           * 地点が変われば `p` が変わり、別の URL になる。
           * 古い画像が出てくる経路が無い。
           */
          'Cache-Control': 'private, max-age=3600',
        },
        body: image,
      };
    } catch (err) {
      // 地図が出せなくても分析画面そのものは使える。502 で区別できるようにする
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Azure Maps')) {
        ctx.error(`支出マップの取得に失敗: ${message}`);
        return fail(502, 'MAP_UNAVAILABLE', '地図を取得できませんでした');
      }
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
