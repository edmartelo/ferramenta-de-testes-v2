# 🧪 Ferramenta de Testes — QA Automation Platform

**Uma plataforma de QA para automatizar testes de promoções, validar jornadas de usuários e monitorar operações em produção.**

Centralize cenários de teste, execute automações de navegador, acompanhe resultados e mantenha um histórico organizado das validações em uma única interface.

[🚀 Acessar demonstração](https://ferramenta-de-testes-demo.vercel.app) · [📦 Repositório](https://github.com/edmartelo/ferramenta-de-testes-v2)

> **Experimente a demonstração:** crie uma conta e explore a plataforma com dados fictícios.

<!-- Tech badges -->
<p align="left">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22" />
  <img src="https://img.shields.io/badge/Vue.js-3-4FC08D?logo=vuedotjs&logoColor=white" alt="Vue 3" />
  <img src="https://img.shields.io/badge/Vite-Frontend%20%2B%20API-646CFF?logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Playwright-Test%20Automation-2EAD33?logo=playwright&logoColor=white" alt="Playwright" />
  <img src="https://img.shields.io/badge/MySQL-8.0-4479A1?logo=mysql&logoColor=white" alt="MySQL 8" />
</p>

<p align="left">
  <img src="https://img.shields.io/badge/QA-Automation-blue?logo=checkmarx&logoColor=white" alt="QA Automation" />
  <img src="https://img.shields.io/badge/E2E-Browser%20Testing-2EAD33?logo=playwright&logoColor=white" alt="End-to-end testing" />
  <img src="https://img.shields.io/badge/AI-Ollama-black?logo=ollama&logoColor=white" alt="Ollama local AI" />
  <img src="https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?logo=githubactions&logoColor=white" alt="GitHub Actions" />
</p>

---

## 📌 Sobre o projeto

A **Ferramenta de Testes** é uma plataforma de Quality Assurance (QA) voltada para sites de promoção, sistemas de cadastro, bots de WhatsApp e painéis administrativos.

Ela permite cadastrar promoções e seus respectivos ambientes, executar testes automatizados de navegador, registrar os resultados de cada rodada e acompanhar atividades de produção por meio de rotinas de monitoramento.

Além da automação, a plataforma combina **testes automatizados, conferência manual, rastreabilidade e análise assistida por IA local**, oferecendo uma visão integrada do processo de validação.

### 🎯 O que você pode fazer?

- 🧪 Executar testes automatizados de fluxos web.
- 🌐 Organizar ambientes de desenvolvimento, homologação e produção.
- 📊 Acompanhar o progresso e consultar o histórico das execuções.
- 🔎 Revisar manualmente cenários que não podem ser automatizados.
- 🔐 Gerenciar usuários, autenticação e permissões.
- 🔄 Monitorar promoções ativas e recorrências.
- 🤖 Classificar atendimentos com um modelo de IA executado localmente.
- 📣 Enviar resumos operacionais para WhatsApp e Slack.

---

## ✨ Funcionalidades

### 🧪 Automação de testes

- Cadastro e organização de promoções por ambiente.
- Execução de testes de cadastro de participantes.
- Validação do cadastro de cupons.
- Testes da área **Meus Dados**.
- Cadastro em massa.
- Execução de testes de navegador com Playwright.
- Suporte a cenários em navegadores desktop e mobile.
- Progresso das execuções e histórico das rodadas.
- Revisão manual para situações que não podem ser validadas automaticamente.

### 📋 Gestão de QA

- Cadastro de regras e mecânicas das promoções.
- Organização dos cenários por grupos de teste.
- Registro dos resultados de cada rodada.
- Conferência manual dos resultados.
- Logs das execuções para facilitar a investigação de problemas.
- Separação dos perfis Master e Tester.

### 🔄 Recorrências e monitoramento

- Varredura somente leitura das promoções ativas em produção.
- Agendamento de verificações recorrentes.
- Geração de resumos operacionais.
- Envio de notificações por WhatsApp ou Slack, conforme a configuração.

### 🤖 Análise de atendimentos com IA local

- Leitura dos atendimentos do painel integrado.
- Resumo e classificação por gravidade.
- Uso opcional do Ollama para processamento local.
- Aprendizado baseado nas correções realizadas pelo usuário.

O processamento local foi adotado para reduzir o envio de dados de participantes a provedores externos de LLM. Isso não substitui a avaliação dos controles de segurança e privacidade do ambiente em que a aplicação é executada.

### 🔐 Segurança e controle de acesso

- Autenticação por senha.
- Suporte a aplicativo autenticador TOTP.
- Perfis Master e Tester.
- Criptografia dos segredos do autenticador com AES-256-GCM.
- Mascaramento de dados pessoais antes do armazenamento no banco.
- Proteção das operações de leitura em produção.
- Configuração isolada para a demonstração pública.

---

## 🛠️ Stack tecnológica

| Tecnologia | Utilização |
|---|---|
| 🟦 TypeScript | Tipagem e organização do código |
| 🟢 Node.js 22 | Ambiente de execução |
| 🖼️ Vue 3 | Interface da aplicação |
| ⚡ Vite | Desenvolvimento, frontend e API integrada |
| 🎭 Playwright | Automação de navegador e testes |
| 🐬 MySQL 8 | Persistência de dados e histórico |
| 🦙 Ollama | Inferência local para análise de atendimentos |
| 🧠 Qwen3 14B | Modelo de linguagem para classificação e resumos |
| 🔎 nomic-embed-text | Modelo de embeddings |
| ✅ Playwright Test | Execução dos testes automatizados da suíte |
| 🔁 GitHub Actions | Integração contínua para verificações de tipos e testes unitários |

**Arquitetura:** a API é integrada ao servidor de desenvolvimento do Vite, dentro de `server/`, sem a necessidade de manter um backend separado para esse fluxo.

---

## 🚀 Demonstração online

**[Acessar a demonstração pública](https://ferramenta-de-testes-demo.vercel.app)**

A demonstração permite conhecer a interface e explorar as funcionalidades utilizando dados fictícios.

O modo demo possui uma camada de dados própria, separada da aplicação operacional, e utiliza um banco específico para cadastro, autenticação e histórico de uso.

Recursos opcionais de proteção contra bots e login social podem ser habilitados por configuração.

> **Importante:** a demonstração é destinada à exploração da plataforma. Utilize dados fictícios e não insira credenciais, informações pessoais ou dados de produção.

---

## 💻 Instalação local

### Pré-requisitos

- [Node.js 22](https://nodejs.org/)
- [MySQL 8](https://dev.mysql.com/downloads/mysql/) acessível localmente ou por um serviço gerenciado.
- Git
- Navegadores necessários para o Playwright.

### 1. Clone o repositório

```bash
git clone https://github.com/edmartelo/ferramenta-de-testes-v2.git

cd ferramenta-de-testes-v2
```

### 2. Configure as variáveis de ambiente

```bash
cp .env.example .env
```

Edite o arquivo `.env` e configure, no mínimo, as credenciais de conexão com o banco (`SHARED_DB_*`) e a chave `TOTP_ENCRYPTION_KEY`.

**Não compartilhe o arquivo `.env` nem publique suas credenciais no GitHub.**

### 3. Instale as dependências

```bash
npm install
```

### 4. Instale os navegadores do Playwright

```bash
npx playwright install
```

### 5. Inicie a aplicação

```bash
npm run dev
```

A aplicação estará disponível em:

**http://localhost:15173**

### 👤 Primeiro acesso

As tabelas são criadas automaticamente. Quando ainda não existe nenhum usuário, a primeira tela permite cadastrar o usuário inicial com perfil **Master**.

Após essa etapa, somente um Master pode criar usuários pela seção **Configurações → Usuários**.

---

## 🧩 Conectores e integrações

A plataforma pode integrar serviços externos para armazenamento, monitoramento e comunicação.

| Serviço | Finalidade | Obrigatório |
|---|---|:---:|
| 🐬 MySQL 8 / Aiven | Usuários, promoções, execuções e logs | Sim |
| 🎭 Playwright | Execução dos testes de navegador | Sim |
| 🦙 Ollama | Análise de atendimentos com IA local | Não |
| 💬 WhatsApp MCP | Envio de resumos de recorrências | Não |
| 💼 Slack | Envio de resumos para canais | Não |
| 📋 Monday.com | Criação de itens e atualizações em quadros | Não |
| 🔎 Monitor de Promoções | Fonte dos dados de recorrências e atendimentos | Não |
| ☁️ Aiven API | Gerenciamento do serviço de banco para recorrências agendadas | Não |

### Configuração dos conectores

**MySQL / Aiven**
- Configure as variáveis `SHARED_DB_*`.
- Para conexões SSL, utilize `SHARED_DB_SSL_CA` quando necessário.
- Configure `TOTP_ENCRYPTION_KEY`.

**Ollama**
- Instale o [Ollama](https://ollama.com/).
- Baixe os modelos utilizados pela aplicação:

```bash
ollama pull qwen3:14b
ollama pull nomic-embed-text
```

Sem o Ollama, a classificação dos atendimentos pode recorrer a palavras-chave.

**WhatsApp MCP**
- Instale e configure o [WhatsApp MCP](https://whatsapp-mcp.brorlandi.xyz/).
- Mantenha o serviço aberto e pareado.
- Configure `WHATSAPP_RECIPIENT_JID`.

**Slack**
- Crie um aplicativo com OAuth no Slack.
- Configure `SLACK_CLIENT_ID` e `SLACK_CLIENT_SECRET`.
- Ajuste `SLACK_REDIRECT_URI` conforme os requisitos do ambiente.

**Monday.com**
- Crie um aplicativo OAuth no Monday.com.
- Configure `MONDAY_CLIENT_ID` e `MONDAY_CLIENT_SECRET`.

**Monitor de Promoções**
- Acesse **Configurações → Conectores**.
- Configure as credenciais e a chave do autenticador exigidas pela integração.

**Aiven API**
- Configure `AIVEN_API_TOKEN`, `AIVEN_PROJECT` e `AIVEN_SERVICE` quando utilizar a funcionalidade de gerenciamento do serviço de banco.

Os conectores OAuth e o Monitor de Promoções são configurados por usuário. Os tokens desses conectores ficam em arquivos locais, fora do banco de dados e do controle de versão.

---

## 🧪 Executando os testes

A plataforma utiliza Playwright para os testes de navegador e para os testes automatizados da suíte interna.

### Executar a suíte de uma promoção

```bash
PROMO=<id-da-promocao> npm test
```

Substitua `<id-da-promocao>` pelo identificador real da promoção.

### Executar um grupo específico

```bash
PROMO=<id-da-promocao> npm test -- --grep "3\."
```

O filtro seleciona os testes correspondentes ao padrão informado.

### Executar os testes unitários

```bash
npx playwright test tests/_lib/
```

### Verificar os tipos do Node.js

```bash
npx tsc --noEmit
```

### Verificar os tipos da interface e da API

```bash
npx vue-tsc --noEmit -p tsconfig.web.json
```

### 🔍 Como funcionam as execuções?

Pela interface, cada grupo de teste é executado em um processo do Playwright, em sequência.

Quando um campo necessário não existe no formulário da aplicação testada, o cenário pode ser encaminhado para **revisão manual**, em vez de ser tratado automaticamente como falha.

Essa abordagem ajuda a diferenciar problemas reais de validação de cenários que exigem intervenção humana.

---

## 🖥️ Modo demonstração local

O projeto oferece uma configuração específica para executar a versão demo em ambiente local.

O modo demo utiliza `src/demo/api.ts` para substituir a camada de dados operacional por dados fictícios. O acesso ao banco é restrito aos fluxos necessários de cadastro, autenticação e histórico de uso, utilizando o banco separado `ferramenta_demo` e um usuário com privilégios mínimos.

### Preparar a demonstração

```bash
npm run demo:setup
```

O comando cria o banco e o usuário da demo com as credenciais administrativas configuradas no `.env` e grava as configurações em `.env.demo`.

### Iniciar a demonstração

```bash
npm run dev:demo
```

A demonstração local estará disponível em:

**http://localhost:15174**

### Recursos opcionais

O arquivo `.env.demo` pode incluir:

- `DEMO_TURNSTILE_SITE_KEY`
- `DEMO_TURNSTILE_SECRET`
- `DEMO_GOOGLE_CLIENT_ID`

Essas variáveis habilitam, respectivamente, a integração opcional com o Cloudflare Turnstile e o login com Google, conforme a configuração da aplicação.

---

## 🛡️ Segurança e privacidade

Segurança é especialmente importante em ferramentas de QA que interagem com sistemas e ambientes de produção.

O projeto adota as seguintes medidas:

- 🔑 Credenciais, sessões e tokens ficam em arquivos locais ignorados pelo Git, como `.env`, `.credentials.json`, `.connectors.json` e `.env.demo`.
- 🔒 Segredos do autenticador são protegidos com AES-256-GCM.
- 🕵️ Dados pessoais são mascarados antes de serem armazenados no banco.
- 🧱 As operações de leitura em produção, utilizadas por Recorrências e Atendimentos, passam por uma proteção que bloqueia requisições de escrita além do login, implementada em `src/lib/read-only-guard.ts` e coberta por testes.
- 🧪 A configuração de demonstração utiliza dados fictícios e um banco separado.

**Boas práticas para colaboradores:**

1. Nunca envie arquivos `.env`, tokens, senhas ou credenciais para commits.
2. Utilize ambientes de teste e dados fictícios sempre que possível.
3. Não execute testes de escrita em produção sem autorização explícita.
4. Verifique o escopo das integrações antes de conectar serviços externos.
5. Revise as alterações de segurança e os testes correspondentes antes de abrir um pull request.

---

## 🤝 Contribua com o projeto

Contribuições são bem-vindas, especialmente de profissionais e estudantes interessados em:

- 🧪 QA e automação de testes.
- 🎭 Playwright e testes E2E.
- 🐛 Identificação e reprodução de bugs.
- 🔎 Estratégias de testes exploratórios e regressão.
- 📝 Documentação técnica.
- 🔐 Segurança de aplicações e validação de controles.
- ⚙️ Integração contínua e qualidade de código.
- 💡 Melhorias de usabilidade e experiência do usuário.

### Como contribuir

1. Faça um fork do repositório.
2. Crie uma branch para sua alteração.
3. Implemente a melhoria ou correção.
4. Execute os testes e as verificações de tipos relevantes.
5. Abra um pull request descrevendo o problema, a solução e os testes realizados.

Sugestão para nomear branches:

```bash
git checkout -b feat/minha-melhoria
```

Para correções:

```bash
git checkout -b fix/correcao-de-bug
```

Ao reportar um problema, inclua os passos para reproduzi-lo, o comportamento esperado, o comportamento observado e, quando possível, os logs relevantes sem credenciais ou dados pessoais.

---

## 🗺️ Próximos passos

A evolução do projeto pode ser acompanhada pelas Issues e Pull Requests do repositório.

Ideias de contribuição incluem:

- 📊 Melhorias na visualização dos resultados de teste.
- 🧪 Ampliação dos cenários automatizados.
- 📋 Relatórios mais detalhados de regressão.
- 🔍 Melhorias na rastreabilidade dos defeitos.
- ⚙️ Aprimoramento da integração contínua.
- 📚 Documentação de novos cenários e integrações.

Esses itens são sugestões de evolução, não uma declaração de funcionalidades já implementadas ou de um roadmap oficialmente definido.

---

## 📄 Licença

Distribuído sob a licença [MIT](LICENSE): você pode usar, copiar, modificar e distribuir o código, mantendo o aviso de copyright e a licença.

---

## ⭐ Conheça, teste e contribua

Se você trabalha com QA, automação, desenvolvimento web ou qualidade de software, explore a demonstração e conheça as possibilidades da plataforma.

**Teste a aplicação, compartilhe feedback e ajude a evoluir a ferramenta.**

[🚀 Abrir demonstração](https://ferramenta-de-testes-demo.vercel.app) · [💻 Ver código-fonte](https://github.com/edmartelo/ferramenta-de-testes-v2)
