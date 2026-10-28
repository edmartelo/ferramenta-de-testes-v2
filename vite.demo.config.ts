import { join } from 'node:path';
import dotenv from 'dotenv';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

const ROOT = import.meta.dirname.replace(/\\/g, '/');

/** Mesmas telas da ferramenta; só a camada de dados e o login mudam. */
const SWAPS = new Map([
  [`${ROOT}/src/api.ts`, `${ROOT}/src/demo/api.ts`],
  [`${ROOT}/src/views/LoginView.vue`, `${ROOT}/src/demo/DemoLoginView.vue`],
  [`${ROOT}/src/components/ConnectorsMenu.vue`, `${ROOT}/src/demo/DemoConnectorsMenu.vue`],
]);

function demoSwap(): Plugin {
  return {
    name: 'demo-swap',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || importer.replace(/\\/g, '/').startsWith(`${ROOT}/src/demo/`)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return (resolved && SWAPS.get(resolved.id.replace(/\\/g, '/'))) ?? null;
    },
  };
}

/** `npm run dev:demo`: a mesma função da demo publicada atendendo /api, com as variáveis de `.env.demo`. */
function demoApi(): Plugin {
  return {
    name: 'demo-api',
    configureServer(server) {
      dotenv.config({ path: join(ROOT, '.env.demo'), quiet: true });
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        const { default: handleDemoRequest } = await server.ssrLoadModule('/server/demo/api.ts');
        await handleDemoRequest(req, res);
      });
    },
  };
}

export default defineConfig({
  mode: 'demo',
  plugins: [demoSwap(), vue(), demoApi()],
  server: {
    port: 15174,
    strictPort: true,
    fs: { deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '**/.git/**', '.*.json', '**/promotions/**', '**/.atendimentos/**', '**/.whatsapp-session/**'] },
  },
});
