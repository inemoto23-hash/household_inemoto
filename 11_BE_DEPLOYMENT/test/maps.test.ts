/**
 * fitView — すべてのピンが画像に収まる中心と拡大率。
 * 拡大率を1段間違えると端の地点がはみ出す（512px タイルで計算する根拠は shared/maps.ts）。
 */
import { describe, expect, it } from 'vitest';
import { fitView } from '../src/shared/maps';

const parseCenter = (center: string) => center.split(',').map(Number) as [number, number];

describe('fitView', () => {
  it('1点だけなら街区が見える程度（zoom 15）に寄せる', () => {
    const { center, zoom } = fitView([{ lat: 35.68, lng: 139.76 }], 800, 600);
    expect(zoom).toBe(15);
    const [lng, lat] = parseCenter(center);
    expect(lng).toBeCloseTo(139.76, 6);
    expect(lat).toBeCloseTo(35.68, 6);
  });

  it('全点がほぼ同じ場所でも zoom 15', () => {
    const p = { lat: 35.68, lng: 139.76 };
    expect(fitView([p, { ...p }], 800, 600).zoom).toBe(15);
  });

  it('中心は緯度経度それぞれの中間', () => {
    const { center } = fitView(
      [
        { lat: 35.68, lng: 139.76 },
        { lat: 34.69, lng: 135.5 },
      ],
      1200,
      800
    );
    const [lng, lat] = parseCenter(center);
    expect(lng).toBeCloseTo((139.76 + 135.5) / 2, 6);
    expect(lat).toBeCloseTo((35.68 + 34.69) / 2, 6);
  });

  it('拡大率は 1〜18 の整数に収まる', () => {
    // 遠く離れた2点 × 小さい画像 → 下限側
    const far = fitView(
      [
        { lat: 45.5, lng: 141.3 },
        { lat: 26.2, lng: 127.7 },
      ],
      320,
      240
    );
    expect(Number.isInteger(far.zoom)).toBe(true);
    expect(far.zoom).toBeGreaterThanOrEqual(1);

    // ごく近い2点 × 大きい画像 → 上限側でクランプ
    const near = fitView(
      [
        { lat: 35.680001, lng: 139.760001 },
        { lat: 35.68, lng: 139.76 },
      ],
      2000,
      2000
    );
    expect(near.zoom).toBeLessThanOrEqual(18);
  });
});
