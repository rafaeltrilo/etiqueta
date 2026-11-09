# Preço Real — comparador de preço unitário (PWA)

App web instalável no Android que calcula o **preço real** de cada produto
(por **metro**, **quilo**, **litro** ou **unidade**) e mostra qual é o melhor
custo-benefício — ajudando a escapar da *reduflação*.

## Funcionalidades

- 📷 **Fotos da etiqueta e da embalagem** (várias por produto, processadas em fila):
  - **Leitura por IA (Claude)** — recomendada. Entende etiquetas de prateleira reais:
    nome, marca, preço, promoções "a partir de N un", peso/volume/metros/rolos e
    **nº de unidades** (conta os ovos da bandeja se não estiver escrito). Ative em ⚙️
    com uma chave da API Anthropic (console.anthropic.com). A chave fica só no celular
    e não entra no backup. Custo aproximado: poucos centavos por produto.
  - **OCR offline** (Tesseract.js) — usado sem chave; funciona sem internet, mas erra mais.
  - Campos preenchidos automaticamente ficam em amarelo. O que você digitar nunca é
    sobrescrito; fotos novas corrigem o que foi lido antes. **🧹 Novo produto** limpa tudo.
- 🧮 **Preço unitário instantâneo** enquanto você digita:
  - Papel / rolos → R$/m (rolos × metros por rolo)
  - Peso → R$/kg (g ou kg, com nº de embalagens no pacote)
  - Líquido → R$/L (ml ou L, com nº de embalagens)
  - Unidade → R$/un (ovos, fraldas, etc.)
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
