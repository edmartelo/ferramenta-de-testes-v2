import { ref } from 'vue';
import { errorMessage } from './utils';

/** `run` resolve `true` só se `action` não lançou; o erro vira `error`. */
export function useAsyncAction() {
  const pending = ref(false);
  const error = ref('');

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    pending.value = true;
    error.value = '';
    try {
      await action();
      return true;
    } catch (e) {
      error.value = errorMessage(e);
      return false;
    } finally {
      pending.value = false;
    }
  }

  return { pending, error, run };
}
