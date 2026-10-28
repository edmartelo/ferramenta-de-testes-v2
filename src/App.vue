<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import Sidebar from './components/Sidebar.vue';
import TopBar from './components/TopBar.vue';

const route = useRoute();
// Antes da primeira navegação (`matched` vazio) não mostra menu: senão a página pública pisca o painel.
const isAuthPage = computed(() => route.matched.length === 0 || route.name === 'login' || route.name === 'setup' || Boolean(route.meta.public));
// Sair pro login esvazia o cache: a tela de recorrências guarda dados de participantes.
const keptAliveViews = computed(() => (isAuthPage.value ? [] : ['RecurrenciasView']));
const sidebarOpen = ref(false);
const isDemo = import.meta.env.MODE === 'demo';
watch(() => route.fullPath, () => (sidebarOpen.value = false));
</script>

<template>
  <div class="app-shell">
    <div v-if="isDemo" class="demo-banner" role="status">Modo demonstração — dados fictícios</div>
    <TopBar v-if="!isAuthPage" :sidebar-open="sidebarOpen" @toggle-sidebar="sidebarOpen = !sidebarOpen" />
    <div class="layout">
      <Sidebar v-if="!isAuthPage" :open="sidebarOpen" @close="sidebarOpen = false" />
      <main class="content themed-scrollbar" :class="{ 'content-full': isAuthPage }">
        <router-view v-slot="{ Component, route: viewRoute }">
          <transition name="fade" mode="out-in">
            <keep-alive :include="keptAliveViews">
              <component :is="Component" :key="(viewRoute.meta.viewKey as string | undefined)" />
            </keep-alive>
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
}

.demo-banner {
  padding: 6px 16px;
  background: var(--accent-orange-soft);
  color: var(--accent-orange);
  font-size: 13px;
  font-weight: 600;
  text-align: center;
}

.layout {
  display: flex;
  flex: 1;
  min-height: 0;
}

.content.content-full {
  padding: 0;
}

.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 32px 40px;
  --scrollbar-track: var(--bg);
  --scrollbar-track-radius: 0;
}

@media (max-width: 900px) {
  .layout {
    position: relative;
  }

  .content {
    padding: 20px 16px;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
