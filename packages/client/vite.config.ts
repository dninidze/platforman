import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { GAME_TITLE } from '../shared/src/constants';

/**
 * `npm run build` produces one self-contained file, app/dist/last-tile-standing.html: JS, CSS, the engine worker
 * (inlined as a blob) and multipliers.json are all embedded, so it runs from file:// with no network.
 */
export default defineConfig({
  base: './',
  plugins: [
    react(),
    // <title> comes from the single GAME_TITLE constant.
    { name: 'game-title', transformIndexHtml: (html: string) => html.replace(/<title>[^<]*<\/title>/,`<title>${GAME_TITLE}</title>`) },
    viteSingleFile({ removeViteModuleLoader: true }),
  ],
  // Classic (IIFE) worker: Chromium refuses inlined *module* workers from file:// pages.
  worker: { format: 'iife' },
  build: {
    outDir: fileURLToPath(new URL('../../dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
  server: { port: 5173 },
});
