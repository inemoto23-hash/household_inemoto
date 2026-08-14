/**
 * 予定の時刻計算 — 間違えると「通知が来ない」「夜中に来る」という形でしか気付けない。
 */
import { describe, expect, it } from 'vitest';
import {
  formatMoment,
  formatOffset,
  reminderSendAt,
  scheduleMomentUtc,
} from '../src/domain/schedule';

describe('scheduleMomentUtc', () => {
  it('JST 14:00 は UTC 05:00', () => {
    expect(scheduleMomentUtc('2026-08-15', 14 * 60)).toBe(Date.UTC(2026, 7, 15, 5, 0));
  });

  it('終日は当日 9:00 JST 基準（= UTC 00:00）', () => {
    expect(scheduleMomentUtc('2026-08-15', null)).toBe(Date.UTC(2026, 7, 15, 0, 0));
  });
});

describe('reminderSendAt', () => {
  it('1日前通知は前日の同時刻', () => {
    expect(reminderSendAt('2026-08-15', 14 * 60, 1440).getTime()).toBe(
      Date.UTC(2026, 7, 14, 5, 0)
    );
  });

  it('終日の前日通知は前日 9:00 JST（真夜中に飛ばない）', () => {
    expect(reminderSendAt('2026-08-15', null, 1440).getTime()).toBe(Date.UTC(2026, 7, 14, 0, 0));
  });
});

describe('formatMoment', () => {
  it('時刻あり・終日', () => {
    expect(formatMoment('2026-08-15', 14 * 60)).toBe('8月15日(土) 14:00');
    expect(formatMoment('2026-08-15', null)).toBe('8月15日(土) 終日');
    expect(formatMoment('2026-08-15', 5)).toBe('8月15日(土) 00:05');
  });
});

describe('formatOffset', () => {
  it('日・時間・分の使い分け', () => {
    expect(formatOffset(0)).toBe('予定の時刻');
    expect(formatOffset(1440)).toBe('1日前');
    expect(formatOffset(2880)).toBe('2日前');
    expect(formatOffset(60)).toBe('1時間前');
    expect(formatOffset(180)).toBe('3時間前');
    expect(formatOffset(90)).toBe('90分前');
  });
});
