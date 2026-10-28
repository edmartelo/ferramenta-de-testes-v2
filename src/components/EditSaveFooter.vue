<script setup lang="ts">
defineProps<{ justSaved: boolean; isEditing: boolean; saving: boolean }>();
const emit = defineEmits<{ edit: [] }>();
</script>

<template>
  <div class="card-footer">
    <button v-if="justSaved" type="button" class="success" disabled>✓ Salvo</button>
    <button v-else-if="isEditing" type="submit" class="primary" :disabled="saving">
      {{ saving ? 'Salvando...' : 'Salvar' }}
    </button>
    <button v-else type="button" class="ghost" @click="emit('edit')">Editar</button>

    <slot />
  </div>
</template>
