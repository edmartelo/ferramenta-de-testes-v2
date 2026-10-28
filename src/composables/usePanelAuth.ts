import { computed, ref, watch, type Ref } from 'vue';
import { api } from '../api';
import { useTotpGate } from './useTotpGate';
import { errorMessage } from './utils';

interface AuthStore {
  authenticating: Ref<boolean>;
  authError: Ref<string>;
  abortController: AbortController | undefined;
}

/** Por "promoção:ambiente": sobrevive à troca de aba durante a autenticação. */
const stores = new Map<string, AuthStore>();

function getStore(key: string): AuthStore {
  let store = stores.get(key);
  if (!store) {
    store = { authenticating: ref(false), authError: ref(''), abortController: undefined };
    stores.set(key, store);
  }
  return store;
}

export function usePanelAuth(promotionId: () => string, env: () => 'dev' | 'homolog' | 'producao') {
  const store = computed(() => getStore(`${promotionId()}:${env()}`));

  const authenticating = computed(() => store.value.authenticating.value);
  const authError = computed(() => store.value.authError.value);

  async function authenticate(totpCode: string | undefined, onSuccess: () => void): Promise<void> {
    const target = store.value;
    target.authenticating.value = true;
    target.authError.value = '';
    const controller = new AbortController();
    target.abortController = controller;
    try {
      const result = await api.authenticatePanel(promotionId(), env(), totpCode, controller.signal);
      if (result.success) {
        onSuccess();
      } else {
        target.authError.value = result.error ?? 'Não foi possível autenticar no painel.';
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        target.authError.value = errorMessage(e);
      }
    } finally {
      target.authenticating.value = false;
      target.abortController = undefined;
    }
  }

  function cancelAuthenticate(): void {
    store.value.abortController?.abort();
  }

  return { authenticating, authError, authenticate, cancelAuthenticate };
}

type Env = 'dev' | 'homolog' | 'producao';

interface RunGateOptions {
  panelSessionSaved: Ref<boolean>;
  canAuthenticatePanel: () => boolean;
  hasTotpSecret: () => boolean;
  runTests: (headed: boolean, group?: string) => unknown;
}

export function useRunWithPanelAuth(promotionId: () => string, env: () => Env, options: RunGateOptions) {
  const { authenticating, authError, authenticate, cancelAuthenticate } = usePanelAuth(promotionId, env);
  const { totpModalOpen, requestTotp, confirmTotp, closeTotp } = useTotpGate();

  const currentKey = () => `${promotionId()}:${env()}`;

  watch(currentKey, closeTotp);

  function handleRun(headed: boolean, group?: string): void {
    if (options.panelSessionSaved.value || !options.canAuthenticatePanel()) {
      options.runTests(headed, group);
      return;
    }
    const startKey = currentKey();
    requestTotp(options.hasTotpSecret(), (code) =>
      authenticate(code, () => {
        if (currentKey() !== startKey) return;
        options.panelSessionSaved.value = true;
        closeTotp();
        options.runTests(headed, group);
      }),
    );
  }

  function onTotpCancel(): void {
    cancelAuthenticate();
    closeTotp();
  }

  return { authenticating, authError, totpModalOpen, handleRun, onTotpConfirm: confirmTotp, onTotpCancel };
}
