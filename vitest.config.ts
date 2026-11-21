import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests run as a personal build (with a board) unless a test says otherwise;
    // build.public.test.ts clears this to test the public default.
    env: { VITE_BOARD_BASE: 'http://board.test' },
  },
});
