/**
 * 自宅の登録。
 *
 * クレジットカードの履歴は、店ではなく自宅でまとめて付けることが多い。
 * そこに位置情報を添えると、支出マップに自宅が並び、
 * 店名の候補も自宅の近所から出てしまう。
 *
 * 自宅は世帯で1つ。登録すると、その範囲で記録されたものは
 * 座標を持たなくなる（shared/home.ts が入口で落とす）。
 */
import { app } from '@azure/functions';
import { z } from 'zod';
import { getPool, sql } from '../db/pool';
import { num } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import { getHome } from '../shared/home';
import { boundingBox, distanceMeters, HomeLocation } from '../domain/geo';
import { fetchStaticMap, isMapsConfigured } from '../shared/maps';

const homeInputSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().int().min(20).max(2000).default(50),
});

/** 確認用の地図。1地点だけなので拡大率は決め打ちにする */
const HOME_MAP_ZOOM = 17;

// ---------------------------------------------------------------
// 過去分の除去
// ---------------------------------------------------------------

/**
 * 自宅の範囲にある過去の記録から座標を外す。
 *
 * まず矩形で候補を絞り、距離で確定してから消す。
 * 矩形だけで判定すると、角が半径の約1.4倍まで入ってしまう。
 *
 * 金額・店名・カテゴリはそのまま残す。消すのは位置だけ。
 * 「自宅で付けた」ことと「何に使ったか」は別の話。
 */
async function clearNearby(
  householdId: number,
  home: HomeLocation
): Promise<{ entries: number; stock: number }> {
  const pool = await getPool();
  const box = boundingBox(home);

  const candidates = await pool
    .request()
    .input('hid', sql.BigInt, householdId)
    .input('latMin', sql.Decimal(9, 6), home.lat - box.latDelta)
    .input('latMax', sql.Decimal(9, 6), home.lat + box.latDelta)
    .input('lngMin', sql.Decimal(9, 6), home.lng - box.lngDelta)
    .input('lngMax', sql.Decimal(9, 6), home.lng + box.lngDelta).query(`
      SELECT id, lat, lng FROM dbo.entries
       WHERE household_id = @hid AND lat IS NOT NULL AND lng IS NOT NULL
         AND lat BETWEEN @latMin AND @latMax
         AND lng BETWEEN @lngMin AND @lngMax;

      SELECT id, lat, lng FROM dbo.entry_stock
       WHERE household_id = @hid AND lat IS NOT NULL AND lng IS NOT NULL
         AND lat BETWEEN @latMin AND @latMax
         AND lng BETWEEN @lngMin AND @lngMax;
    `);

  const [entryRows, stockRows] = candidates.recordsets as any[];

  const inRange = (rows: any[]) =>
    rows
      .filter(
        (r) => distanceMeters(home.lat, home.lng, Number(r.lat), Number(r.lng)) <= home.radiusM
      )
      .map((r) => num(r.id));

  const entryIds = inRange(entryRows);
  const stockIds = inRange(stockRows);

  // ID は数値であることを確かめてあるので IN 句へ直接埋めてよい
  if (entryIds.length > 0) {
    await pool.request().query(
      `UPDATE dbo.entries
          SET lat = NULL, lng = NULL, location_accuracy = NULL,
              updated_at = SYSUTCDATETIME()
        WHERE id IN (${entryIds.join(',')})`
    );
  }
  if (stockIds.length > 0) {
    await pool.request().query(
      `UPDATE dbo.entry_stock
          SET lat = NULL, lng = NULL, location_accuracy = NULL
        WHERE id IN (${stockIds.join(',')})`
    );
  }

  return { entries: entryIds.length, stock: stockIds.length };
}

// ---------------------------------------------------------------

app.http('homeGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'home',
  handler: withAuth(async (_req, ctx, { user }) => {
    try {
      return ok(await getHome(user.householdId));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('homeSet', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'home',
  handler: withAuth(async (req, ctx, { user }) => {
    const parsed = homeInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '位置情報が不正です', parsed.error.flatten());
    }
    const home: HomeLocation = {
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      radiusM: parsed.data.radiusM,
    };

    try {
      const pool = await getPool();
      await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('lat', sql.Decimal(9, 6), home.lat)
        .input('lng', sql.Decimal(9, 6), home.lng)
        .input('r', sql.Int, home.radiusM)
        .query(
          `UPDATE dbo.households
              SET home_lat = @lat, home_lng = @lng, home_radius_m = @r
            WHERE id = @hid`
        );

      // 登録した時点で、すでに範囲内にある過去の記録からも位置を外す
      const cleared = await clearNearby(user.householdId, home);

      return ok({ home, cleared });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('homeClear', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'home',
  handler: withAuth(async (_req, ctx, { user }) => {
    try {
      const pool = await getPool();
      await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .query(`UPDATE dbo.households SET home_lat = NULL, home_lng = NULL WHERE id = @hid`);

      // すでに外した過去の記録は戻さない。どれを外したか記録していないため
      return ok({ home: null });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

/**
 * 登録した場所の確認用の地図。
 * 数値だけ見せても、そこが自宅かどうか分からない。
 */
app.http('homeMap', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'home/map',
  handler: withAuth(async (req, ctx, { user }) => {
    if (!isMapsConfigured()) return fail(503, 'MAPS_NOT_CONFIGURED', '地図は現在利用できません');

    const width = Number(req.query.get('w') ?? 640);
    const height = Number(req.query.get('h') ?? 400);

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return fail(400, 'VALIDATION_ERROR', '画像の大きさが不正です');
    }

    // 未保存の候補地点を確かめたい場合は座標を直接受け取る。
    //
    // 有無の判定を Number() の結果だけで行ってはいけない。
    // 指定が無いと get() は null を返し、Number(null) は NaN ではなく 0 になる。
    // 0,0 は大西洋の真ん中なので、一面が青い海の地図が返ってしまう。
    const latText = req.query.get('lat');
    const lngText = req.query.get('lng');
    const given =
      latText !== null && lngText !== null
        ? { lat: Number(latText), lng: Number(lngText) }
        : null;

    if (given && (!Number.isFinite(given.lat) || !Number.isFinite(given.lng))) {
      return fail(400, 'VALIDATION_ERROR', '座標が不正です');
    }

    try {
      const point = given ?? (await getHome(user.householdId));

      if (!point) return { status: 204 };

      const image = await fetchStaticMap({
        // ラベルは付けない。Azure Maps は非 ASCII のピン文字を解釈できず、
        // 「家」が %E5%AE%B6 とそのまま描かれる。1点だけなので番号も要らない
        pins: [{ lat: point.lat, lng: point.lng, label: '' }],
        width,
        height,
        zoom: HOME_MAP_ZOOM,
      });

      return {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' },
        body: image,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Azure Maps')) {
        ctx.error(`自宅の地図の取得に失敗: ${message}`);
        return fail(502, 'MAP_UNAVAILABLE', '地図を取得できませんでした');
      }
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
