import { ref } from 'vue';
import { useAsyncAction } from './useAsyncAction';

export function useEditableSave(initialEditing = true) {
  const isEditing = ref(initialEditing);
  const justSaved = ref(false);
  const { pending: saving, error, run } = useAsyncAction();
  let justSavedTimeout: ReturnType<typeof setTimeout> | undefined;

  function edit(): void {
    isEditing.value = true;
    clearTimeout(justSavedTimeout);
    justSaved.value = false;
  }

  function save(action: () => Promise<unknown>): Promise<boolean> {
    return run(async () => {
      await action();
      isEditing.value = false;
      justSaved.value = true;
      clearTimeout(justSavedTimeout);
      justSavedTimeout = setTimeout(() => { justSaved.value = false; }, 1400);
    });
  }

  return { isEditing, justSaved, saving, error, edit, save };
}
