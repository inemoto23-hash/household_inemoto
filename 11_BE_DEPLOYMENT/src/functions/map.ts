/**
 * 支出マップ。その月に使った場所を地図の上に並べて返す。
 *
 * 画像そのものを返すのは、地図をブラウザ側で組み立てさせないため。
 * ブラウザから Azure Maps を直接呼ぶには、キーを配るか、
 * 利用者ひとりひとりに Azure のロールを割り当てるかのどちらかになる。
 * ここで中継すれば、認証は今までどおりアプリの Bearer トークンだけで済む。
 *
 * 番号は分析画面の「どこで使ったか」の並び（金額の多い順）と揃える。
 * 地図と一覧で番号がずれると、どの棒がどのピンか分からなくなる。
 */
import { app } from '@azure/functions';
import { getPool, sql } from '../db/pool';
import { fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import { fetchStaticMap, isMapsConfigured, MapPin } from '../shared/maps';
import { monthRange } from '../domain/entry';
import { PLACE_LIMIT, mapPlaces, placesSelect, toPlace } from '../shared/places';

app.http('analyticsMap', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'analytics/{ym}/map',
  handler: withAuth(async (req, ctx, { user }) => {
    const range = monthRange(req.params.ym);
    if (!range) return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');

    if (!isMapsConfigured()) {
      return fail(503, 'MAPS_NOT_CONFIGURED', '地図は現在利用できません');
    }

    const width = Number(req.query.get('w') ?? 720);
    const height = Number(req.query.get('h') ?? 480);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return fail(400, 'VALIDATION_ERROR', '画像の大きさが不正です');
    }

    try {
      const pool = await getPool();
      /*
       * 一覧とまったく同じ集計・同じ並びを受け取る。
       *
       * 以前はここで `TOP 10` を取り、しかも座標つきの記録だけで金額を出していた。
       * そのため座標を持たない記録がある店は地図側でだけ順位が下がり、
       * 一覧の①と画像の①が別の店になっていた。
       * **絞るのは受け取った後。番号は絞ってから1回だけ数える。**
       */
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('from', sql.Date, range.from)
        .input('to', sql.Date, range.toExclusive)
        .input('places', sql.Int, PLACE_LIMIT)
        .query(placesSelect());

      const pins: MapPin[] = mapPlaces(result.recordset.map(toPlace)).map((place, i) => ({
        lat: place.lat!,
        lng: place.lng!,
        label: String(i + 1),
      }));

      // 位置つきの記録がまだ無い。画面側は地図を出さずに済ませる
      if (pins.length === 0) return { status: 204 };

      const image = await fetchStaticMap({ pins, width, height });

      return {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          // 同じ月を見返すたびに Azure Maps を呼ばない
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
