import { defineConfig } from 'vite';

// Use relative base so the build works at any GitHub Pages subpath (e.g. /air-guitar/).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
  server: {
    port: 5173,
    host: true,
  },
});
