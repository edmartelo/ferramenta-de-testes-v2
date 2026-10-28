import { ref } from 'vue';
import { api, type MondayUser } from '../api';

const users = ref<MondayUser[]>([]);
let loading: Promise<void> | undefined;

export function useMondayUsers() {
  function ensureUsersLoaded(): Promise<void> {
    loading ??= api.mondayUsers().then(
      (list) => { users.value = list; },
      (e) => { loading = undefined; throw e; },
    );
    return loading;
  }

  return { users, ensureUsersLoaded };
}
