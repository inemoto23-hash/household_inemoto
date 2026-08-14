/**
 * 座標のガード — 判定を間違えると「自宅なのに店名候補が出る」
 * 「店なのに位置が残らない」という形でしか気付けない。
 */
import { describe, expect, it } from 'vitest';
import {
  boundingBox,
  distanceMeters,
  dropIfImprecise,
  isAtHome,
  MAX_USEFUL_ACCURACY_M,
} from '../src/domain/geo';

/** 緯度1度 ≈ 111,195m（2πR/360）。テストの距離はここから逆算する */
const METERS_PER_LAT_DEG = 111_194.9;

describe('distanceMeters', () => {
  it('同一点は 0', () => {
    expect(distanceMeters(35.0, 135.0, 35.0, 135.0)).toBe(0);
  });

  it('緯度1度 ≈ 111.2km', () => {
    const d = distanceMeters(0, 0, 1, 0);
    expect(d).toBeCloseTo(METERS_PER_LAT_DEG, -2); // ±50m 程度の許容
  });

  it('赤道上の経度1度も ≈ 111.2km', () => {
    const d = distanceMeters(0, 0, 0, 1);
    expect(d).toBeCloseTo(METERS_PER_LAT_DEG, -2);
  });
});

describe('isAtHome', () => {
  const home = { lat: 35.0, lng: 135.0, radiusM: 50 };
  const latDelta = (m: number) => m / METERS_PER_LAT_DEG;

  it('自宅未登録・座標なしは常に false', () => {
    expect(isAtHome(null, { lat: 35, lng: 135 })).toBe(false);
    expect(isAtHome(home, null)).toBe(false);
  });

  it('半径内は true、半径外は false', () => {
    expect(isAtHome(home, { lat: 35.0 + latDelta(40), lng: 135.0 })).toBe(true);
    expect(isAtHome(home, { lat: 35.0 + latDelta(70), lng: 135.0 })).toBe(false);
  });
});

describe('dropIfImprecise', () => {
  const NULLED = { lat: null, lng: null, locationAccuracy: null };

  it('lat / lng のどちらかが欠けたら3つとも null', () => {
    expect(dropIfImprecise({ lat: 35, lng: null, locationAccuracy: 10 })).toEqual(NULLED);
    expect(dropIfImprecise({ lng: 135, locationAccuracy: 10 })).toEqual(NULLED);
    expect(dropIfImprecise({})).toEqual(NULLED);
  });

  it(`誤差 ${MAX_USEFUL_ACCURACY_M}m 超は捨てる。ちょうどは通す`, () => {
    expect(
      dropIfImprecise({ lat: 35, lng: 135, locationAccuracy: MAX_USEFUL_ACCURACY_M + 1 })
    ).toEqual(NULLED);
    expect(
      dropIfImprecise({ lat: 35, lng: 135, locationAccuracy: MAX_USEFUL_ACCURACY_M })
    ).toEqual({ lat: 35, lng: 135, locationAccuracy: MAX_USEFUL_ACCURACY_M });
  });

  it('誤差不明（null）は通す。値が無いことは「悪い」の証拠にならない', () => {
    expect(dropIfImprecise({ lat: 35, lng: 135 })).toEqual({
      lat: 35,
      lng: 135,
      locationAccuracy: null,
    });
  });
});

describe('boundingBox', () => {
  it('経度の幅は緯度の幅を cos(lat) で割ったもの（高緯度ほど広い）', () => {
    const box = boundingBox({ lat: 35, lng: 135, radiusM: 50 });
    expect(box.latDelta).toBeGreaterThan(0);
    expect(box.lngDelta).toBeCloseTo(box.latDelta / Math.cos((35 * Math.PI) / 180), 10);
  });

  it('赤道では縦横が等しい', () => {
    const box = boundingBox({ lat: 0, lng: 0, radiusM: 50 });
    expect(box.lngDelta).toBeCloseTo(box.latDelta, 10);
  });
});
