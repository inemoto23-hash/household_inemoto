/**
 * DB 値の正規化 — node-mssql は BIGINT を文字列で返す。
 * 変換漏れは「z.number() が弾いて 500」という形で過去に実際に起きた。
 */
import { describe, expect, it } from 'vitest';
import { num, numOrNull } from '../src/db/convert';

describe('num', () => {
  it('BIGINT の文字列を number にする', () => {
    expect(num('12345678901')).toBe(12_345_678_901);
    expect(num(42)).toBe(42);
  });

  it('null / undefined は 0', () => {
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
  });

  it('数値にならない値は throw（黙って NaN を流さない）', () => {
    expect(() => num('abc')).toThrow();
    expect(() => num('Infinity')).toThrow();
    expect(() => num({})).toThrow();
  });
});

describe('numOrNull', () => {
  it('null は null のまま。値は number にする', () => {
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
    expect(numOrNull('42')).toBe(42);
  });
});
