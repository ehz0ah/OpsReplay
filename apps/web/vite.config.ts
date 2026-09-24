import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.OPSREPLAY_API_PORT ?? 3001);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535)
  throw new Error('Invalid OPSREPLAY_API_PORT');
const proxy = Object.fromEntries(
  ['/v1', '/dev', '/health'].map((path) => [path, 'http://127.0.0.1:' + apiPort]),
);

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
});
