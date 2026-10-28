<script setup lang="ts">
import { onMounted, ref } from 'vue';
import ConfirmModal from '../components/ConfirmModal.vue';
import PasswordField from '../components/PasswordField.vue';
import { api, type UserRole, type UserSummary } from '../api';
import { authState } from '../auth-state';
import { useAsyncAction } from '../composables/useAsyncAction';

const ROLE_LABELS: Record<UserRole, string> = { master: 'Master', tester: 'Tester' };

const users = ref<UserSummary[]>([]);
const email = ref('');
const password = ref('');
const passwordConfirm = ref('');
const role = ref<UserRole>('tester');
const created = ref('');
const userToDelete = ref<UserSummary>();
const { error: loadError, run: runLoad } = useAsyncAction();
const { pending: creating, error: createError, run: runCreate } = useAsyncAction();
const { pending: deleting, error: deleteError, run: runDelete } = useAsyncAction();

onMounted(() => runLoad(async () => {
  users.value = await api.listUsers();
}));

async function createUser() {
  created.value = '';
  if (password.value !== passwordConfirm.value) {
    createError.value = 'As senhas não conferem.';
    return;
  }
  const newEmail = email.value.trim();
  const ok = await runCreate(async () => {
    users.value = await api.createUser({ email: newEmail, password: password.value, role: role.value });
  });
  if (!ok) return;
  created.value = `${newEmail} cadastrado. Passe a senha provisória por um canal seguro: no primeiro login ele cria a própria senha e o autenticador.`;
  email.value = '';
  password.value = '';
  passwordConfirm.value = '';
  role.value = 'tester';
}

async function confirmDelete() {
  const target = userToDelete.value;
  if (!target || deleting.value) return;
  const ok = await runDelete(async () => {
    users.value = await api.deleteUser(target.id);
  });
  if (ok) userToDelete.value = undefined;
}
</script>

<template>
  <div>
    <span class="eyebrow">Configurações</span>
    <h1>Usuários</h1>
    <p>
      Master cria e exclui usuários; Tester vê todo o resto. O novo usuário entra com o e-mail e a senha provisória daqui e,
      no primeiro login, cria a própria senha e cadastra o autenticador.
    </p>

    <div class="card users-card">
      <h3>Novo usuário</h3>
      <form @submit.prevent="createUser">
        <div class="field">
          <label for="user-email">E-mail</label>
          <input id="user-email" v-model="email" type="email" required autocomplete="off" />
        </div>
        <div class="field">
          <label for="user-password">Senha provisória</label>
          <PasswordField id="user-password" v-model="password" required minlength="8" autocomplete="new-password" />
        </div>
        <div class="field">
          <label for="user-password-confirm">Confirmar senha</label>
          <PasswordField id="user-password-confirm" v-model="passwordConfirm" required minlength="8" autocomplete="new-password" />
        </div>
        <div class="field">
          <label for="user-role">Nível</label>
          <select id="user-role" v-model="role">
            <option value="tester">Tester</option>
            <option value="master">Master</option>
          </select>
        </div>
        <p v-if="createError" class="error">{{ createError }}</p>
        <p v-if="created" class="hint">{{ created }}</p>
        <button type="submit" class="primary" :disabled="creating">{{ creating ? 'Cadastrando...' : 'Cadastrar' }}</button>
      </form>
    </div>

    <div class="card users-card">
      <h3>Cadastrados</h3>
      <p v-if="loadError" class="error">{{ loadError }}</p>
      <div v-else class="table-scroll">
        <table class="users-table">
          <thead>
            <tr>
              <th>E-mail</th>
              <th>Nível</th>
              <th>Situação</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id">
              <td>{{ user.email }}</td>
              <td>{{ ROLE_LABELS[user.role] }}</td>
              <td>{{ user.expired ? 'Senha provisória vencida: exclua e cadastre de novo' : user.pending ? 'Aguardando primeiro acesso' : 'Ativo' }}</td>
              <td class="actions">
                <span v-if="user.id === authState.id" class="hint">Você</span>
                <button v-else type="button" class="danger" @click="deleteError = ''; userToDelete = user">Excluir</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <ConfirmModal
      :open="Boolean(userToDelete)"
      title="Excluir usuário?"
      :description="`${userToDelete?.email} perde o acesso à ferramenta. Não tem como desfazer.`"
      :confirm-label="deleting ? 'Excluindo...' : 'Excluir'"
      cancel-label="Cancelar"
      variant="danger"
      :pending="deleting"
      :error="deleteError"
      @confirm="confirmDelete"
      @cancel="userToDelete = undefined"
    />
  </div>
</template>

<style scoped>
.users-card {
  margin-top: 20px;
  max-width: 640px;
}

.users-table {
  width: 100%;
  border-collapse: collapse;
}

.users-table th,
.users-table td {
  padding: 6px 12px 6px 0;
  text-align: left;
}

.users-table .actions {
  text-align: right;
}

.error {
  color: var(--danger);
}

.hint {
  color: var(--text-secondary);
}
</style>
