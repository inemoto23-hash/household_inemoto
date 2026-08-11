/**
 * 予定の入力検証と、通知時刻の組み立て。
 *
 * ここは純粋関数だけで構成する。時刻の計算は間違えると
 * 「通知が来ない」「夜中に来る」という形でしか気付けないため、
 * DB にも HTTP にも触れない形にして単体で確かめられるようにしておく。
 */
import { z } from 'zod';

/** 日本は夏時間が無いので固定で足りる */
const JST_OFFSET_MINUTES = 9 * 60;

/** 終日の予定を何時のこととして扱うか（日本時間） */
export const ALL_DAY_ANCHOR_MINUTES = 9 * 60;

/** 画面に出す通知の選択肢。分は「予定時刻の何分前か」 */
export const REMINDER_CHOICES = [0, 60, 180, 1440] as const;

export const scheduleInputSchema = z.object({
  scheduledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD 形式で指定してください'),
  /** 0時からの分。終日なら null */
  startMinutes: z.coerce.number().int().min(0).max(1439).nullable().optional(),
  title: z.string().trim().min(1, 'タイトルを入力してください').max(120),
  detail: z.string().trim().max(2000).nullable().optional(),
  audience: z.enum(['creator', 'household']).default('household'),
  color: z.string().trim().max(20).nullable().optional(),
  isDone: z.boolean().optional(),
  /** 通知。空配列なら通知しない */
  reminders: z.array(z.coerce.number().int().min(0).max(20160)).max(6).optional(),
});

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

/**
 * 予定そのものの時刻（UTC のミリ秒）。
 * 終日の予定は当日の 9:00 を基準にする。前日通知が真夜中に飛ぶのを避けるため。
 */
export function scheduleMomentUtc(scheduledOn: string, startMinutes: number | null): number {
  const [y, m, d] = scheduledOn.split('-').map(Number);
  const minutes = startMinutes ?? ALL_DAY_ANCHOR_MINUTES;
  return Date.UTC(y, m - 1, d, 0, minutes - JST_OFFSET_MINUTES);
}

/** 通知を送る時刻（UTC）。offset は予定時刻の何分前か */
export function reminderSendAt(
  scheduledOn: string,
  startMinutes: number | null,
  offsetMinutes: number
): Date {
  return new Date(scheduleMomentUtc(scheduledOn, startMinutes) - offsetMinutes * 60_000);
}

/** 「8月15日(金) 14:00」のような表記。メール本文に使う */
export function formatMoment(scheduledOn: string, startMinutes: number | null): string {
  const [y, m, d] = scheduledOn.split('-').map(Number);
  // 曜日は UTC 基準で作った日付から取れば、時刻に関係なく正しい
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][
    new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  ];
  const day = `${m}月${d}日(${weekday})`;
  if (startMinutes === null) return `${day} 終日`;
  const hh = String(Math.floor(startMinutes / 60)).padStart(2, '0');
  const mm = String(startMinutes % 60).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

/** 「1時間前」のような表記 */
export function formatOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return '予定の時刻';
  if (offsetMinutes % 1440 === 0) return `${offsetMinutes / 1440}日前`;
  if (offsetMinutes % 60 === 0) return `${offsetMinutes / 60}時間前`;
  return `${offsetMinutes}分前`;
}
