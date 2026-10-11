/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:4001' } },
  preview: { proxy: { '/api': 'http://localhost:4001' } },
  test: {
    include: ['test/**/*.test.ts'],
    // Server tests share one Postgres database.
    fileParallelism: false,
  },
});
