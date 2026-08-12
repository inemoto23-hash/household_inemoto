/**
 * 定期取引の繰り返し計算。
 *
 * ここは純粋関数だけで構成する。DB にも HTTP にも触れない。
 * 日付を間違えても「記帳されない」「二重に記帳される」という形でしか気付けないため、
 * 単体で確かめられる形にしておく。
 *
 * 日付は YYYY-MM-DD の文字列として扱い、計算には Date.UTC だけを使う。
 * カレンダー上の日付であって時刻ではないので、これでタイムゾーンの影響を受けない。
 */
import { z } from 'zod';

/** 日本は夏時間が無いので固定で足りる */
const JST_OFFSET_MINUTES = 9 * 60;

export const FREQS = ['monthly', 'weekly', 'yearly'] as const;
export type Freq = (typeof FREQS)[number];

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 繰り返しの条件。取引の雛形とは別に持つ */
export interface Recurrence {
  freq: Freq;
  intervalN: number;
  /** monthly / yearly。31 は「月末」も兼ねる */
  dayOfMonth: number | null;
  /** yearly */
  monthOfYear: number | null;
  /** weekly。0=日 .. 6=土 */
  weekday: number | null;
  startDate: string;
  endDate: string | null;
}

export const recurrenceSchema = z
  .object({
    freq: z.enum(FREQS),
    intervalN: z.coerce.number().int().min(1).max(12).default(1),
    dayOfMonth: z.coerce.number().int().min(1).max(31).nullable().optional(),
    monthOfYear: z.coerce.number().int().min(1).max(12).nullable().optional(),
    weekday: z.coerce.number().int().min(0).max(6).nullable().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '開始日は YYYY-MM-DD 形式で指定してください'),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, '終了日は YYYY-MM-DD 形式で指定してください')
      .nullable()
      .optional(),
  })
  .transform((v) => ({
    freq: v.freq,
    intervalN: v.intervalN,
    dayOfMonth: v.dayOfMonth ?? null,
    monthOfYear: v.monthOfYear ?? null,
    weekday: v.weekday ?? null,
    startDate: v.startDate,
    endDate: v.endDate ?? null,
  }));

// ---------------------------------------------------------------
// 日付の道具
// ---------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

export function toKey(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parts(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

/** その年月の日数。月末への丸めに使う */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 0=日 .. 6=土 */
export function weekdayOf(key: string): number {
  const { y, m, d } = parts(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(key: string, n: number): string {
  const { y, m, d } = parts(key);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return toKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 今日の日付（日本時間）。タイマーは UTC で動くので必ずこれを通す */
export function todayJst(now: Date = new Date()): string {
  const t = new Date(now.getTime() + JST_OFFSET_MINUTES * 60_000);
  return toKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// ---------------------------------------------------------------
// 繰り返しの検証
// ---------------------------------------------------------------

/** 頻度ごとに必要な項目が揃っているか。DB の ck_rec_freq_shape と同じ条件 */
export function validateRecurrence(r: Recurrence): string | null {
  if (r.endDate && r.endDate < r.startDate) return '終了日は開始日より後にしてください';

  if (r.freq === 'monthly') {
    if (!r.dayOfMonth) return '毎月の場合は日付を選んでください';
  } else if (r.freq === 'weekly') {
    if (r.weekday === null) return '毎週の場合は曜日を選んでください';
  } else {
    if (!r.dayOfMonth || !r.monthOfYear) return '毎年の場合は月と日を選んでください';
  }
  return null;
}

/** 保存する形に整える。使わない項目は必ず null にする */
export function normalizeRecurrence(r: Recurrence): Recurrence {
  if (r.freq === 'monthly') {
    return { ...r, weekday: null, monthOfYear: null };
  }
  if (r.freq === 'weekly') {
    return { ...r, dayOfMonth: null, monthOfYear: null };
  }
  return { ...r, weekday: null };
}

// ---------------------------------------------------------------
// 次の該当日
// ---------------------------------------------------------------

/**
 * after より後（after は含まない）で最初の該当日。
 * 該当が無くなったら null を返す。
 *
 * 月末は丸める。31日指定の2月は28（閏なら29）日になる。
 * 判定の基準は常に指定日そのものなので、
 * 「31日 → 2月28日 → 以降ずっと28日」にはならない。
 */
export function nextOccurrence(r: Recurrence, after: string): string | null {
  const floor = after < r.startDate ? addDays(r.startDate, -1) : after;
  const found = r.freq === 'weekly' ? nextWeekly(r, floor) : nextMonthlyOrYearly(r, floor);

  if (!found) return null;
  if (r.endDate && found > r.endDate) return null;
  return found;
}

/** 開始日を含めた最初の該当日。ルールを作った直後の next_date に使う */
export function firstOccurrence(r: Recurrence): string | null {
  return nextOccurrence(r, addDays(r.startDate, -1));
}

/**
 * date を**含めて**、それ以降で最初の該当日。
 *
 * 規則を作った（直した）瞬間に過去へ遡って記帳されるのを防ぐために使う。
 * 過去の記録を定期にすると next_date が過去日になり、recurringSweep が
 * 62日以内の分を実体化してしまう。今日を渡して引き直せば、それが起きない。
 *
 * nextOccurrence は after を含まない仕様なので、1日戻して呼ぶだけでよい。
 * 1日ずつ進めるループにしないのは、月次が添字計算で一足飛びに求まるため。
 */
export function occurrenceOnOrAfter(r: Recurrence, date: string): string | null {
  return nextOccurrence(r, addDays(date, -1));
}

function nextWeekly(r: Recurrence, floor: string): string | null {
  // 開始日の週を基準に、intervalN 週ごとに数える
  const startWeekStart = addDays(r.startDate, -weekdayOf(r.startDate));

  // floor の翌日以降で最初に該当曜日が来る日
  let candidate = addDays(floor, 1);
  const shift = (r.weekday! - weekdayOf(candidate) + 7) % 7;
  candidate = addDays(candidate, shift);

  if (r.intervalN === 1) return candidate;

  // 隔週以上。開始週から数えて割り切れる週まで進める
  for (let i = 0; i < r.intervalN; i += 1) {
    const weekStart = addDays(candidate, -weekdayOf(candidate));
    const weeks = Math.round(
      (Date.parse(`${weekStart}T00:00:00Z`) - Date.parse(`${startWeekStart}T00:00:00Z`)) /
        (7 * 86_400_000)
    );
    if (weeks >= 0 && weeks % r.intervalN === 0) return candidate;
    candidate = addDays(candidate, 7);
  }
  return candidate;
}

function nextMonthlyOrYearly(r: Recurrence, floor: string): string | null {
  const start = parts(r.startDate);
  const step = r.freq === 'yearly' ? r.intervalN * 12 : r.intervalN;

  // 開始月を 0 とした通し番号で数える
  const startIndex = r.freq === 'yearly'
    ? (start.y * 12 + (r.monthOfYear! - 1))
    : (start.y * 12 + (start.m - 1));

  const floorParts = parts(floor);
  const floorIndex = floorParts.y * 12 + (floorParts.m - 1);

  // floor の月に追いつくところから探し始める。取りこぼしを防ぐため1つ手前から
  let n = Math.max(0, Math.floor((floorIndex - startIndex) / step) - 1);

  // 480 は40年分。無限ループにしないための上限
  for (let guard = 0; guard < 480; guard += 1, n += 1) {
    const index = startIndex + n * step;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    const d = Math.min(r.dayOfMonth!, daysInMonth(y, m));
    const key = toKey(y, m, d);

    if (key > floor && key >= r.startDate) return key;
    if (r.endDate && key > r.endDate) return null;
  }
  return null;
}

/**
 * today までに来ている該当日を古い順に並べる。取りこぼしの追いつき用。
 * skipBefore より古いものは飛ばす（長く止めた規則を再開したときに過去分が湧かないように）。
 */
export function occurrencesUpTo(
  r: Recurrence,
  from: string,
  today: string,
  options: { limit: number; skipBefore: string }
): { post: string[]; skipped: number; next: string | null } {
  const post: string[] = [];
  let skipped = 0;
  let cursor: string | null = from;

  while (cursor && cursor <= today && post.length < options.limit) {
    if (cursor >= options.skipBefore) post.push(cursor);
    else skipped += 1;
    cursor = nextOccurrence(r, cursor);
  }

  return { post, skipped, next: cursor };
}

// ---------------------------------------------------------------
// 表示
// ---------------------------------------------------------------

/** 「毎月25日」「隔週 火曜」「毎年4月1日」 */
export function describeRecurrence(r: Recurrence): string {
  const every = (unit: string) => (r.intervalN === 1 ? `毎${unit}` : `${r.intervalN}${unit}ごと`);

  if (r.freq === 'weekly') {
    return `${every('週')} ${WEEKDAY_LABELS[r.weekday ?? 0]}曜`;
  }
  if (r.freq === 'monthly') {
    const day = r.dayOfMonth === 31 ? '月末' : `${r.dayOfMonth}日`;
    return `${every('月')}${day}`;
  }
  const day = r.dayOfMonth === 31 ? '月末' : `${r.dayOfMonth}日`;
  return `${every('年')}${r.monthOfYear}月${day}`;
}
