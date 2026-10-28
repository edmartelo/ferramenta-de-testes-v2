import { createApp } from 'vue';
import App from './App.vue';
import { onSessionExpired } from './api';
import { router } from './router';
import { authState, clearAuthState, loadAuthState } from './auth-state';
import './styles/theme.css';

onSessionExpired(() => {
  if (!authState.authenticated) return;
  clearAuthState();
  if (router.currentRoute.value.name !== 'login') router.push('/login');
});

loadAuthState().finally(() => {
  createApp(App).use(router).mount('#app');
});
