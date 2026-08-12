/**
 * 場所別の集計。**分析の一覧と支出マップで必ず同じものを使う。**
 *
 * ここを1本にしているのは、以前この集計が2か所に書かれていて番号がずれたため。
 * 地図側だけ `WHERE lat IS NOT NULL` を集計の前に置いていたので、
 * 座標を持たない記録がある店は地図側でだけ金額が小さく評価され、順位が入れ替わった。
 *
 *   スーパーA 合計 30,000円（うち座標つき 5,000円）
 *   スーパーB 合計 20,000円（すべて座標つき）
 *   → 一覧は A=① B=②、地図は B=① A=②
 *
 * 一覧の①を確かめに地図の①を見ると別の店。座標は正しいので 📍リンクでは合っている、
 * という分かりにくい壊れ方をする。
 *
 * 座標を持たない記録は今後も増える（一括登録は位置を受け取らない、自宅では座標を落とす、
 * 誤差500m超は捨てる）。**ずれられない作りにしておくこと自体が対策**になる。
 *
 * 束ねる単位は場所マスタ（`dbo.places`）。同じ「イオン」でも離れた場所は別のマスタに
 * なるので、2店舗が1つのピンにまとまらない。代表座標もマスタが持つ固定値を使う。
 * 記録側の座標から毎回選び直すと、最後の1件が外れ値だったときに引きずられる。
 *
 * マスタに紐付いていない記録（一括登録だけの店、マイグレーション前の残り）は
 * 今までどおり店名で束ねる。`COALESCE` がその受け皿になっている。
 */
import { num } from '../db/convert';

/** 場所別に返す上限（一覧） */
export const PLACE_LIMIT = 30;

/**
 * 地図に並べる上限。これ以上はピンが重なって読めない。
 * FE の `AnalyticsPage` にも同じ値がある。片方を変えたらもう片方も変えること。
 */
export const MAX_PINS = 10;

/** 支出の符号を揃える式。返金は支出を戻す。カレンダー・予算と揃える */
const SPEND = `CASE e.kind WHEN 'expense' THEN e.amount WHEN 'refund' THEN -e.amount ELSE 0 END`;

export interface PlaceAggregate {
  name: string;
  amount: number;
  entryCount: number;
  lastUsed: string;
  /** 代表座標。その店に座標つきの記録が1件も無ければ null */
  lat: number | null;
  lng: number | null;
  categoryName: string | null;
  categoryColor: string | null;
}

/**
 * 場所別の SELECT。`@hid` / `@from` / `@to` / `@places` を要求する。
 *
 * **代表座標は「直近の座標つき記録」の座標。**
 * 以前は `AVG` だったが、外れ値1件で全体が引きずられ、
 * 同名の別店舗は中間（どちらでもない場所）に立っていた。
 *
 * 「特定の行の値」は `GROUP BY` の中では直接取れないので、窓関数で順位を振ってから拾う。
 * `ORDER BY` の第1項が座標の有無なので、**`rn = 1` は座標つきの中でいちばん新しい行**、
 * その店に座標つきが1件も無ければ座標なしの行になる。後者なら lat は NULL のままで、
 * 地図に出ない。これが望む挙動。
 *
 * 店ごとに `OUTER APPLY` で引き直す書き方もあるが、Basic 5DTU では索引探索が
 * 30回積む。窓関数なら月内の行を1回なめるだけで済む。
 *
 * 代表座標は**同じ月の中から**選ぶ。全期間に広げると「その月は座標なしで記録した店」にも
 * ピンが立ち、「位置つきが1件も無い月は地図を出さない」という約束が変わってしまう。
 */
export function placesSelect(): string {
  return `
    WITH ranked AS (
      SELECT COALESCE(pl.display_name, e.merchant, e.place_name) AS name,
             ${SPEND}          AS spend,
             e.entry_date      AS entry_date,
             -- マスタの座標を最優先する。無いときだけ記録の座標に落ちる
             pl.lat            AS place_lat,
             pl.lng            AS place_lng,
             e.lat             AS lat,
             e.lng             AS lng,
             c.name            AS category_name,
             c.color           AS category_color,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(pl.display_name, e.merchant, e.place_name)
               ORDER BY CASE WHEN e.lat IS NULL THEN 1 ELSE 0 END,
                        e.entry_date DESC,
                        e.id DESC
             ) AS rn
        FROM dbo.entries e
        LEFT JOIN dbo.budget_categories c ON c.id = e.budget_category_id
        LEFT JOIN dbo.places pl           ON pl.id = e.place_id
       WHERE e.household_id = @hid AND e.is_deleted = 0
         AND e.entry_date >= @from AND e.entry_date < @to
         AND e.kind IN ('expense', 'refund')
         AND COALESCE(pl.display_name, e.merchant, e.place_name) IS NOT NULL
    )
    SELECT TOP (@places)
           name,
           SUM(spend)                        AS amount,
           COUNT(*)                          AS entry_count,
           MAX(entry_date)                   AS last_used,
           COALESCE(MAX(place_lat), MAX(CASE WHEN rn = 1 THEN lat END)) AS lat,
           COALESCE(MAX(place_lng), MAX(CASE WHEN rn = 1 THEN lng END)) AS lng,
           MAX(category_name)                AS category_name,
           MAX(category_color)               AS category_color
      FROM ranked
     GROUP BY name
    HAVING SUM(spend) <> 0
     -- 同額のときの決め手を必ず置く。無いと取り直すたびに並びが入れ替わりうる。
     -- 地図の番号はこの並びに従うので、ここが安定しないと全体が安定しない
     ORDER BY amount DESC, name`;
}

/** `placesSelect()` の1行を DTO へ */
export function toPlace(row: any): PlaceAggregate {
  return {
    name: row.name,
    amount: num(row.amount),
    entryCount: num(row.entry_count),
    lastUsed:
      row.last_used instanceof Date
        ? row.last_used.toISOString().slice(0, 10)
        : String(row.last_used).slice(0, 10),
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
    categoryName: row.category_name ?? null,
    categoryColor: row.category_color ?? null,
  };
}

/*
 * ここに「地図に出す場所を選ぶ」関数は置かない。
 *
 * 順位を決める場所は**ひとつだけ**にする。この SELECT が返した並びが唯一の順位で、
 * 地図はそれを受け取って描くだけ（`functions/map.ts` は DB を引かない）。
 * 選び直す関数をここに置くと、また2か所で数えることになる。
 */
