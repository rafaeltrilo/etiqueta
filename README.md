# Preço Real — comparador de preço unitário (PWA)

App web instalável no Android que calcula o **preço real** de cada produto
(por **metro**, **quilo**, **litro** ou **unidade**) e mostra qual é o melhor
custo-benefício — ajudando a escapar da *reduflação*.

## Funcionalidades

- 📷 **Fotos da etiqueta e da embalagem** (várias por produto, processadas em fila).
  Antes de ler, o app **acha a etiqueta na foto e recorta** — a foto do celular é
  vertical e a etiqueta é uma faixa fina, então recortar dobra a resolução do texto
  pequeno (`C/48`, `L32P28`, `50F`, "Preço por MT"), que é justamente o que saía errado.
  - **Leitura por IA (Claude)** — recomendada. Entende etiquetas de prateleira reais:
    nome, marca, preço, promoções "a partir de N un", peso/volume/metros/rolos e
    **nº de unidades** (conta os ovos da bandeja se não estiver escrito). Ative em ⚙️
    com uma chave da API Anthropic (console.anthropic.com). A chave fica só no celular
    e não entra no backup. Custo aproximado: poucos centavos por produto.
  - **OCR offline** (Tesseract.js) — usado sem chave, funciona sem internet e não
    custa nada. O texto do OCR passa por um parser feito para etiqueta de
    prateleira brasileira: separa o **preço do pacote** do preço por kg/L/m
    (pela altura da linha), entende `12x350ml`, `6 x 1 L`, `C/8`, `BANDEJA C/ 30`,
    `dúzia`, expande abreviações (`PAP HIG FT 20M` → "Papel higiênico folha
    tripla"), lê promoções `a partir de N un` e `leve 3 pague 2`, e confere o
    preço escolhido contra o preço por unidade impresso na etiqueta.
  - Campos preenchidos automaticamente ficam em amarelo. O que você digitar nunca é
    sobrescrito; fotos novas corrigem o que foi lido antes. **🧹 Novo produto** limpa tudo.
- ⚠️ **Checagem de sanidade**: antes de mostrar qualquer resultado, o app confere
  se o número é possível. "R$ 0,06 para 960 m" (o preço por metro da etiqueta lido
  como preço do pacote) é recusado com explicação, em vez de virar um
  "melhor custo-benefício" falso. Produtos reprovados ficam fora do pódio.
- 🏷️ **Promoção por quantidade**: a etiqueta brasileira tem duas colunas —
  preço normal à esquerda, "A partir de 3 UN / a UN sai por:" à direita. O app
  separa as colunas antes de ler (senão o "3 UN" vira a quantidade do produto)
  e mostra **as duas contas**: o preço por metro comprando 1 e levando N.
- 🧮 **Preço unitário instantâneo** enquanto você digita:
  - Papel / rolos → R$/m (rolos × metros por rolo)
  - Papel toalha → R$/100 folhas (é vendido por folha, não por metro)
  - Peso → R$/kg (g ou kg, com nº de embalagens no pacote)
  - Líquido → R$/L (ml ou L, com nº de embalagens)
  - Unidade → R$/un (ovos, fraldas, etc.)
- 💳 **Parcelado × à vista (aba Juros)**: com o preço à vista, nº e valor das
  parcelas, entrada e vencimento da 1ª parcela (no ato, 30, 45, 60 ou 90 dias),
  mostra o total parcelado, quanto se paga a mais e os **juros reais ao mês e ao
  ano** (taxa interna de retorno). Lê placas e folhetos por foto. As simulações
  ficam salvas e entram no backup.
- 🏆 **Ranking da visita**: produtos do mesmo *tipo* (ex.: "Papel higiênico")
  ordenados do mais barato ao mais caro, com destaque verde e % de diferença.
- 📒 **Histórico local**: último preço pago, menor/maior preço, tendência ▲▼ e
  **alerta de reduflação** quando a embalagem encolhe. Os dados ficam no
  `localStorage` e as fotos no **IndexedDB** (o `localStorage` tem teto de ~5 MB
  e não aguenta as miniaturas).
- ✏️ Editar / excluir registros, "Registrar preço de hoje", apagar visitas
  anteriores ou tudo, exportar/importar backup em JSON (o backup leva as fotos
  junto, mas **nunca** a chave da API).
- 📴 Funciona offline (service worker). O OCR precisa de internet só na 1ª vez
  (~4 MB, depois fica em cache).

## Estrutura

```
index.html            telas (Comparar, Adicionar, Histórico)
styles.css            layout mobile-first, tema claro/escuro
app.js                lógica: cálculo, OCR, histórico, PWA
sw.js                 service worker (offline + cache do OCR)
manifest.webmanifest  manifesto PWA (ícone, cor, standalone)
icons/                ícones 192/512/maskable + SVG
```

Sem build, sem dependências: é só hospedar a pasta. A pasta `icons/` é
obrigatória — sem ela o Chrome no Android não oferece "Instalar app".

## Testar no computador

```bash
python -m http.server 8080
```

Abra http://localhost:8080 (use o modo celular do DevTools).

Os testes do parser de etiqueta rodam sem navegador:

```bash
node test/parser.test.mjs   # 26 etiquetas de supermercado
node test/juros.test.mjs    # taxa de juros e leitura de anúncio
```

São 26 etiquetas em `test/etiquetas.json`, cada uma com as linhas e as alturas
que o OCR devolveria. As 12 marcadas `REAL:` são fotos de prateleira de verdade,
com os casos que mais derrubam o parser: preço por litro quase 4× o preço do
produto, promoção impressa em corpo maior que o preço normal, `L32P28`,
`50F C/2`, e a tarja "A partir de N UN" que não pode virar quantidade. Ao mexer no `parseLabel`, rode isso
antes de publicar — e acrescente a etiqueta que errou como novo caso.

## Publicar e instalar no Android

**Netlify (mais fácil):** entre em https://app.netlify.com/drop e arraste a pasta
`preco-real`. Você recebe um link `https://….netlify.app`.

**GitHub Pages:** crie um repositório, envie os arquivos desta pasta para a raiz,
e em *Settings → Pages* escolha a branch `main` / pasta `/ (root)`.

**No celular:** abra o link no Chrome → toque em **Instalar app** (botão no topo)
ou menu ⋮ → **Adicionar à tela inicial**. O app abre em tela cheia, com ícone próprio.

> A câmera e o service worker exigem **HTTPS** (Netlify e GitHub Pages já usam).

### Personalizações rápidas

- Esconder também a barra de status do Android: em `manifest.webmanifest`,
  troque `"display": "standalone"` por `"display": "fullscreen"`.
- Após alterar arquivos, mude `VERSION` em `sw.js` (ex.: `preco-real-v4`) para
  forçar a atualização nos celulares. O app avisa "Nova versão disponível" e
  atualiza ao toque.

## ⚠️ Sobre a chave da API

A chave fica no `localStorage` do celular e é enviada direto do navegador para a
Anthropic (`dangerouslyAllowBrowser`). Isso significa que **qualquer script que
rode nessa origem consegue lê-la** — e ela tem cobrança associada.

Se o app for usado só por você, use uma chave de um workspace dedicado com
*limite de gasto* baixo no console. Se for distribuir para outras pessoas, o
certo é pôr um proxy no servidor (Cloudflare Worker / Netlify Function) com a
chave do lado de lá e um rate limit — aí o app chama o seu endpoint e ninguém
precisa de chave própria.
