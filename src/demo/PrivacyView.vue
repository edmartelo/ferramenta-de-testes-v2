<script setup lang="ts">
import PrivacyPolicy from './PrivacyPolicy.vue';

/** Página pública da demo, sem login: é o link de política de privacidade cadastrado no Google. */
</script>

<template>
  <div class="privacy-page">
    <article class="card privacy-card">
      <span class="eyebrow">Ferramenta de Testes · Demonstração</span>
      <h1>Política de privacidade</h1>
      <PrivacyPolicy />
      <router-link to="/login" class="back-link">Voltar para o login</router-link>
    </article>
  </div>
</template>

<style scoped>
.privacy-page {
  padding: 32px 16px;
  display: flex;
  justify-content: center;
}

.privacy-card {
  width: 100%;
  max-width: 720px;
}

.back-link {
  display: inline-block;
  margin-top: 24px;
  color: var(--accent-orange);
  text-decoration: none;
}

.back-link:hover {
  text-decoration: underline;
}
</style>
