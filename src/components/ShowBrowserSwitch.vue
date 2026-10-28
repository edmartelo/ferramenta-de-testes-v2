<script setup lang="ts">
defineProps<{ disabled?: boolean }>();
const showBrowser = defineModel<boolean>({ default: false });
</script>

<template>
  <label class="run-group switch">
    <span class="switch-caption">Mostrar navegador</span>
    <input type="checkbox" v-model="showBrowser" :disabled="disabled" />
    <span class="switch-track"><span class="switch-thumb"></span></span>
  </label>
</template>
