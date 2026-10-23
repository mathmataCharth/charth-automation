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

### Atualizar o PDF dos acessos existentes

No painel do documento, use **Atualizar PDF → Enviar nova versão**. Os mesmos
links passam a abrir o novo arquivo, mantendo senha, código individual, contagem
e limite de visualizações, expiração, ativação e histórico. A atualização não
reativa acessos bloqueados ou esgotados.

O envio cria um arquivo independente. Um processo em segundo plano verifica a
integridade do PDF, rejeita criptografia/senha e prepara os blocos e as imagens
das duas resoluções para todos os acessos ativos. O PDF atual continua disponível
até a preparação completa; a troca do arquivo e dos trabalhos acontece em uma
única transação. A versão do arquivo acompanha as URLs de páginas e blocos para
evitar misturar arquivos durante uma sessão aberta, sem reservar outra visualização.

O painel mostra o progresso e permite cancelar ou retomar uma preparação que
falhou. Há somente uma atualização pendente por documento. PDFs anteriores ficam
no histórico com **Conferir PDF** e **Restaurar versão**; a restauração passa pela
mesma validação e preparação antes de entrar em uso. A conferência é exclusiva do
administrador e não consome visualizações de clientes.

Mantenha `qpdf`, Poppler e o processo de imagens funcionando. A preparação respeita
a reserva de espaço configurada por `IMAGE_PREPARATION_MIN_FREE_MB`; falhas deixam
a versão atual em uso. O histórico ocupa espaço adicional e deve entrar no backup
do banco e de `uploads/`. Excluir o documento remove também suas versões e derivados.

### Teste interno de visualização por imagens

Na lista de acessos do documento, **Testar imagens** abre uma tela restrita ao
administrador, com as opções **Imagens** e **PDF**. Ambos usam o código individual
do acesso escolhido. A comparação não altera senhas, limites, status, visualizações
ou logs das clientes. Os links públicos usam imagens automaticamente depois de
todas as páginas e resoluções daquele acesso estarem prontas; até lá, usam o PDF.
A prévia administrativa também permite inspecionar acessos vencidos ou desativados.

O piloto converte cada página solicitada com `qpdf` e `pdftoppm`, conserva seu recorte
e rotação, e usa WebP **sem perdas** para armazenar a imagem renderizada. O PDF
original permanece intacto. A visualização usa até 1800 px no lado maior; ao ampliar
acima de 125%, solicita uma imagem independente de até 4800 px para conferir detalhes.
Rasterização tem resolução finita: avalie as peças no zoom antes de adotar o formato.

As três identificações `Versão:2027_A001`, em `#777777`, são gravadas nos pixels no
servidor. Bases sem código são privadas e não têm rota de entrega. Cada requisição
de imagem ou PDF da prévia exige sessão de administrador, e as respostas usam
`private, no-store`. Uma falha de conversão retorna erro, sem expor a base ou o original.

As rotas de imagens entregam somente arquivos prontos: nunca iniciam conversão.
O upload e a criação de acessos agendam a preparação; documentos existentes são
descobertos automaticamente na inicialização e a cada minuto. Um processo separado,
com prioridade menor, prepara as bases compartilhadas e grava as três identificações
em cada versão individual. A tabela `image_preparations` registra progresso, erros,
retentativas e reservas de trabalho; reinícios retomam os arquivos já gerados.
Um único trabalho de imagem pode executar por vez, mesmo durante sobreposição de
processos. Trabalhos abandonados ficam disponíveis após cinco minutos.

O painel mostra o progresso do documento e de cada acesso, permite **Retomar
preparação** e **Priorizar imagens** para um destinatário. Inicialmente, a fila
antecipa as primeiras cinco páginas dos acessos; depois conclui os mais recentes.
Um acesso priorizado é preparado primeiro. A migração de documentos grandes pode
demorar; a navegação pública permanece em PDF até o acesso completo estar pronto.
Desativados aguardam reativação. A preparação não consome visualizações nem cria
logs de cliente; senha, URL, código, limites e contadores existentes são preservados.

O navegador antecipa uma página vizinha, mantém no máximo três blobs e baixa a
resolução maior apenas ao ampliar. Os tempos da tela de teste incluem download,
decodificação e exibição, e a primeira página inclui a inicialização. Acesso,
expiração e revogação são conferidos em cada requisição; uma abertura reserva
uma visualização independentemente da quantidade de páginas e resoluções.

Dependências: `npm ci` (inclui `sharp` fixado no lockfile) e, no Ubuntu,
`apt-get install --no-install-recommends poppler-utils fontconfig`.
`PDFTOPPM_BIN` e `QPDF_BIN` permitem configurar os executáveis.
Os derivados ficam em `<arquivo>.pdf.parts/image-preview/`. Depois de iniciar a
preparação persistente, o marcador privado `.prepared` impede a remoção por limite
de cache: arquivos prontos precisam continuar disponíveis sem reconversão. O limite
`IMAGE_PREVIEW_CACHE_MB` aplica-se somente aos caches antigos ainda não preparados.
O processo interrompe conversões quando restam menos de 2048 MB livres, configuráveis
por `IMAGE_PREPARATION_MIN_FREE_MB` (mínimo 256 MB), e retoma com retentativas.
Reserve espaço para bases de ambas as resoluções e versões de cada acesso; o uso
cresce com o número de destinatários. Excluir o documento remove bases, imagens e
trabalhos locais. Uma imagem preparada removida externamente volta à fila ao ser
solicitada; nunca se entrega a base sem identificação.

`IMAGE_PREPARATION_ENABLED=false` desliga o processo automático.
`IMAGE_VIEWER_ENABLED=false` mantém os clientes no PDF durante uma avaliação interna.
A migração do banco é aditiva; faça backup consistente antes de publicar. Voltar o
código preserva originais, acessos e as tabelas de preparação.

### Cloudflare R2 + Worker (opcional)

A implementação da entrega privada está em `cloudflare/`, com instruções em
`cloudflare/README.md`. Sem credenciais, a entrega continua na VPS. Após configurar
o Worker e o R2 privado, a fila publica as imagens prontas no bucket e os acessos
recebem autorizações assinadas de 45 segundos. O Worker consulta a VPS **antes de
cada resposta**, inclusive antes de reutilizar o cache. O cache inclui documento,
versão, destinatário, página e resolução; o navegador continua sem cache persistente.
Originais e bases sem código nunca são enviados ao bucket. A configuração exige
domínio personalizado/rota no Worker e preserva o domínio do site principal.

### Código individual nas páginas

Cada acesso recebe um código sequencial fixo (`A001`, `A002`, ...), mostrado como
`2027_A001` na coluna **Versão** do painel. O ano é a identificação editorial da
coleção, não o ano corrente. Após `A999`, a sequência continua em `A1000`.
A atribuição também é feita aos acessos antigos, em ordem de criação, sem alterar
links, senhas, limites ou contagens. A sequência é global e nunca reutiliza códigos
de acessos excluídos. Os códigos numéricos anteriores ficam preservados no banco
e aparecem como **Anterior** no painel para rastrear fotografias já compartilhadas.

Todas as páginas servidas pela API recebem `Versão:2027_A001` em três posições:
topo central, lateral esquerda na vertical e região inferior direita (acima do
rodapé). A fonte é pequena, na cor `#777777`, com opacidade total e sem retângulo
de fundo. O código é
inserido no PDF no servidor, inclusive nos blocos e na rota de documento completo.
O original armazenado não é alterado; não há rasterização, redução de resolução
ou recompressão das fotografias. A rotação e o recorte de cada página são mantidos.

Esta função requer as dependências do `package-lock.json` e o executável `qpdf`.
Após gerar o PDF identificado, `qpdf` o lineariza mantendo os streams das imagens.
Falhas de preparação retornam erro; a API nunca usa o original sem código como
alternativa. A autorização e a expiração são verificadas novamente após a geração.

Os PDFs identificados ficam em `<arquivo>.pdf.parts/access-cache/`, com chave que
inclui versão do arquivo, código e estilo. Requisições simultâneas do mesmo acesso
reutilizam a mesma geração; trabalhos diferentes são serializados para limitar
memória. O cache por documento é limitado por `ACCESS_PDF_CACHE_MB` (padrão 1024 MB)
e `ACCESS_PDF_CACHE_HOURS` (6 horas sem uso), com limpeza após novas gerações.
O arquivo recém-gerado é preservado mesmo se sozinho exceder o limite configurado.
Excluir o documento também remove esse cache. O navegador permanece sem cache
persistente dos PDFs.

A inicialização aplica uma migração aditiva e transacional: coluna `version_code`,
índice único e tabela `access_version_registry` com sequência persistente. A coluna
legada `access_code` e seu registro são preservados. Faça backup do banco antes de
publicar. Voltar ao código anterior não exige apagar as novas estruturas.

### Editar limites de acessos existentes

Na página do documento, use **Editar limites** na lista **Acessos Criados**.
Altere a quantidade máxima de visualizações e/ou a data e hora de expiração e
clique em **Salvar alterações**. Campos vazios removem o respectivo limite.

O limite de visualizações é o total permitido, incluindo as já utilizadas:
um acesso com 5 visualizações que passa a ter limite 20 permite mais 15 aberturas.
Editar os limites preserva a URL, a senha, o destinatário, o histórico e o status
ativo/inativo. Aumentar os limites permite reutilizar um acesso vencido ou esgotado;
um acesso desativado continua exigindo o botão **Ativar**.

Datas são informadas e exibidas no horário de Brasília (`America/Sao_Paulo`) e
salvas com fuso explícito. Valores antigos sem fuso são interpretados como UTC,
conforme o servidor em produção, preservando o instante de expiração existente.
A rota `POST /admin/links/:id/limits` exige autenticação administrativa e valida os
campos no servidor. Esta melhoria não requer migração do banco.

### Carregamento progressivo por blocos

O visualizador mantém um único link, senha e numeração de páginas. PDFs preparados
são lidos em blocos: primeiro 5 páginas, depois grupos de 20. A próxima página é
pré-renderizada quando o navegador fica ocioso, inclusive na passagem entre blocos.
Até três blocos ficam em memória, além do cache de seis páginas renderizadas.

Instale `qpdf` no servidor (Ubuntu: `sudo apt-get install qpdf`). Os tamanhos dos
blocos podem ser ajustados com `PDF_FIRST_BLOCK_PAGES` e `PDF_BLOCK_PAGES` no `.env`.
`QPDF_BIN` permite informar um caminho alternativo para o executável.

Novos uploads preservam integralmente o arquivo enviado e geram os blocos em segundo plano.
Não há recompressão de fotografias, redução de resolução ou alteração de qualidade JPEG.
Para preparar documentos que já estão em uso, execute **dentro de `PDF_sec_viewer/`**:

```bash
npm run prepare:pdfs
# Ou apenas um arquivo armazenado no servidor:
node scripts/prepare-parts.js ./uploads/arquivo.pdf
```

O comando preserva o PDF original, os registros do banco e os links existentes.
Os blocos preservam os streams das imagens com `qpdf --stream-data=preserve`. São gravados em `<arquivo>.pdf.parts/` e só
ficam disponíveis após a geração completa. Documentos sem blocos prontos continuam
usando o arquivo inteiro com requisições por intervalo de bytes. Se `qpdf` falhar,
o upload permanece disponível nesse modo.

Uma visualização passa a ser contada ao abrir a tela do visualizador; buscar
metadados, páginas ou blocos durante essa abertura não consome novas visualizações.
Recarregar a tela conta como nova abertura. Desativação e expiração continuam
sendo verificadas em cada requisição. O PDF permanece sem cache persistente no
navegador: esta melhoria reduz o arquivo inicial, sem reutilizar o PDF após reload.

O comando antigo `node scripts/recompress.js` também passa a apenas preparar blocos,
sem recomprimir imagens. Arquivos que já tenham sido reduzidos por uma versão anterior
precisam ser restaurados a partir do PDF original para recuperar a qualidade perdida.

Reserve espaço adicional em disco para os blocos (aproximadamente mais uma cópia
do PDF; recursos compartilhados podem aumentar esse total). A preparação repetida
reutiliza a versão pronta quando o arquivo e a configuração não mudaram. Versões
anteriores após reprocessamento são preservadas para visualizadores já abertos;
excluir o documento remove também seus blocos.

Para publicar, atualize o código, reinicie a aplicação e execute a preparação no
servidor. Não é necessário recriar documentos ou distribuir novos links. Para
voltar à versão anterior, restaure o código anterior; os PDFs originais permanecem
disponíveis. Esta alteração não requer migração do banco.

Validação automatizada com Node.js 20 e dependências instaladas:

```bash
npm test
```

Os testes usam banco e arquivos temporários isolados. Cobrem autorização, limite
de visualizações, requisições parciais, falhas, navegação entre blocos, cache e
compatibilidade com documentos ainda não preparados.

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
