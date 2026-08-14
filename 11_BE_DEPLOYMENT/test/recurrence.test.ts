/**
 * 定期取引の繰り返し計算 — 間違えると「記帳されない」「二重に記帳される」
 * 「作った翌朝に覚えのない記録が湧く」という形でしか気付けない。
 */
import { describe, expect, it } from 'vitest';
import {
  describeRecurrence,
  firstOccurrence,
  nextOccurrence,
  normalizeRecurrence,
  occurrenceOnOrAfter,
  occurrencesUpTo,
  todayJst,
  validateRecurrence,
  type Recurrence,
} from '../src/domain/recurrence';

const monthly = (dayOfMonth: number, over: Partial<Recurrence> = {}): Recurrence => ({
  freq: 'monthly',
  intervalN: 1,
  dayOfMonth,
  monthOfYear: null,
  weekday: null,
  startDate: '2026-01-01',
  endDate: null,
  ...over,
});

const weekly = (weekday: number, over: Partial<Recurrence> = {}): Recurrence => ({
  freq: 'weekly',
  intervalN: 1,
  dayOfMonth: null,
  monthOfYear: null,
  weekday,
  startDate: '2026-08-03', // 月曜
  endDate: null,
  ...over,
});

describe('nextOccurrence: 月末の丸め', () => {
  const r = monthly(31);

  it('31日指定の2月は28日（平年）', () => {
    expect(nextOccurrence(r, '2026-01-31')).toBe('2026-02-28');
  });

  it('丸めた翌月は31日に戻る（ずっと28日にはならない）', () => {
    expect(nextOccurrence(r, '2026-02-28')).toBe('2026-03-31');
  });

  it('閏年の2月は29日', () => {
    expect(nextOccurrence(r, '2028-02-01')).toBe('2028-02-29');
  });
});

describe('nextOccurrence: 基本', () => {
  const r = monthly(15);

  it('after は含まない', () => {
    expect(nextOccurrence(r, '2026-08-13')).toBe('2026-08-15');
    expect(nextOccurrence(r, '2026-08-15')).toBe('2026-09-15');
  });

  it('年を跨ぐ', () => {
    expect(nextOccurrence(r, '2026-12-15')).toBe('2027-01-15');
  });

  it('endDate を超えたら null', () => {
    const ended = monthly(15, { endDate: '2026-09-30' });
    expect(nextOccurrence(ended, '2026-09-15')).toBeNull();
  });

  it('開始日より前の該当日は返さない', () => {
    const late = monthly(15, { startDate: '2026-08-20' });
    expect(firstOccurrence(late)).toBe('2026-09-15');
  });
});

describe('nextOccurrence: 週次', () => {
  it('毎週: 次の該当曜日', () => {
    // 2026-08-03 は月曜。weekday 2 = 火曜
    expect(nextOccurrence(weekly(2), '2026-08-03')).toBe('2026-08-04');
  });

  it('隔週: 開始週から数えて割り切れる週だけ', () => {
    const r = weekly(1, { intervalN: 2 }); // 隔週月曜、開始 2026-08-03（月）
    expect(firstOccurrence(r)).toBe('2026-08-03');
    expect(nextOccurrence(r, '2026-08-03')).toBe('2026-08-17'); // 翌週は飛ぶ
    expect(nextOccurrence(r, '2026-08-17')).toBe('2026-08-31');
  });
});

describe('occurrenceOnOrAfter', () => {
  it('その日が該当日なら同じ日を返す（作成時に過去へ遡らないための基準）', () => {
    expect(occurrenceOnOrAfter(monthly(15), '2026-08-15')).toBe('2026-08-15');
    expect(occurrenceOnOrAfter(monthly(15), '2026-08-16')).toBe('2026-09-15');
  });
});

describe('occurrencesUpTo: 追いつき記帳', () => {
  const r = monthly(1);

  it('skipBefore より古い分は湧かせず数だけ返す', () => {
    const { post, skipped, next } = occurrencesUpTo(r, '2026-01-01', '2026-08-13', {
      limit: 12,
      skipBefore: '2026-06-13',
    });
    expect(post).toEqual(['2026-07-01', '2026-08-01']);
    expect(skipped).toBe(6); // 1月〜6月分
    expect(next).toBe('2026-09-01');
  });

  it('limit で打ち切っても next が再開点になる（冪等に追いつける）', () => {
    const first = occurrencesUpTo(r, '2026-01-01', '2026-08-13', {
      limit: 3,
      skipBefore: '2020-01-01',
    });
    expect(first.post).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(first.next).toBe('2026-04-01');

    // next から再開すると残りが続きから出る＝重複しない
    const second = occurrencesUpTo(r, first.next!, '2026-08-13', {
      limit: 12,
      skipBefore: '2020-01-01',
    });
    expect(second.post[0]).toBe('2026-04-01');
    expect(second.post).toHaveLength(5); // 4月〜8月
  });
});

describe('validateRecurrence / normalizeRecurrence', () => {
  it('頻度ごとの必須項目（DB の ck_rec_freq_shape と同じ条件）', () => {
    expect(validateRecurrence(monthly(15))).toBeNull();
    expect(validateRecurrence(monthly(1, { dayOfMonth: null }))).toBeTruthy();
    expect(validateRecurrence(weekly(2, { weekday: null }))).toBeTruthy();
    expect(
      validateRecurrence({ ...monthly(15), freq: 'yearly', monthOfYear: null })
    ).toBeTruthy();
    expect(validateRecurrence(monthly(15, { endDate: '2025-12-31' }))).toBeTruthy();
  });

  it('使わない項目は必ず null に落とす', () => {
    const messy = { ...monthly(15), weekday: 3, monthOfYear: 4 };
    expect(normalizeRecurrence(messy)).toEqual(monthly(15));
  });
});

describe('todayJst', () => {
  it('UTC の夜は日本の翌日', () => {
    expect(todayJst(new Date('2026-08-13T20:00:00Z'))).toBe('2026-08-14');
    expect(todayJst(new Date('2026-08-13T10:00:00Z'))).toBe('2026-08-13');
  });
});

describe('describeRecurrence', () => {
  it('表示', () => {
    expect(describeRecurrence(monthly(25))).toBe('毎月25日');
    expect(describeRecurrence(monthly(31))).toBe('毎月月末');
    expect(describeRecurrence(weekly(2, { intervalN: 2 }))).toBe('2週ごと 火曜');
  });
});
