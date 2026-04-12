# 🧾 Conferência de Produtos eStore (Automação)

## 📌 Visão Geral

Este projeto automatiza a conferência de produtos no catálogo do eStore (AppstoB), comparando uma lista de produtos (Nome + Cor) com os itens disponíveis no site.

A automação:

* acessa um navegador já logado
* carrega todo o catálogo (scroll infinito)
* extrai produtos e cores
* compara com uma planilha Excel
* gera um relatório final em CSV

---

## 🎯 Objetivo

Validar se produtos específicos estão disponíveis no catálogo com base em:

```
NOME DO PRODUTO + COR
```

Exemplo:

```
VESTIDO FATIMA - VANILLA
```

---

## ⚙️ Tecnologias Utilizadas

* Python 3.12+
* Playwright (automação de navegador)
* Pandas (leitura de Excel)
* OpenAI Codex (geração e execução do script)

---

## 📂 Estrutura do Projeto

```
conferencia_prod_estore/
│
├── prod_lista.xlsx        # Lista de entrada
├── checker_catalogo.py    # Script de automação
├── resultado.csv          # Saída gerada
└── README.md
```

---

## 📥 Entrada

Arquivo: `prod_lista.xlsx`

Formato:

| Itens para conferencia   |
| ------------------------ |
| VESTIDO FATIMA - VANILLA |
| VESTIDO FATIMA - PRETO   |

Regras:

* Uma linha por produto
* Formato obrigatório: `NOME - COR`

---

## 📤 Saída

Arquivo gerado: `resultado.csv`

Estrutura:

| item_original | nome | cor | status | cores_encontradas_no_site |
| ------------- | ---- | --- | ------ | ------------------------- |

Status possíveis:

* `DISPONIVEL`
* `COR_NAO_ENCONTRADA`
* `PRODUTO_NAO_ENCONTRADO`

---

## 🚀 Como Executar

### 1. Abrir o Chrome em modo debug

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug"
```

---

### 2. Fazer login no site

Acesse:

```
https://charth.appstob.com.br/?filtro=&outlet=0
```

* faça login
* deixe a página do catálogo aberta

---

### 3. Executar o script

```bash
python checker_catalogo.py
```

---

## 🔄 Funcionamento Interno

### Etapas da automação

1. Conecta ao Chrome via CDP (`localhost:9222`)
2. Identifica a aba do catálogo
3. Aguarda carregamento da página (Angular)
4. Executa scroll infinito até estabilizar
5. Extrai:

   * nome do produto
   * cores disponíveis
6. Lê o Excel
7. Normaliza os dados
8. Compara entrada vs catálogo
9. Gera resultado.csv

---

## ⚠️ Pontos de Atenção

### 🔹 Login

* deve ser feito manualmente
* o script reutiliza a sessão

### 🔹 Scroll infinito

* depende do carregamento correto da página
* pode variar conforme performance

### 🔹 Normalização

* comparação feita em UPPERCASE
* remove espaços extras

### 🔹 Dependência do DOM

Seletores utilizados:

* `app-produto-grid`
* `h3` (nome)
* `app-button-cores button[aria-label]` (cores)

Mudanças no front-end podem quebrar o script.

---

## 🛠️ Troubleshooting

### ❌ Não conecta no Chrome

Causa:

* Chrome não aberto com `--remote-debugging-port`

Solução:

* fechar Chrome
* reabrir com o comando correto

---

### ❌ Nenhuma aba encontrada

Causa:

* página não aberta ou não logada

---

### ❌ Poucos produtos carregados

Causa:

* scroll insuficiente

Solução:

* aumentar tempo de espera no script

---

## 🔮 Melhorias Futuras

* usar SKU ao invés de nome (mais confiável)
* fuzzy matching para nomes
* integração com SQL Server
* interface gráfica (sem terminal)
* execução agendada

---

## 📊 Resultado Esperado

Automação capaz de validar rapidamente grandes listas de produtos com precisão e rastreabilidade.

---

## 👤 Autor

Projeto desenvolvido com suporte de automação via
