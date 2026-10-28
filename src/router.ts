import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import LoginView from './views/LoginView.vue';
import SetupView from './views/SetupView.vue';
import { authState } from './auth-state';

// Login e cadastro entram no bundle inicial; as outras telas só baixam depois de entrar.
const EnvironmentFormView = () => import('./views/EnvironmentFormView.vue');

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView },
    // Só abre enquanto não existe nenhum usuário: cadastra o primeiro Master.
    { path: '/configurar', name: 'setup', component: SetupView },
    { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
    { path: '/promotions/new', name: 'new-promotion', component: () => import('./views/NewPromotionView.vue') },
    { path: '/conectores/monday/:boardId?', name: 'monday', component: () => import('./views/MondayView.vue'), props: true },
    { path: '/recorrencias', name: 'recorrencias', component: () => import('./views/RecurrenciasView.vue') },
    { path: '/configuracoes/aprendizado', name: 'aprendizado', component: () => import('./views/LearningView.vue') },
    { path: '/logs', name: 'logs', component: () => import('./views/LogsView.vue') },
    { path: '/configuracoes/usuarios', name: 'usuarios', component: () => import('./views/UsersView.vue'), meta: { masterOnly: true } },
    { path: '/configuracoes/demo', name: 'demo', component: () => import('./views/DemoAccountsView.vue'), meta: { masterOnly: true } },
    ...(import.meta.env.MODE === 'demo'
      ? [
          { path: '/meus-dados', name: 'meus-dados', component: () => import('./demo/MyAccountView.vue') },
          // Pública: é o link de política de privacidade cadastrado no Google.
          { path: '/privacidade', name: 'privacidade', component: () => import('./demo/PrivacyView.vue'), meta: { public: true } },
        ]
      : []),
    { path: '/promotions/:id', redirect: (to) => `/promotions/${to.params.id}/${authState.role === 'master' ? 'dev' : 'homolog'}` },
    // `meta.viewKey` remonta a view ao entrar/sair de Dev; Homolog/Produção reaproveitam a instância.
    ...(['dev', 'homolog', 'producao'] as const).map((env) => ({
      path: `/promotions/:id/${env}`,
      name: env,
      component: EnvironmentFormView,
      props: (route: RouteLocationNormalized) => ({ id: route.params.id, env }),
      meta: { viewKey: env === 'dev' ? 'dev' : 'env' },
    })),
  ],
});

router.beforeEach((to) => {
  if (to.meta.public) return true;
  if (!authState.configured) return to.name === 'setup' ? true : { name: 'setup' };
  if (to.name === 'setup') return { name: 'login' };
  if (to.name === 'login') {
    if (authState.authenticated) return { name: 'home' };
    return true;
  }
  if (!authState.authenticated) return { name: 'login' };
  if (to.meta.masterOnly && authState.role !== 'master') return { name: 'home' };
  return true;
});
