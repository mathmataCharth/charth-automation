# PDF Secure Viewer

Ferramenta para compartilhamento seguro de documentos PDF. O administrador faz upload de PDFs, gera links de acesso individuais protegidos por senha e monitora quem acessou, quando e de onde.

---

## O que faz

- **Upload de PDFs** via painel admin com validação de magic bytes (garante que o arquivo é realmente um PDF)
- **Links de acesso individuais** — cada destinatário recebe um link único com senha própria
- **Controles por link:** limite de visualizações, data de expiração, ativar/desativar
- **Visualizador protegido** — o PDF é exibido no navegador sem opção de download, sem menu de contexto, sem atalhos de teclado para salvar
- **Rate limiting** nas tentativas de senha (bloqueio por IP após N tentativas)
- **Log de acessos** — registra cada tentativa de senha, acesso e página visualizada, com IP e User-Agent
- **Autenticação por sessão** para o admin e para os viewers

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20 LTS |
| Framework | Express 4 |
| Templates | EJS |
| Banco de dados | SQLite (better-sqlite3) |
| Upload | Multer |
| Autenticação | bcryptjs + express-session |
| Rate limiting | express-rate-limit |
| Segurança | Helmet |
| PDF parsing | pdf-parse |
| IDs únicos | uuid |
| Processo (prod) | PM2 |

---

## Estrutura do projeto

```
PDF_sec_viewer/
├── server.js                  # Entry point
├── package.json
├── .env.example               # Template de variáveis de ambiente
├── data/                      # Banco SQLite (gerado automaticamente)
├── uploads/                   # PDFs enviados (gerado automaticamente)
├── public/
│   ├── admin/js/admin.js      # JS do painel admin
│   └── viewer/js/viewer.js    # JS do visualizador (proteções client-side)
├── views/
│   ├── admin/                 # Templates EJS do admin
│   └── viewer/                # Templates EJS do viewer
└── src/
    ├── config/
    │   └── database.js        # Conexão SQLite + criação das tabelas
    ├── middleware/
    │   ├── adminAuth.js       # Protege rotas do admin
    │   ├── viewerAuth.js      # Valida sessão do viewer
    │   └── security.js        # Headers CSP para o viewer
    ├── routes/
    │   ├── admin.js           # Rotas do painel admin
    │   ├── viewer.js          # Rotas do visualizador
    │   └── api.js             # API (servir o PDF por token)
    ├── services/
    │   ├── documentService.js # CRUD de documentos
    │   ├── accessService.js   # CRUD de links de acesso
    │   └── logService.js      # Registro e consulta de logs
    └── utils/
        ├── hash.js            # bcrypt hash/compare
        └── token.js           # Geração de tokens únicos
```

---

## Banco de dados

Quatro tabelas criadas automaticamente na primeira inicialização:

- **`admin_users`** — usuários do painel admin
- **`documents`** — PDFs enviados (título, nome do arquivo, tamanho, número de páginas)
- **`access_links`** — links de acesso gerados (token, destinatário, senha hash, limite de views, expiração)
- **`access_logs`** — log de todas as ações (tentativa de senha, acesso, etc.) com IP e User-Agent

---

## Rotas principais

| Rota | Descrição |
|---|---|
| `GET /admin/login` | Login do admin |
| `GET /admin/dashboard` | Painel — lista de documentos |
| `GET /admin/documents/:id` | Detalhes do documento + gerenciar links |
| `POST /admin/documents/upload` | Upload de novo PDF |
| `GET /admin/logs` | Log de acessos com filtros |
| `GET /v/:token` | Tela de senha para o destinatário |
| `POST /v/:token/auth` | Validação da senha (com rate limit) |
| `GET /v/:token/view` | Visualizador do PDF (requer autenticação) |

---

## Configuração

Copie `.env.example` para `.env` e ajuste os valores:

```env
PORT=3000
NODE_ENV=production
BASE_URL=http://seu-dominio-ou-ip:3000

SESSION_SECRET=string-longa-e-aleatoria-aqui

ADMIN_USERNAME=admin
ADMIN_PASSWORD=suasenha

MAX_PASSWORD_ATTEMPTS=5
PASSWORD_ATTEMPT_WINDOW_MINUTES=1
VIEWER_SESSION_MAX_AGE_HOURS=2

MAX_FILE_SIZE_MB=250
UPLOAD_DIR=./uploads
```

O usuário admin é criado automaticamente no banco ao iniciar, com as credenciais do `.env`.

---

## Instalação e execução

### Pré-requisitos

- Node.js 20 LTS (versões mais novas podem ter incompatibilidade com `better-sqlite3`)
- npm

### Desenvolvimento

```bash
npm install
cp .env.example .env
# Edite o .env com suas configurações
npm run dev
```

### Produção (VPS com PM2)

```bash
npm install
cp .env.example .env
# Edite o .env com NODE_ENV=production e os valores corretos
pm2 start server.js --name pdf-viewer
pm2 startup
pm2 save
```

A aplicação sobe em `http://localhost:3000` (ou na porta configurada no `.env`).

---

## Segurança implementada

- Senhas de admin e dos links armazenadas como hash bcrypt
- Rate limiting nas tentativas de senha por IP
- Tokens de acesso gerados com `uuid v4`
- Headers HTTP de segurança via Helmet
- CSP (Content Security Policy) restrito no visualizador
- Sessões com `httpOnly`, `sameSite: strict` e `secure: true` em produção
- Verificação de magic bytes no upload (rejeita arquivos que não sejam PDF de fato)
- Proxy trust configurado para capturar IP real quando atrás de Nginx/Cloudflare

---

## Implantação no VPS (Hostinger Ubuntu 24.04)

1. Instale Node 20, Git e PM2 no servidor
2. Clone apenas esta pasta do repositório com sparse checkout:

```bash
git clone --no-checkout --depth=1 https://github.com/mathmataCharth/charth-automation.git
cd charth-automation
git sparse-checkout init --cone
git sparse-checkout set PDF_sec_viewer
git checkout main
cd PDF_sec_viewer
```

3. Instale as dependências e configure o ambiente:

```bash
npm install
nano .env  # preencha com os valores de produção
```

4. Inicie com PM2:

```bash
pm2 start server.js --name pdf-viewer
pm2 startup
pm2 save
```

5. (Opcional) Configure Nginx como reverse proxy na porta 80/443 apontando para `localhost:3000`.
