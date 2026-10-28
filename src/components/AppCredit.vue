<template>
  <p class="app-credit">
    Desenvolvido por
    <a href="https://github.com/edmartelo" target="_blank" rel="noopener noreferrer">edmartelo<span class="visually-hidden"> (abre em nova aba)</span></a>
    <br>
    <a href="https://github.com/edmartelo/ferramenta-de-testes-v2" target="_blank" rel="noopener noreferrer">Acesse o repositório<span class="visually-hidden"> (abre em nova aba)</span></a>
  </p>
</template>

<style scoped>
.app-credit {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  text-align: center;
  overflow-wrap: anywhere;
}

.app-credit a {
  color: var(--accent-orange);
  text-decoration: none;
  border-radius: 4px;
  white-space: nowrap;
}

.app-credit a:hover {
  text-decoration: underline;
}

.app-credit a:focus-visible {
  outline: 2px solid var(--accent-orange);
  outline-offset: 2px;
}
</style>
