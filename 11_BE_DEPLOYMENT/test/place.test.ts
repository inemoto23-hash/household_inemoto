/**
 * matchPlace — 7つの reason 分岐を全網羅する。
 * 判定を間違えると「同じ店が2つに割れる」「別の店の金額が混ざる」という
 * 形でしか気付けない。
 */
import { describe, expect, it } from 'vitest';
import {
  displayName,
  matchPlace,
  normalizePlaceName,
  type PlaceCandidate,
} from '../src/domain/place';

/** 緯度 delta 換算: 200m ≈ 0.0017986 度 */
const latDelta = (m: number) => m / 111_194.9;

const at = (lat: number, lng: number) => ({ lat, lng });
const base = at(35.0, 135.0);

const cand = (id: number, name: string, lat: number | null, lng: number | null): PlaceCandidate => ({
  id,
  name,
  lat,
  lng,
});

describe('matchPlace: 座標あり', () => {
  it('matched-by-distance: 200m 以内でいちばん近い候補を選ぶ', () => {
    const candidates = [
      cand(1, 'イオン', base.lat + latDelta(150), base.lng),
      cand(2, 'イオン', base.lat + latDelta(80), base.lng),
      cand(3, 'イオン', base.lat + latDelta(400), base.lng), // 圏外
    ];
    const r = matchPlace({ name: 'イオン', ...base }, candidates);
    expect(r).toEqual({ placeId: 2, create: false, reason: 'matched-by-distance' });
  });

  it('new-place: 同名でも 200m 超なら新しい店として作る', () => {
    const candidates = [cand(1, 'イオン', base.lat + latDelta(300), base.lng)];
    const r = matchPlace({ name: 'イオン', ...base }, candidates);
    expect(r).toEqual({ placeId: null, create: true, reason: 'new-place' });
  });

  it('adopted-coordless: 座標なしマスタが1件だけなら座標を書き込んで育てる', () => {
    const candidates = [cand(1, 'イオン', null, null)];
    const r = matchPlace({ name: 'イオン', ...base }, candidates);
    expect(r).toEqual({
      placeId: 1,
      create: false,
      adoptCoords: true,
      reason: 'adopted-coordless',
    });
  });

  it('座標なしマスタが複数なら育てず新しく作る', () => {
    const candidates = [cand(1, 'イオン', null, null), cand(2, 'イオン', null, null)];
    const r = matchPlace({ name: 'イオン', ...base }, candidates);
    expect(r).toEqual({ placeId: null, create: true, reason: 'new-place' });
  });

  it('座標つきマスタが既にある（圏外）なら座標なしマスタは育てない', () => {
    const candidates = [
      cand(1, 'イオン', base.lat + latDelta(300), base.lng), // 圏外の座標つき
      cand(2, 'イオン', null, null),
    ];
    const r = matchPlace({ name: 'イオン', ...base }, candidates);
    expect(r).toEqual({ placeId: null, create: true, reason: 'new-place' });
  });
});

describe('matchPlace: 座標なし', () => {
  it('matched-only-candidate: 同名がちょうど1件ならそれ', () => {
    const r = matchPlace({ name: 'イオン', lat: null, lng: null }, [cand(1, 'イオン', null, null)]);
    expect(r).toEqual({ placeId: 1, create: false, reason: 'matched-only-candidate' });
  });

  it('no-coords-no-master: マスタが無くても座標なしでは作らない', () => {
    const r = matchPlace({ name: 'イオン', lat: null, lng: null }, []);
    expect(r).toEqual({ placeId: null, create: false, reason: 'no-coords-no-master' });
  });

  it('ambiguous-no-coords: 同名が複数なら当てずっぽうに選ばず紐付けない', () => {
    const candidates = [cand(1, 'イオン', 35.0, 135.0), cand(2, 'イオン', 36.0, 136.0)];
    const r = matchPlace({ name: 'イオン', lat: null, lng: null }, candidates);
    expect(r).toEqual({ placeId: null, create: false, reason: 'ambiguous-no-coords' });
  });
});

describe('matchPlace: 店名', () => {
  it('no-name: 店名なし・空白のみは紐付けない', () => {
    expect(matchPlace({ name: null, ...base }, []).reason).toBe('no-name');
    expect(matchPlace({ name: '  　 ', ...base }, []).reason).toBe('no-name');
  });

  it('空白の揺れは正規化して同名とみなす', () => {
    const candidates = [cand(1, 'イオン モール', base.lat, base.lng)];
    const r = matchPlace({ name: ' イオン　  モール ', ...base }, candidates);
    expect(r.placeId).toBe(1);
    expect(r.reason).toBe('matched-by-distance');
  });
});

describe('normalizePlaceName', () => {
  it('全角空白を含む連続空白を1つに潰し、空なら null', () => {
    expect(normalizePlaceName(' イオン　  モール ')).toBe('イオン モール');
    expect(normalizePlaceName('   ')).toBeNull();
    expect(normalizePlaceName(null)).toBeNull();
    expect(normalizePlaceName(undefined)).toBeNull();
  });
});

describe('displayName', () => {
  it('DB の計算列 display_name と同じ規則', () => {
    expect(displayName('イオン', '岡山市北区')).toBe('イオン（岡山市北区）');
    expect(displayName('イオン', null)).toBe('イオン');
  });
});
