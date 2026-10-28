<script setup lang="ts">
/** Texto da política de privacidade da demo: página pública `/privacidade` e modal do login/cadastro. */
const CONTACT_EMAIL = 'smarteloedu@gmail.com';
const UPDATED_AT = '27/10/2026';
</script>

<template>
  <div class="privacy-policy">
    <p class="hint">Atualizada em {{ UPDATED_AT }}.</p>

    <p>
      Esta política vale para a versão de demonstração da Ferramenta de Testes. Tudo o que aparece dentro da demonstração (promoções, testes,
      atendimentos, logs) é fictício; os únicos dados reais são os da sua conta, descritos abaixo.
    </p>

    <h2>Dados que guardamos</h2>
    <ul>
      <li><strong>Cadastro:</strong> nome, e-mail e empresa (opcional), e a data do aceite deste aviso.</li>
      <li><strong>Senha:</strong> guardada só como hash; ninguém consegue lê-la. Contas criadas pelo Google não têm senha, a menos que você crie uma em Meus dados.</li>
      <li><strong>App autenticador:</strong> se você ativar, a chave fica cifrada no banco.</li>
      <li><strong>Acesso:</strong> data do último acesso, quantidade de logins e tentativas com senha errada.</li>
      <li><strong>Uso da demonstração:</strong> telas visitadas e ações feitas lá dentro, com data e hora.</li>
      <li><strong>Segurança:</strong> um código derivado do IP de cadastro, que não permite recuperar o IP, usado só para limitar cadastros em massa.</li>
    </ul>

    <h2>Login com o Google</h2>
    <p>
      Ao usar "Continuar com o Google", o Google nos envia apenas seu nome e e-mail, confirmados por ele. Não temos acesso à sua senha do Google,
      a contatos, arquivos ou qualquer outro dado da sua conta Google.
    </p>

    <h2>Para que usamos</h2>
    <ul>
      <li>Dar acesso à demonstração e manter sua conta segura.</li>
      <li>Contato comercial sobre a ferramenta.</li>
      <li>Métricas de uso, para entender o que interessa a quem conhece a ferramenta.</li>
    </ul>
    <p>Não vendemos nem compartilhamos seus dados para publicidade.</p>

    <h2>Serviços de terceiros</h2>
    <ul>
      <li><strong>Vercel:</strong> hospedagem da demonstração.</li>
      <li><strong>Aiven:</strong> banco de dados onde a conta fica guardada.</li>
      <li><strong>Cloudflare Turnstile:</strong> verificação contra robôs no cadastro e no login, que analisa dados técnicos do navegador.</li>
      <li><strong>Google:</strong> só quando você escolhe entrar com o Google.</li>
    </ul>

    <h2>Cookies</h2>
    <p>
      Usamos um único cookie próprio, de sessão, que mantém você conectado por até 8 horas. A Cloudflare e o Google podem usar cookies próprios
      para a verificação contra robôs e para o login.
    </p>

    <h2>Por quanto tempo</h2>
    <p>
      Os dados da conta e o histórico de telas e ações ficam guardados enquanto ela existir. Quando a conta é excluída, tudo isso é apagado; fica
      apenas um registro anônimo, sem nome, e-mail ou empresa, de que uma conta foi excluída.
    </p>

    <h2>Seus direitos</h2>
    <p>
      Pela LGPD, você pode pedir acesso, correção ou exclusão dos seus dados e revogar o consentimento a qualquer momento. Nome, e-mail, empresa,
      senha e autenticador podem ser alterados em Meus dados, onde também é possível excluir a conta. Para o resto, escreva para
      <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>.
    </p>
  </div>
</template>

<style scoped>
.privacy-policy {
  line-height: 1.6;
}

.privacy-policy h2 {
  margin-top: 24px;
  font-size: 18px;
}

.privacy-policy ul {
  padding-left: 20px;
}

.privacy-policy li + li {
  margin-top: 6px;
}

.privacy-policy a {
  color: var(--accent-orange);
  text-decoration: none;
}

.privacy-policy a:hover {
  text-decoration: underline;
}
</style>
