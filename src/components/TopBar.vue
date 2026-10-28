<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { authState, clearAuthState } from '../auth-state';
import { useAsyncAction } from '../composables/useAsyncAction';
import NavIcon from './NavIcon.vue';

defineProps<{ sidebarOpen: boolean }>();
defineEmits<{ 'toggle-sidebar': [] }>();

const router = useRouter();
const isDemo = import.meta.env.MODE === 'demo';
const userMenuOpen = ref(false);
const userMenuRoot = ref<HTMLElement | null>(null);

function toggleUserMenu() {
  userMenuOpen.value = !userMenuOpen.value;
}

function onDocumentClick(event: MouseEvent) {
  if (userMenuRoot.value && !userMenuRoot.value.contains(event.target as Node)) userMenuOpen.value = false;
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') userMenuOpen.value = false;
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onDocumentKeydown);
});

const theme = ref(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme.value;
  try {
    localStorage.setItem('theme', theme.value);
  } catch {}
}

const { pending: loggingOut, error: logoutError, run } = useAsyncAction();

function openMyAccount() {
  userMenuOpen.value = false;
  router.push({ name: 'meus-dados' });
}

function logout() {
  return run(async () => {
    await api.authLogout();
    clearAuthState();
    router.push('/login');
  });
}
</script>

<template>
  <header class="topbar">
    <div class="topbar-actions">
      <button
        type="button"
        class="ghost menu-toggle"
        :aria-label="sidebarOpen ? 'Fechar menu' : 'Abrir menu'"
        :aria-expanded="sidebarOpen"
        @click="$emit('toggle-sidebar')"
      >
        <NavIcon :name="sidebarOpen ? 'close' : 'menu'" />
      </button>
      <template v-if="authState.authenticated">
        <span class="topbar-title">Ferramenta de testes</span>
      </template>
    </div>
    <div class="topbar-right">
      <button
        type="button"
        class="ghost theme-toggle"
        :aria-label="theme === 'light' ? 'Usar tema escuro' : 'Usar tema claro'"
        :title="theme === 'light' ? 'Tema escuro' : 'Tema claro'"
        @click="toggleTheme"
      >
        <NavIcon :name="theme === 'light' ? 'moon' : 'sun'" />
      </button>
      <div v-if="authState.name" class="user-menu" ref="userMenuRoot">
        <button
          type="button"
          class="ghost topbar-user"
          :class="{ open: userMenuOpen }"
          aria-haspopup="menu"
          :aria-expanded="userMenuOpen"
          @click="toggleUserMenu"
        >
          <NavIcon name="user" />
          <span class="topbar-name">{{ authState.name }}</span>
          <NavIcon name="chevron" class="topbar-chevron" />
        </button>
        <div v-if="userMenuOpen" class="dropdown" role="menu">
          <button v-if="isDemo" type="button" class="dropdown-item neutral" role="menuitem" @click="openMyAccount">
            <NavIcon name="user" />
            Meus dados
          </button>
          <button type="button" class="dropdown-item" role="menuitem" :disabled="loggingOut" @click="logout">
            <NavIcon name="logout" />
            {{ loggingOut ? 'Saindo...' : 'Sair' }}
          </button>
          <p v-if="logoutError" class="dropdown-item" style="color: var(--danger)">{{ logoutError }}</p>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  height: 52px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  gap: 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.menu-toggle {
  display: none;
  padding: 8px;
}

.menu-toggle .nav-icon {
  display: block;
  width: 20px;
  height: 20px;
  color: var(--text-primary);
}

.topbar-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.theme-toggle {
  padding: 8px;
  color: var(--text-secondary);
}

.theme-toggle .nav-icon {
  display: block;
}

.user-menu {
  position: relative;
  min-width: 0;
}

.topbar-user {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 13px;
}

.topbar-chevron {
  transition: transform 0.2s ease;
}

.topbar-user.open .topbar-chevron {
  transform: rotate(180deg);
}

.dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 100%;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}

.dropdown-item {
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  white-space: nowrap;
  padding: 8px 10px;
  border-radius: 6px;
}

.dropdown-item:hover {
  background: var(--surface-hover);
}

.dropdown-item:hover .nav-icon {
  color: var(--danger);
}

.dropdown-item.neutral:hover .nav-icon {
  color: var(--accent-green);
}

@media (max-width: 900px) {
  .topbar {
    padding: 0 12px;
  }

  .menu-toggle {
    display: block;
  }

  .topbar-user {
    max-width: 50vw;
    padding: 8px 10px;
  }
}

@media (max-width: 400px) {
  .topbar-title {
    display: none;
  }
}
</style>
