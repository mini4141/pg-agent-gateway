import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The gateway serves the build under /static/ (via @fastify/static), so assets are absolute from there.
export default defineConfig({
  base: '/static/',
  plugins: [react()],
  server: { port: 5173, proxy: { '/v1': 'http://localhost:8080' } },
});
