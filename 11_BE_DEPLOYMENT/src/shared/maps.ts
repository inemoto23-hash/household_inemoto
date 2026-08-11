/**
 * 地図画像の取得（Azure Maps）。
 *
 * サブスクリプションキーを持たない。マネージドIDで取得したトークンだけで呼ぶ。
 * ブラウザから直接呼ばせないのは、そうするとキーを配るか、
 * 利用者ひとりひとりに Azure のロールを割り当てるかのどちらかになるため。
 * ここを通せば、認証は今までどおりアプリの Bearer トークンだけで済む。
 *
 * 地名のラベルは日本語で描かれる。
 * 場所の検索・逆引き（POI）が日本ではローマ字で使い物にならなかったのとは別の系統。
 */
import { DefaultAzureCredential } from '@azure/identity';

const MAPS_SCOPE = 'https://atlas.microsoft.com/.default';
/** 期限のこれだけ手前で取り直す（ミリ秒） */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15_000;

/** 静的地図の上限。これを超える指定は Azure Maps が拒否する */
const MAX_SIDE = 8192;
const MIN_SIDE = 80;

/**
 * 静的地図1タイルの画素数。
 *
 * 256 で計算すると拡大率が1段きつくなり、端の地点が画像からはみ出す。
 * 実際に描かせて位置を突き合わせたところ 512 だった。
 */
const TILE_SIZE = 512;

const credential = new DefaultAzureCredential();
let cachedToken: { value: string; expiresOn: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresOn - REFRESH_MARGIN_MS) {
    return cachedToken.value;
  }
  const token = await credential.getToken(MAPS_SCOPE);
  if (!token) throw new Error('Azure Maps のアクセストークンを取得できませんでした');
  cachedToken = { value: token.token, expiresOn: token.expiresOnTimestamp };
  return token.token;
}

export function isMapsConfigured(): boolean {
  return !!process.env.MAPS_CLIENT_ID;
}

export interface MapPin {
  lat: number;
  lng: number;
  /** ピンに描く短い文字。番号を想定している */
  label: string;
}

// ---------------------------------------------------------------
// 表示範囲の決定
// ---------------------------------------------------------------

/** Web メルカトルの正規化座標（0..1） */
function project(lat: number, lng: number): { x: number; y: number } {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return {
    x: (lng + 180) / 360,
    y: (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2,
  };
}

/**
 * すべての点が入る中心と拡大率を決める。
 *
 * Azure Maps は bbox と width/height を同時に受け付けないため、
 * 出力サイズを指定したい場合は拡大率をこちらで出す必要がある。
 * ピンは点の真上ではなく上に伸びるので、余白を多めに取る。
 */
export function fitView(
  points: { lat: number; lng: number }[],
  width: number,
  height: number
): { center: string; zoom: number } {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const center = `${(Math.min(...lngs) + Math.max(...lngs)) / 2},${(Math.min(...lats) + Math.max(...lats)) / 2}`;

  const a = project(Math.min(...lats), Math.min(...lngs));
  const b = project(Math.max(...lats), Math.max(...lngs));
  const spanX = Math.abs(b.x - a.x);
  const spanY = Math.abs(b.y - a.y);

  // 点が1つ、または全部ほぼ同じ場所。街区が見える程度に寄せる
  if (spanX < 1e-9 && spanY < 1e-9) return { center, zoom: 15 };

  // ピンと著作権表記のぶんだけ内側に収める
  const usableW = Math.max(64, width - 96);
  const usableH = Math.max(64, height - 128);

  const zoomX = spanX > 0 ? Math.log2(usableW / (TILE_SIZE * spanX)) : 20;
  const zoomY = spanY > 0 ? Math.log2(usableH / (TILE_SIZE * spanY)) : 20;

  return { center, zoom: Math.max(1, Math.min(18, Math.floor(Math.min(zoomX, zoomY)))) };
}

// ---------------------------------------------------------------

/**
 * ピンの書式。座標は「経度 緯度」で、間は空白。
 *
 * ラベルは ASCII だけにすること。Azure Maps は非 ASCII の文字を解釈できず、
 * 「家」を渡すと %E5%AE%B6 とそのまま描かれる。番号なら安全。
 * label が空ならラベル無しのピンにする。
 */
function pinsParam(pins: MapPin[]): string {
  const style = 'default|coE05C4F|lcFFFFFF|ls13|sc1.1';
  const points = pins.map((p) => (p.label ? `'${p.label}'${p.lng} ${p.lat}` : `${p.lng} ${p.lat}`));
  return `${style}||${points.join('|')}`;
}

/**
 * 地図画像を PNG で取り出す。
 * 例外はそのまま投げる。呼び出し側で 502 に畳む。
 */
export async function fetchStaticMap(options: {
  pins: MapPin[];
  width: number;
  height: number;
  /** 拡大率を決め打ちする。1地点だけのときは自動計算だと引きすぎる */
  zoom?: number;
}): Promise<Buffer> {
  const clientId = process.env.MAPS_CLIENT_ID;
  if (!clientId) throw new Error('MAPS_CLIENT_ID が設定されていません');
  if (options.pins.length === 0) throw new Error('描く地点がありません');

  const width = Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(options.width)));
  const height = Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(options.height)));
  const view = fitView(options.pins, width, height);

  const query = new URLSearchParams({
    'api-version': '2024-04-01',
    center: view.center,
    zoom: String(options.zoom ?? view.zoom),
    width: String(width),
    height: String(height),
    language: 'ja-JP',
    pins: pinsParam(options.pins),
  });

  const token = await getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`https://atlas.microsoft.com/map/static?${query}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-ms-client-id': clientId,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Azure Maps が ${response.status} を返しました: ${detail.slice(0, 300)}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}
