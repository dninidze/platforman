import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = process.env.P3_SERVER ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target, ws: true },
      '/api': target,
    },
  },
});
