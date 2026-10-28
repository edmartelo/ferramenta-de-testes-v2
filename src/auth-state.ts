import { reactive } from 'vue';
import { api, type UserRole } from './api';

/** `configured` = já existe algum usuário; sem nenhum, o login vira cadastro do primeiro Master. */
export const authState = reactive({ configured: true, authenticated: false, id: '', name: '', role: undefined as UserRole | undefined });

export async function loadAuthState(): Promise<void> {
  const status = await api.authStatus();
  authState.configured = status.configured;
  authState.authenticated = status.authenticated;
  authState.id = status.id ?? '';
  authState.name = status.name ?? '';
  authState.role = status.role;
}

export function clearAuthState(): void {
  Object.assign(authState, { authenticated: false, id: '', name: '', role: undefined });
}
