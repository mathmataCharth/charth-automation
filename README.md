# Charth Automações e Ferramentas

Ferramentas internas para compartilhamento de documentos, conferência de produtos e apoio às operações da Charth. Cada projeto tem suas próprias dependências, configuração e documentação.

## Projetos

| Projeto | Finalidade | Documentação |
| --- | --- | --- |
| PDF Secure Viewer | Compartilhar PDFs e lookbooks com senha, controle de acesso e identificação por destinatário | [Instalação e operação](PDF_sec_viewer/README.md) |
| Conferência de Produtos eStore | Comparar uma lista Excel de produtos e cores com o catálogo do eStore e gerar um relatório CSV | [Configuração e execução](conferencia_prod_estore/README.md) |

## PDF Secure Viewer

Aplicação web com painel administrativo para enviar documentos, criar links individuais e acompanhar acessos.

- Links com senha própria, limite de visualizações, expiração e ativação/desativação.
- Edição dos limites de acessos existentes, preservando URL, senha e histórico.
- Identificação individual sequencial, como `2027_A001`, aplicada em três posições de cada página. O ano identifica a coleção.
- Visualização de PDFs por blocos, com carregamento progressivo e preservação do arquivo original.
- Preparação de imagens WebP sem perdas em segundo plano, com código individual gravado nos pixels e acompanhamento do progresso no painel.
- Mudança automática para o visualizador de imagens quando todas as páginas e resoluções do acesso estiverem prontas; durante a preparação, o acesso continua usando PDF.
- Prévia administrativa para comparar imagens e PDF, retomar a preparação e priorizar destinatários.
- Registro de acessos com IP e User-Agent, senhas com hash e limitação de tentativas de autenticação.
- Entrega opcional de imagens por Cloudflare Worker e R2 privado, com autorização validada pela aplicação a cada requisição.

**Tecnologias:** Node.js, Express, EJS, SQLite, qpdf, Poppler e Sharp.

Os controles do navegador restringem ações comuns de download e cópia, mas não impedem capturas de tela ou fotografias. A identificação individual ajuda a rastrear o material compartilhado.

### Executar localmente

Com Node.js e npm instalados, execute os comandos a partir da raiz do repositório:

```bash
cd PDF_sec_viewer
npm ci
cp .env.example .env
```

Antes de iniciar, edite `.env`: use `NODE_ENV=development` para acesso local por HTTP e configure `BASE_URL`, `SESSION_SECRET`, `ADMIN_USERNAME` e `ADMIN_PASSWORD`. O administrador inicial é criado somente quando ainda não existe usuário administrativo no banco.

```bash
npm run dev
```

Abra `http://localhost:3000/admin/login` na porta padrão. Para preparar blocos e PDFs identificados, instale `qpdf`; a preparação por imagens também exige `pdftoppm` (Poppler) e fontes disponíveis no sistema.

Consulte o [guia completo do visualizador](PDF_sec_viewer/README.md) para configuração, testes, implantação com PM2 e detalhes dos caches. A entrega opcional está descrita no [guia Cloudflare Worker + R2](PDF_sec_viewer/cloudflare/README.md).

## Conferência de Produtos eStore

Automação em Python que conecta ao Chrome já autenticado, carrega o catálogo do eStore e compara os produtos e cores com a planilha `prod_lista.xlsx`.

O relatório `resultado.csv` classifica cada item como disponível, cor não encontrada ou produto não encontrado. Utiliza Python, Playwright e Pandas; o login no catálogo é manual.

Consulte as [instruções de execução](conferencia_prod_estore/README.md) para preparar o navegador e a planilha.

## Estrutura do repositório

```text
.
├── README.md
├── PDF_sec_viewer/
│   ├── server.js           # Aplicação Express
│   ├── src/                # Rotas, serviços, autenticação e banco
│   ├── views/              # Templates do painel e dos visualizadores
│   ├── public/             # Estilos e scripts do navegador
│   ├── scripts/            # Preparação de PDFs e processo de imagens
│   ├── tests/              # Testes automatizados
│   └── cloudflare/         # Worker para entrega privada de imagens
└── conferencia_prod_estore/
    ├── checker_catalogo.py
    └── README.md
```

Execute os comandos dentro da pasta de cada projeto. Credenciais e configurações de ambiente devem permanecer fora do Git; faça backup consistente do banco e dos documentos antes de atualizar uma instalação em produção.

