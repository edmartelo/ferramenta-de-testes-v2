import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { promotionsApiPlugin } from './server/promotions-api.ts';

export default defineConfig({
  plugins: [vue(), promotionsApiPlugin()],
  server: {
    port: 15173,
    strictPort: true,
    fs: {
      // Replaces Vite's default list, so the defaults are repeated; the rest keeps secrets and participant data off /@fs and static serving.
      deny: [
        '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
        '.*.json', '**/*.tmp-*', '**/.atendimento-labels.json.imported', '**/promotions/*/reports/**', '**/.atendimentos/**', '**/.whatsapp-session/**', '**/test-results/**', '**/playwright-report/**',
      ],
    },
    watch: {
      // Chrome locks files inside its profile; scanning it crashes the watcher (scandir UNKNOWN).
      ignored: ['**/.whatsapp-session/**', '**/.atendimentos/**', '**/playwright-report/**'],
    },
  },
});
