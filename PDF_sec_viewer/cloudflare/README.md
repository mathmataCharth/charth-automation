# Entrega privada de imagens

O backend continua na VPS. O processo de preparação envia somente imagens com o
código individual para um bucket R2 privado. O Worker valida uma autorização
assinada de 45 segundos e consulta a VPS **antes de todo acesso ao cache**, para
respeitar desativação, expiração e exclusão. Os limites são reservados ao abrir
o visualizador; buscar páginas não consome novas visualizações.

## Ativação na conta da empresa

1. Criar o bucket `charth-lookbook-private`, sem acesso público (`r2.dev` desligado
   e sem domínio público no bucket).
2. Criar uma credencial S3 com leitura/escrita restrita a esse bucket. Armazenar
   `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` e `R2_SECRET_ACCESS_KEY` apenas
   no `.env` da VPS, com permissões restritas. Nunca enviar segredos pelo chat
   nem incluí-los no Git.
3. Copiar `wrangler.example.toml` para `wrangler.toml`, confirmar o subdomínio
   `media-lookbook.charth.cloud` e fazer login na conta correta com Wrangler.
   O domínio principal do lookbook permanece na VPS.
4. Gerar um segredo aleatório (pelo menos 32 caracteres); gravar o mesmo valor
   em `MEDIA_EDGE_SECRET` na VPS e com `wrangler secret put MEDIA_EDGE_SECRET`.
5. Publicar com `wrangler deploy`. O binding `MEDIA` dá acesso ao bucket privado.
   O Worker precisa de domínio personalizado/rota para o Cache API funcionar;
   não usar `workers.dev` como configuração definitiva de cache.
6. Definir `MEDIA_EDGE_URL=https://media-lookbook.charth.cloud` na VPS e reiniciar
   somente `pdf-viewer`. As seis configurações são obrigatórias como conjunto.
   A fila reconhece a mudança de armazenamento e publica todos os arquivos.
7. Verificar um acesso de teste: senha, primeira abertura, imagens de ambos os
   perfis, repetição com `X-Media-Cache: HIT`, expiração e revogação após cache
   preenchido. Confirmar que os objetos não são acessíveis diretamente no bucket.

A entrega permanece local quando nenhuma variável Cloudflare está configurada.
A mudança não reduz resolução, não usa compressão com perdas e não altera PDFs.
Falhas de configuração ou upload não liberam imagens incompletas. Durante a
preparação, os links continuam usando o visualizador PDF existente.

O bucket contém derivados privados. Após excluir documentos, a consulta à VPS
nega o acesso imediatamente, inclusive com cache preenchido. A remoção física
de derivados antigos do R2 é uma rotina operacional separada; configure uma
política de retenção compatível com os documentos ativos antes da ativação.
