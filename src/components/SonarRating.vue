<script setup lang="ts">
import type { SonarRating } from '../lib/sonar-types';

defineProps<{ rating: SonarRating | null; label: string; small?: boolean }>();
</script>

<template>
  <span v-if="rating" class="sonar-rating" :class="[`sonar-rating-${rating.toLowerCase()}`, { small }]" role="img" :aria-label="`${label}: nota ${rating}`" :title="`${label}: nota ${rating}`">
    {{ rating }}
  </span>
  <span v-else class="sonar-rating sonar-rating-none" :class="{ small }" role="img" :aria-label="`${label}: sem nota`" title="Sem nota">–</span>
</template>

<style scoped>
.sonar-rating {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  font-weight: 700;
  font-size: 16px;
  color: var(--sonar-on);
  box-shadow: inset 0 0 0 1px var(--sonar-ring);
}

.sonar-rating.small {
  width: 22px;
  height: 22px;
  font-size: 12px;
}

.sonar-rating-a {
  background: var(--sonar-a);
}

.sonar-rating-b {
  background: var(--sonar-b);
}

.sonar-rating-c {
  background: var(--sonar-c);
}

.sonar-rating-d {
  background: var(--sonar-d);
}

.sonar-rating-e {
  background: var(--sonar-e);
}

.sonar-rating-none {
  background: var(--surface-hover);
  color: var(--text-secondary);
}
</style>
