import { ref } from 'vue';

/** Com chave salva `action(undefined)` roda direto; sem ela abre o modal. `action` fecha via `closeTotp`. */
export function useTotpGate() {
  const totpModalOpen = ref(false);
  let pending: ((code: string | undefined) => unknown) | undefined;

  async function requestTotp(hasSecret: boolean, action: (code: string | undefined) => unknown): Promise<void> {
    pending = action;
    if (hasSecret) {
      await action(undefined);
      return;
    }
    totpModalOpen.value = true;
  }

  async function confirmTotp(code: string): Promise<void> {
    await pending?.(code);
  }

  function closeTotp(): void {
    totpModalOpen.value = false;
  }

  return { totpModalOpen, requestTotp, confirmTotp, closeTotp };
}
