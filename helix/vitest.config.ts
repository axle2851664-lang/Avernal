import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /*
     * `npm run build` compiles the tests into dist/ alongside everything else,
     * and `npm run server` builds before it starts. Without this, running the
     * suite after ever having started the server executes every test twice:
     * once from src/, and once from whatever dist/ happened to hold, which is
     * stale the moment a source file changes.
     */
    exclude: ['node_modules/**', 'dist/**'],
  },
});
