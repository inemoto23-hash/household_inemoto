/**
 * テストは test/ 直下に置く。src/ 配下に置くと tsconfig の include に入り、
 * tsc のビルド出力（dist/）へ混入するため。.funcignore は test を除外済みなので
 * デプロイ物にも入らない。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
