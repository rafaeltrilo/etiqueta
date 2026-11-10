/* =========================================================
   Preço Real — PWA comparador de preço unitário
   Sem build. Leitura das fotos:
     • IA (Claude, via SDK oficial @anthropic-ai/sdk) quando há chave configurada
     • OCR offline (Tesseract.js) como alternativa
   ========================================================= */
'use strict';

const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const ANTHROPIC_SDK_URLS = [
  'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.6.0/+esm',
  'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1/+esm',   // se a versao fixa sumir do CDN
];
const AI_MODEL = 'claude-opus-5-5';
const STORAGE_KEY = 'precoreal:v1';
const KEY_STORAGE = 'precoreal:apikey';   // separado do backup: nunca é exportado
const MAX_AI_PHOTOS = 4;
const THUMB_DB = 'precoreal-fotos';
const THUMB_STORE = 'thumbs';

const CATS = {
  papel:   { label: 'Papel / rolo', short: 'Papel',   unit: 'm',  unitName: 'metro',   icon: '🧻' },
  peso:    { label: 'Peso',         short: 'Peso',    unit: 'kg', unitName: 'quilo',   icon: '⚖️' },
  liquido: { label: 'Líquido',      short: 'Líquido', unit: 'L',  unitName: 'litro',   icon: '🥤' },
  folha:   { label: 'Folhas',       short: 'Folhas',  unit: '100 fl', unitName: '100 folhas', icon: '🧺' },
  unidade: { label: 'Unidade',      short: 'Unidade', unit: 'un', unitName: 'unidade', icon: '🥚' },
};

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const F = id => document.getElementById('f-' + id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = s => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Converte "1.234,56", "12,9", "12.90", "R$ 5" em número. */
function num(v) {
  if (v == null) return NaN;
  let s = String(v).trim().replace(/\s/g, '').replace(/^R\$/i, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  // "1.234" / "1.234.567" sem virgula: ponto e separador de milhar, nao decimal
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}
const fmtN = (n, max = 2) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: max });
const money = v => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brl = (v, d = 2) => Number(v).toLocaleString('pt-BR',
  { style: 'currency', currency: 'BRL', minimumFractionDigits: d, maximumFractionDigits: d });
const fmtDate = ts => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
const fmtDateTime = ts => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function fmtUnit(v, cat) {
  if (!Number.isFinite(v)) return '—';
  return `${brl(v, v < 1 ? 3 : 2)}/${CATS[cat].unit}`;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- armazenamento (localStorage) ---------- */
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && Array.isArray(s.entries)) return { visits: [], lastStore: '', ...s };
  } catch { /* dado corrompido: recomeça */ }
  return { entries: [], visits: [], currentVisitId: null, lastStore: '' };
}
let state = load();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.warn(err);
    return false;
  }
}

/* ---------- fotos no IndexedDB ----------
   As miniaturas nao cabem no localStorage (teto de ~5 MB para TODO o estado).
   Ficam no IndexedDB e sao carregadas uma vez para um Map em memoria, para
   que a renderizacao continue sincrona. */
const thumbs = new Map();          // thumbId -> dataURL
let thumbDb = null;

function idb() {
  if (thumbDb) return thumbDb;
  thumbDb = new Promise((res, rej) => {
    let rq;
    try { rq = indexedDB.open(THUMB_DB, 1); } catch (err) { rej(err); return; }
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(THUMB_STORE)) rq.result.createObjectStore(THUMB_STORE); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  thumbDb.catch(() => { thumbDb = null; });
  return thumbDb;
}
function idbRun(mode, fn) {
  return idb().then(db => new Promise((res, rej) => {
    const tx = db.transaction(THUMB_STORE, mode);
    fn(tx.objectStore(THUMB_STORE));
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}
async function loadThumbs() {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction(THUMB_STORE, 'readonly');
      const rq = tx.objectStore(THUMB_STORE).openCursor();
      rq.onsuccess = () => {
        const c = rq.result;
        if (!c) return;
        thumbs.set(c.key, c.value);
        c.continue();
      };
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } catch (err) { console.warn('IndexedDB indisponivel:', err); }
}
async function putThumb(id, dataUrl) {
  thumbs.set(id, dataUrl);
  try { await idbRun('readwrite', st => st.put(dataUrl, id)); return true; }
  catch (err) { console.warn(err); thumbs.delete(id); return false; }
}
async function dropThumb(id) {
  if (!id) return;
  thumbs.delete(id);
  try { await idbRun('readwrite', st => st.delete(id)); } catch (err) { console.warn(err); }
}
/** Remove do IndexedDB as fotos que nao pertencem mais a nenhum registro. */
async function pruneThumbs() {
  const used = new Set(state.entries.map(e => e.thumbId).filter(Boolean));
  for (const id of [...thumbs.keys()]) if (!used.has(id)) await dropThumb(id);
}
const thumbOf = e => (e && e.thumbId ? thumbs.get(e.thumbId) : null) || null;

/** Backups antigos / estado antigo guardavam a foto como dataURL em e.thumb. */
async function migrateThumbs() {
  let moved = 0;
  for (const e of state.entries) {
    if (!e.thumb) continue;
    const id = e.thumbId || uid();
    if (await putThumb(id, e.thumb)) { e.thumbId = id; moved++; }
    delete e.thumb;
  }
  if (moved) save();
  return moved;
}

const getApiKey = () => { try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; } };
const hasAi = () => getApiKey().startsWith('sk-');

function currentVisit() {
  let v = state.visits.find(x => x.id === state.currentVisitId);
  if (!v) {
    v = { id: uid(), startedAt: Date.now() };
    state.visits.push(v);
    state.currentVisitId = v.id;
    save();
  }
  return v;
}

/* ---------- cálculo do preço unitário ---------- */
/** Quantidade total na unidade padrão (m, kg, L, 100 folhas ou un). */
function baseQty(e) {
  const packs = e.packs > 0 ? e.packs : 1;
  switch (e.category) {
    case 'papel':   return e.rolls * e.metersPerRoll;
    case 'peso':    return e.qty * (e.unit === 'g' ? 0.001 : 1) * packs;
    case 'liquido': return e.qty * (e.unit === 'ml' ? 0.001 : 1) * packs;
    case 'folha':   return (e.sheets * (e.packs > 0 ? e.packs : 1)) / 100;
    case 'unidade': return e.count;
  }
  return NaN;
}
const unitPrice = e => e.price / baseQty(e);

/* ---------- checagem de sanidade ----------
   Uma leitura errada produz um numero que PARECE uma resposta: "R$ 0,000/m",
   "o mais barato custa 97% menos". Isso e pior do que nao ler nada, porque leva
   a comprar o produto errado. Antes de exibir, o app confere se o resultado e
   possivel e, quando nao for, avisa em vez de montar o ranking. */

/** Faixas plausiveis de preco unitario no mercado brasileiro (R$). */
const FAIXA = {
  papel:   [0.01, 2],      // por metro
  peso:    [0.5, 500],     // por quilo
  liquido: [0.5, 200],     // por litro
  folha:   [0.2, 50],      // por 100 folhas
  unidade: [0.02, 500],    // por unidade
};

/** Devolve o motivo pelo qual o cálculo não parece confiável, ou null. */
function sanity(e, peers = []) {
  const base = baseQty(e);
  if (!Number.isFinite(base) || base <= 0) return 'Falta a quantidade da embalagem para calcular o preço real.';
  if (!(e.price > 0)) return 'Falta o preço total.';

  // O erro mais comum: pegar o "Preço por MT/LT/UN" da etiqueta como preço do pacote.
  if (e.price < 1 && base >= 5) {
    return `R$ ${money(e.price)} para ${fmtBase(e)}? `
      + 'Isso parece ser o preço por unidade impresso na etiqueta, não o preço do pacote.';
  }
  const up = e.price / base;
  const [min, max] = FAIXA[e.category] || [0, Infinity];
  if (up < min) return `${fmtUnit(up, e.category)} é barato demais para ser verdade. Confira o preço e a quantidade.`;
  if (up > max) return `${fmtUnit(up, e.category)} é caro demais para ser verdade. Confira o preço e a quantidade.`;

  // Muito fora da curva dos outros produtos do mesmo tipo nesta visita.
  const ups = peers.map(unitPrice).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (ups.length >= 2) {
    const mediana = ups[Math.floor(ups.length / 2)];
    if (up < mediana / 8 || up > mediana * 8) {
      return `${fmtUnit(up, e.category)} destoa demais dos outros (${fmtUnit(mediana, e.category)}). Confira os dados.`;
    }
  }
  return null;
}
const isEggs = e => /\bovos?\b/.test(norm(`${e.type} ${e.name}`));

function describeQty(e) {
  const packs = e.packs > 1 ? `${fmtN(e.packs)} × ` : '';
  switch (e.category) {
    case 'papel': return `${fmtN(e.rolls)} rolo${e.rolls > 1 ? 's' : ''} × ${fmtN(e.metersPerRoll)} m = ${fmtN(baseQty(e))} m`;
    case 'peso':
    case 'liquido': return `${packs}${fmtN(e.qty, 3)} ${e.unit}`;
    case 'folha': {
      const n = e.packs > 1 ? `${fmtN(e.packs)} rolos × ` : '';
      return `${n}${fmtN(e.sheets)} folhas = ${fmtN(e.sheets * (e.packs > 1 ? e.packs : 1))} folhas`;
    }
    case 'unidade': return `${fmtN(e.count)} un`;
  }
  return '';
}
/** "960 m", "360 folhas", "1,5 kg": o total da embalagem em texto corrido. */
function fmtBase(e) {
  const base = baseQty(e);
  if (e.category === 'folha') return `${fmtN(base * 100)} folhas`;
  return `${fmtN(base, 3)} ${CATS[e.category].unit}`;
}

const productKey = e => [e.category, norm(e.name), norm(e.brand)].join('|');
const groupLabel = e => tipoCanonico((e.type || '').trim()) || CATS[e.category].short;
const groupKey = e => e.category + '|' + norm(groupLabel(e));

/** Registro anterior do mesmo produto (outra visita). */
function previousOf(e) {
  const k = productKey(e);
  return state.entries
    .filter(x => x.id !== e.id && x.visitId !== e.visitId && x.createdAt < e.createdAt && productKey(x) === k)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

function trendHtml(cur, old) {
  const d = (cur / old - 1) * 100;
  if (!Number.isFinite(d)) return '';
  if (Math.abs(d) < 0.5) return '<span class="trend-eq">= estável</span>';
  return d > 0
    ? `<span class="trend-up">▲ ${fmtN(d, 1)}%</span>`
    : `<span class="trend-down">▼ ${fmtN(-d, 1)}%</span>`;
}

/** Linha "última vez" + alerta de reduflação. */
function historyNote(e) {
  const p = previousOf(e);
  if (!p) return '';
  let s = `<div class="prev">Última vez (${fmtDate(p.createdAt)}${p.store ? ' · ' + esc(p.store) : ''}): `
    + `${brl(p.price)} → ${fmtUnit(unitPrice(p), p.category)} ${trendHtml(unitPrice(e), unitPrice(p))}</div>`;
  if (baseQty(p) > baseQty(e) * 1.005) {
    s += `<div class="warn">⚠️ Reduflação: a embalagem diminuiu de ${fmtBase(p)} para ${fmtBase(e)}`
      + (e.price >= p.price ? ' e o preço não caiu!' : '.') + '</div>';
  }
  return s;
}

/* ---------- navegação ---------- */
const VIEWS = ['compare', 'add', 'history', 'settings'];
function showView(name) {
  if (!VIEWS.includes(name)) name = 'compare';
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'compare') renderCompare();
  if (name === 'history') renderHistory();
  if (name === 'add') { renderDatalists(); renderReadMode(); updateLive(); }
  if (name === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
}
function go(name) {
  if (location.hash === '#' + name) showView(name);
  else location.hash = name;
}
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

/* ---------- filtros por categoria ---------- */
function renderChips(container, current, onPick) {
  const opts = [['all', 'Todos'], ...Object.entries(CATS).map(([k, c]) => [k, `${c.icon} ${c.short}`])];
  container.innerHTML = opts.map(([k, l]) =>
    `<button type="button" class="chip" data-k="${k}" aria-pressed="${k === current}">${l}</button>`).join('');
  container.onclick = ev => {
    const b = ev.target.closest('[data-k]');
    if (b) onPick(b.dataset.k);
  };
}

/* =========================================================
   VIEW: COMPARAR (visita atual)
   ========================================================= */
let compareFilter = 'all';

function renderCompare() {
  const visit = currentVisit();
  const items = state.entries.filter(e => e.visitId === visit.id);
  const stores = [...new Set(items.map(e => e.store).filter(Boolean))];
  $('#visit-info').textContent = `Iniciada em ${fmtDateTime(visit.startedAt)}`
    + (stores.length ? ` · ${stores.join(', ')}` : '') + ` · ${items.length} produto${items.length === 1 ? '' : 's'}`;

  renderChips($('#compare-filter'), compareFilter, k => { compareFilter = k; renderCompare(); });

  const list = $('#compare-list');
  const shown = items.filter(e => compareFilter === 'all' || e.category === compareFilter);
  if (!shown.length) {
    list.innerHTML = `<div class="card empty"><span class="big-ico">🛒</span>
      ${items.length ? 'Nenhum produto nesta categoria.' : 'Nenhum produto nesta visita ainda.<br>Toque em <b>+ Adicionar</b> e fotografe a etiqueta.'}</div>`;
    return;
  }

  const groups = new Map();
  for (const e of shown) {
    const k = groupKey(e);
    if (!groups.has(k)) groups.set(k, { cat: e.category, label: groupLabel(e), items: [] });
    groups.get(k).items.push(e);
  }

  list.innerHTML = [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))
    .map(renderGroup).join('');
}

function renderGroup(g) {
  const c = CATS[g.cat];
  // Itens cujo calculo nao passa na checagem ficam de fora do podio e aparecem
  // no fim com o aviso: um numero errado nao pode virar "melhor custo-beneficio".
  const avisos = new Map(g.items.map(e => [e.id, sanity(e, g.items.filter(x => x.id !== e.id))]));
  const bons = g.items.filter(e => !avisos.get(e.id)).sort((a, b) => unitPrice(a) - unitPrice(b));
  const ruins = g.items.filter(e => avisos.get(e.id));
  const sorted = [...bons, ...ruins];
  const best = bons.length ? unitPrice(bons[0]) : NaN;
  const worst = bons.length ? unitPrice(bons[bons.length - 1]) : NaN;
  const multi = bons.length > 1;

  const lis = sorted.map((e, i) => {
    const aviso = avisos.get(e.id);
    const up = unitPrice(e);
    const diff = (up / best - 1) * 100;
    const isBest = i === 0 && multi && !aviso;
    const pic = thumbOf(e);
    // Preco levando N, quando a etiqueta tinha promocao por quantidade.
    const deal = !aviso && e.promoPrice > 0
      ? `<span class="deal">🏷️ levando ${e.promoMinQty > 1 ? e.promoMinQty : 'na promoção'}: ${fmtUnit(e.promoPrice / baseQty(e), e.category)}</span>`
      : '';
    return `<li class="item ${isBest ? 'best' : ''} ${pic ? 'has-pic' : ''}">
      <span class="pos">${aviso ? '⚠️' : i + 1}</span>
      ${pic ? `<img class="pic" src="${pic}" alt="">` : ''}
      <div class="info">
        ${isBest ? '<span class="badge">Melhor custo-benefício</span>' : ''}
        <strong>${esc(e.name)}</strong>
        <small>${esc(e.brand || 'Sem marca')} · ${describeQty(e)} · ${brl(e.price)}${isEggs(e) && !aviso ? ` · dúzia ${brl(up * 12)}` : ''}</small>
        ${deal}
      </div>
      <div class="up">
        <b>${aviso ? '—' : fmtUnit(up, e.category)}</b>
        ${!aviso && multi ? (i === 0 ? '<small>mais barato</small>' : `<small>+${fmtN(diff, 1)}%</small>`) : ''}
      </div>
      ${!aviso && multi ? `<div class="bar"><i style="width:${Math.max(6, (up / worst) * 100).toFixed(1)}%"></i></div>` : ''}
      <div class="extra">${aviso ? `<div class="sanity">⚠️ ${aviso} <b>Toque em ✏️ para corrigir.</b></div>` : historyNote(e)}</div>
      <div class="tools">
        <button class="icon-btn" data-act="edit" data-id="${e.id}" aria-label="Editar">✏️</button>
        <button class="icon-btn" data-act="del" data-id="${e.id}" aria-label="Remover">🗑️</button>
      </div>
    </li>`;
  }).join('');

  const saving = multi && worst > best
    ? `<div class="saving">💡 O mais barato custa <b>${fmtN((1 - best / worst) * 100, 1)}% menos</b> por ${c.unitName} que o mais caro.</div>`
    : (bons.length > 1 || bons.length === 0 ? '' : `<p class="muted small">Adicione outro produto do tipo “${esc(g.label)}” para comparar.</p>`);

  return `<section class="card">
    <div class="group-head">
      <h3>${c.icon} ${esc(g.label)}</h3>
      <span class="muted small">preço por ${c.unitName}</span>
    </div>
    <ol class="rank">${lis}</ol>
    ${saving}
  </section>`;
}

$('#btn-new-visit').addEventListener('click', () => {
  const v = currentVisit();
  const n = state.entries.filter(e => e.visitId === v.id).length;
  if (!n) { toast('A visita atual já está vazia.'); return; }
  if (!confirm('Encerrar esta visita e começar uma nova?\nOs produtos continuam salvos no Histórico.')) return;
  const nv = { id: uid(), startedAt: Date.now() };
  state.visits.push(nv);
  state.currentVisitId = nv.id;
  save();
  renderCompare();
  toast('Nova visita iniciada 🛒');
});

/* =========================================================
   VIEW: ADICIONAR / EDITAR
   ========================================================= */
const form = $('#product-form');
let editingId = null;
let editThumb = null;    // foto do registro em edição/novo preço
let promo = null;        // { price, minQty } detectado na etiqueta

function setCategory(cat) {
  form.dataset.category = cat;
  $$('#cat-seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.cat === cat));
  F('type').placeholder = { papel: 'Ex.: Papel higiênico', peso: 'Ex.: Arroz', liquido: 'Ex.: Refrigerante', folha: 'Ex.: Papel toalha', unidade: 'Ex.: Ovos' }[cat];
  updateLive();
}

$('#cat-seg').insertAdjacentHTML('beforeend', Object.entries(CATS).map(([k, c]) =>
  `<button type="button" data-cat="${k}" aria-pressed="false"><span class="ico">${c.icon}</span>${c.short}<small>por ${c.unit}</small></button>`).join(''));
$('#cat-seg').addEventListener('click', ev => {
  const b = ev.target.closest('[data-cat]');
  if (b) setCategory(b.dataset.cat);
});

// Atalhos de quantidade (ovos: dúzia, 30…)
$('.qty-shortcuts').addEventListener('click', ev => {
  const b = ev.target.closest('[data-count]');
  if (!b) return;
  F('count').value = b.dataset.count;
  F('count').dataset.user = '1';
  F('count').classList.remove('autofilled');
  updateLive();
});

function readForm() {
  const cat = form.dataset.category;
  const e = {
    category: cat,
    name: F('name').value.trim(),
    brand: F('brand').value.trim(),
    type: F('type').value.trim(),
    store: F('store').value.trim(),
    price: num(F('price').value),
  };
  if (cat === 'papel') { e.rolls = num(F('rolls').value); e.metersPerRoll = num(F('mpr').value); }
  else if (cat === 'peso') { e.qty = num(F('wqty').value); e.unit = F('wunit').value; e.packs = num(F('wpacks').value) || 1; }
  else if (cat === 'liquido') { e.qty = num(F('vqty').value); e.unit = F('vunit').value; e.packs = num(F('vpacks').value) || 1; }
  else if (cat === 'folha') { e.sheets = num(F('sheets').value); e.packs = num(F('fpacks').value) || 1; }
  else { e.count = num(F('count').value); }
  return e;
}

function fillForm(e, { keepPrice = true } = {}) {
  setCategory(e.category);
  F('name').value = e.name || '';
  F('brand').value = e.brand || '';
  F('type').value = e.type || '';
  F('store').value = e.store || state.lastStore || '';
  F('price').value = keepPrice && e.price ? money(e.price) : '';
  F('rolls').value = e.rolls ?? '';
  F('mpr').value = e.metersPerRoll != null ? fmtN(e.metersPerRoll, 2) : '';
  F('wqty').value = e.category === 'peso' ? fmtN(e.qty, 3) : '';
  F('wunit').value = e.category === 'peso' ? e.unit : 'g';
  F('wpacks').value = e.category === 'peso' && e.packs > 1 ? e.packs : '';
  F('vqty').value = e.category === 'liquido' ? fmtN(e.qty, 3) : '';
  F('vunit').value = e.category === 'liquido' ? e.unit : 'ml';
  F('vpacks').value = e.category === 'liquido' && e.packs > 1 ? e.packs : '';
  F('sheets').value = e.category === 'folha' ? (e.sheets ?? '') : '';
  F('fpacks').value = e.category === 'folha' && e.packs > 1 ? e.packs : '';
  F('count').value = e.count ?? '';
  updateLive();
}

function resetForm() {
  form.reset();
  editingId = null;
  editThumb = null;
  clearPhotos();
  setPromo(null);
  $$('input, select', form).forEach(el => { delete el.dataset.user; el.classList.remove('autofilled'); });
  $('#t-add').textContent = 'Adicionar produto';
  $('#btn-save').textContent = 'Salvar na visita atual';
  $('#btn-cancel-edit').hidden = true;
  pendingCat = null;
  renderCatConflict();
  F('store').value = state.lastStore || '';
  setCategory(form.dataset.category || 'papel');
}

function startEdit(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  resetForm();
  editingId = id;
  editThumb = e.thumbId || null;
  fillForm(e);
  renderThumbs();
  $('#t-add').textContent = 'Editar registro';
  $('#btn-save').textContent = 'Salvar alterações';
  $('#btn-cancel-edit').hidden = false;
  go('add');
}

function startReprice(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  resetForm();
  fillForm({ ...e, store: state.lastStore || e.store }, { keepPrice: false });
  editThumb = e.thumbId || null;
  renderThumbs();
  $('#t-add').textContent = 'Novo preço de produto salvo';
  go('add');
  setTimeout(() => F('price').focus(), 200);
}

$('#btn-cancel-edit').addEventListener('click', () => { resetForm(); go('compare'); });
$('#btn-new-product').addEventListener('click', () => {
  resetForm();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('Pronto para o próximo produto');
});

function setPromo(p) {
  promo = p && p.price > 0 ? p : null;
  const b = $('#promo-hint');
  b.hidden = !promo;
  if (promo) {
    b.innerHTML = `🏷️ Promoção na etiqueta: <b>${brl(promo.price)}</b> cada`
      + (promo.minQty > 1 ? ` levando <b>${promo.minQty}</b> ou mais` : '') + '. Toque para usar este preço.';
  }
}
$('#promo-hint').addEventListener('click', () => {
  if (!promo) return;
  F('price').value = money(promo.price);
  F('price').dataset.user = '1';
  F('price').classList.remove('autofilled');
  setPromo(null);
  updateLive();
  toast('Preço promocional aplicado');
});

/** Resultado instantâneo enquanto o usuário digita. */
function updateLive() {
  const out = $('#live-result');
  const e = readForm();
  const base = baseQty(e);
  $('#btn-new-product').hidden = !!editingId || !(photos.length || e.name || F('price').value);
  if (!(e.price > 0) || !(base > 0)) {
    out.innerHTML = '';
    return;
  }
  const c = CATS[e.category];
  const up = e.price / base;
  const visit = currentVisit();
  const peers = state.entries.filter(x => x.visitId === visit.id && x.id !== editingId
    && groupKey(x) === groupKey(e));
  let note = `Total: ${fmtBase(e)} por ${brl(e.price)}`;   // montado aos poucos abaixo
  if (e.category === 'unidade') note = `${fmtN(base)} unidades por ${brl(e.price)}`
    + (isEggs(e) || base % 12 === 0 ? ` · a dúzia sai ${brl(up * 12)}` : '');
  let isBest = false;
  if (peers.length) {
    const best = peers.reduce((a, b) => (unitPrice(a) <= unitPrice(b) ? a : b));
    const bu = unitPrice(best);
    if (up <= bu) {
      isBest = true;
      note += `<br>🏆 <b>Mais barato</b> da visita em “${esc(groupLabel(e))}” (${fmtN((1 - up / bu) * 100, 1)}% abaixo do anterior melhor).`;
    } else {
      note += `<br>${fmtN((up / bu - 1) * 100, 1)}% mais caro que <b>${esc(best.name)}</b>${best.brand ? ' (' + esc(best.brand) + ')' : ''} a ${fmtUnit(bu, best.category)}.`;
    }
  }
  const prev = previousOf({ ...e, id: editingId, visitId: visit.id, createdAt: Date.now() });
  if (prev) {
    note += `<br>Última vez (${fmtDate(prev.createdAt)}): ${fmtUnit(unitPrice(prev), prev.category)} ${trendHtml(up, unitPrice(prev))}`;
    if (baseQty(prev) > base * 1.005) note += `<br>⚠️ <b>Reduflação:</b> antes vinha ${fmtBase(prev)}, agora ${fmtBase(e)}.`;
  }
  const label = e.category === 'unidade' && isEggs(e) ? 'Preço por ovo' : `Preço real por ${c.unitName}`;
  // Promoção por quantidade: mostra as duas contas, porque é assim que se decide.
  if (promo && promo.price > 0 && promo.price !== e.price) {
    const upp = promo.price / base;
    note += `<br>🏷️ Levando ${promo.minQty > 1 ? promo.minQty + ' ou mais' : 'na promoção'}: `
      + `<b>${fmtUnit(upp, e.category)}</b> (${brl(promo.price)} cada, ${fmtN((1 - upp / up) * 100, 1)}% abaixo).`;
  }
  const aviso = sanity(e, peers);
  out.innerHTML = `<div class="result-box ${isBest && !aviso ? 'best' : ''}">
    <div class="muted small">${label}</div>
    <div class="big">${aviso ? '⚠️ confira os dados' : fmtUnit(up, e.category)}</div>
    <div class="note">${aviso ? '' : note}</div></div>`
    + (aviso ? `<div class="sanity">⚠️ ${aviso}</div>` : '');
}
form.addEventListener('input', ev => {
  const el = ev.target;
  if (el.matches?.('input, select')) {
    el.classList.remove('autofilled');
    if (ev.isTrusted) el.dataset.user = '1';   // digitado pelo usuário: a leitura automática não sobrescreve
  }
  updateLive();
});
form.addEventListener('change', updateLive);

// Ao escolher um nome já salvo, completa marca/tipo/quantidade.
F('name').addEventListener('change', () => {
  if (editingId) return;
  const n = norm(F('name').value);
  if (!n) return;
  const known = state.entries.filter(x => norm(x.name) === n).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!known) return;
  const priceTyped = F('price').value;
  const brandTyped = F('brand').value;
  fillForm({ ...known, store: F('store').value || known.store, brand: brandTyped || known.brand }, { keepPrice: false });
  F('price').value = priceTyped;
  updateLive();
  toast('Dados do produto preenchidos a partir do histórico');
});

form.addEventListener('submit', async ev => {
  ev.preventDefault();
  const e = readForm();
  if (!e.name) { toast('Informe o nome do produto'); F('name').focus(); return; }
  if (!(e.price > 0)) { toast('Informe o preço total'); F('price').focus(); return; }
  if (!(baseQty(e) > 0)) { toast('Informe a quantidade da embalagem'); return; }

  const visit = currentVisit();
  const aviso = sanity(e, state.entries.filter(x => x.visitId === visit.id && x.id !== editingId && groupKey(x) === groupKey(e)));
  if (aviso && !confirm(`${aviso}\n\nSalvar assim mesmo?`)) return;

  const prevStore = state.lastStore;
  if (e.store) state.lastStore = e.store;

  // A foto vai para o IndexedDB; no estado fica so o id.
  let thumbId = editThumb || null;
  const novaFoto = photos[0]?.thumb;
  if (novaFoto) {
    const id = uid();
    if (await putThumb(id, novaFoto)) {
      if (thumbId && thumbId !== id) await dropThumb(thumbId);
      thumbId = id;
    } else {
      toast('Não consegui guardar a foto; salvei só os dados.', 3500);
    }
  }

  const old = editingId ? state.entries.find(x => x.id === editingId) : null;
  const backup = old ? { ...old } : null;
  let target;
  if (old) {
    target = old;
      for (const k of ['rolls', 'metersPerRoll', 'qty', 'unit', 'packs', 'count', 'sheets', 'thumb']) delete target[k];
    Object.assign(target, e, { updatedAt: Date.now(), thumbId });
    delete target.promoPrice; delete target.promoMinQty;
    if (promo && promo.price > 0 && promo.price !== e.price) { target.promoPrice = promo.price; target.promoMinQty = promo.minQty || 1; }
  } else {
    target = { ...e, id: uid(), visitId: visit.id, createdAt: Date.now(), thumbId };
    if (promo && promo.price > 0 && promo.price !== e.price) { target.promoPrice = promo.price; target.promoMinQty = promo.minQty || 1; }
    state.entries.push(target);
  }

  if (!save()) {
    // Nada foi gravado: desfaz na memoria para a tela nao mostrar um registro que nao existe.
    if (old) Object.assign(old, backup);
    else state.entries = state.entries.filter(x => x !== target);
    state.lastStore = prevStore;
    if (novaFoto && thumbId) await dropThumb(thumbId);
    toast('Armazenamento cheio! Exporte um backup e limpe o histórico.', 5000);
    return;
  }
  toast(editingId ? 'Alterações salvas ✔️' : 'Produto salvo ✔️');
  const cat = e.category;
  resetForm();
  setCategory(cat);
  compareFilter = 'all';
  go('compare');
});

function renderDatalists() {
  const uniq = arr => [...new Map(arr.filter(Boolean).map(s => [norm(s), s])).values()]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const opt = arr => uniq(arr).map(v => `<option value="${esc(v)}">`).join('');
  $('#dl-names').innerHTML = opt(state.entries.map(e => e.name));
  $('#dl-brands').innerHTML = opt(state.entries.map(e => e.brand));
  $('#dl-types').innerHTML = opt(['Papel higiênico', 'Papel toalha', 'Ovos', 'Arroz', 'Feijão', 'Café', 'Leite', ...state.entries.map(e => e.type)]);
  $('#dl-stores').innerHTML = opt(state.entries.map(e => e.store));
}

function renderReadMode() {
  $('#read-mode').innerHTML = hasAi()
    ? '🤖 Leitura por IA (Claude) ativada.'
    : '🔤 Leitura básica (OCR offline) — erra em muitas etiquetas. <a href="#settings">Ativar leitura por IA</a>';
}

/* =========================================================
   FOTOS: fila de processamento (uma por vez, nunca trava)
   ========================================================= */
let photos = [];                      // { id, thumb, b64, img, status }
let photoQueue = Promise.resolve();

function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Imagem inválida')); };
    img.src = url;
  });
}
function drawScaled(img, max) {
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function renderThumbs() {
  const saved = editThumb ? thumbs.get(editThumb) : null;
  const list = photos.length ? photos : (saved ? [{ id: '', thumb: saved, status: 'salva' }] : []);
  $('#photo-thumbs').innerHTML = list.map(p => `<div class="thumb">
      <img src="${p.thumb}" alt="Foto do produto">
      ${p.status ? `<span class="st">${p.status}</span>` : ''}
      ${p.id ? `<button type="button" class="rm" data-rm="${p.id}" aria-label="Remover foto">×</button>` : ''}
    </div>`).join('');
}
$('#photo-thumbs').addEventListener('click', ev => {
  const b = ev.target.closest('[data-rm]');
  if (!b) return;
  photos = photos.filter(p => p.id !== b.dataset.rm);
  renderThumbs();
  updateLive();
});

function clearPhotos() {
  photos = [];
  renderThumbs();
  $('#ocr-raw').hidden = true;
  $('#ai-notes').hidden = true;
}

function setBusy(msg) {
  const st = $('#ocr-status');
  st.hidden = !msg;
  if (msg) {
    $('#ocr-msg').textContent = msg;
    $('#ocr-progress').removeAttribute('value');
  }
}

async function addPhotoFiles(files) {
  for (const file of files) {
    let img;
    try { img = await loadImage(file); } catch { toast('Não consegui abrir a imagem'); continue; }
    const auto = $('#ocr-auto').checked;
    const photo = {
      id: uid(),
      img,
      // miniatura pequena: e ela que vai para o backup/IndexedDB
      thumb: drawScaled(img, 200).toDataURL('image/jpeg', 0.55),
      // o base64 grande (so a IA usa) e gerado na hora e descartado em seguida
      b64: null,
      status: auto ? 'na fila' : '',
    };
    photos.push(photo);
    renderThumbs();
    updateLive();
    if (auto) {
      photoQueue = photoQueue.then(() => processPhoto(photo)).catch(err => console.error(err));
    } else {
      photo.img = null;    // sem leitura automatica: nao segura a imagem em memoria
    }
  }
}

for (const id of ['in-camera', 'in-gallery']) {
  document.getElementById(id).addEventListener('change', ev => {
    const files = [...ev.target.files];
    ev.target.value = '';   // permite escolher a mesma foto de novo
    addPhotoFiles(files);
  });
}

/** Erro de leitura fica na tela ate ser fechado: o toast some antes de dar para ler. */
function setReadError(msg) {
  const box = $('#read-error');
  if (!box) return;
  box.hidden = !msg;
  if (msg) box.innerHTML = `<span>⚠️ ${esc(msg)}</span><button type="button" aria-label="Fechar">×</button>`;
}
$('#read-error')?.addEventListener('click', ev => { if (ev.target.tagName === 'BUTTON') setReadError(''); });

/** Le a foto com o OCR offline e preenche o formulario. */
async function lerComOcr(photo, { motivo = '' } = {}) {
  photo.status = '🔤';
  photo.b64 = null;
  renderThumbs();
  setBusy(motivo || 'Lendo texto da foto…');
  const { text, lines } = await readWithOcr(photo.img);
  photo.status = '✓';
  $('#ocr-text').textContent = text || '(nenhum texto encontrado)';
  $('#ocr-raw').hidden = false;
  const n = applyParsed(parseLabel(text, lines), { keepText: true });
  return n;
}

async function processPhoto(photo) {
  if (!photos.includes(photo)) return;          // removida enquanto esperava
  try {
    if (hasAi()) {
      // A IA le TODAS as fotos do produto juntas; se ha outra foto na fila, deixa para ela.
      if (photos[photos.length - 1] !== photo) { photo.status = '…'; renderThumbs(); return; }   // o lote final le todas
      const batch = photos.slice(-MAX_AI_PHOTOS).filter(p => p.img || p.b64);
      if (!batch.length) return;
      batch.forEach(p => { p.status = '🤖'; });
      renderThumbs();
      setBusy(`IA lendo ${batch.length} foto${batch.length > 1 ? 's' : ''}…`);
      for (const p of batch) if (!p.b64 && p.img) p.b64 = drawScaled(p.img, 1568).toDataURL('image/jpeg', 0.85).split(',')[1];
      let data;
      try {
        data = await readWithClaude(batch.map(p => p.b64));
      } catch (err) {
        // Plano B: a IA falhou, mas o OCR offline ainda pode preencher alguma coisa.
        console.warn(err);
        batch.forEach(p => { p.b64 = null; });
        setReadError(`${err.message} Usei a leitura básica (OCR) desta vez.`);
        const n = await lerComOcr(photo, { motivo: 'IA indisponível — lendo com o OCR…' });
        toast(n ? `OCR preencheu ${n} campo${n > 1 ? 's' : ''} — confira os amarelos` : 'Não consegui ler. Preencha manualmente.', 4000);
        return;
      } finally {
        batch.forEach(p => { p.b64 = null; p.img = null; });   // libera memoria
      }
      batch.forEach(p => { p.status = '✓'; });
      setReadError('');
      const n = applyParsed(fromAi(data));
      const notes = (data.notes || '').trim();
      $('#ai-notes').hidden = !notes;
      $('#ai-notes').textContent = notes ? '🤖 ' + notes : '';
      toast(n ? `IA preencheu ${n} campo${n > 1 ? 's' : ''} — confira os amarelos` : 'A IA não encontrou dados novos nesta foto', 3500);
    } else {
      setReadError('');
      const n = await lerComOcr(photo);
      toast(n ? `Preenchi ${n} campo${n > 1 ? 's' : ''} — confira os amarelos` : 'Não reconheci dados. Preencha manualmente.', 3500);
    }
  } catch (err) {
    console.error(err);
    photo.status = '⚠️';
    setReadError(err.message || 'Falha na leitura desta foto. Preencha manualmente.');
    toast('Não consegui ler a foto — veja o aviso acima', 4000);
  } finally {
    photo.img = null;      // libera memoria
    renderThumbs();
    setBusy('');
  }
}

/* ---------- leitura por IA (Claude) ---------- */
const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: ['papel', 'peso', 'liquido', 'folha', 'unidade'] },
    name: { type: 'string' },
    brand: { type: 'string' },
    type: { type: 'string' },
    price: { type: 'number' },
    promo_price: { type: 'number' },
    promo_min_qty: { type: 'integer' },
    rolls: { type: 'integer' },
    meters_per_roll: { type: 'number' },
    qty: { type: 'number' },
    unit: { type: 'string', enum: ['g', 'kg', 'ml', 'L', ''] },
    packs: { type: 'integer' },
    count: { type: 'integer' },
    sheets: { type: 'integer' },
    notes: { type: 'string' },
  },
  required: ['category', 'name', 'brand', 'type', 'price', 'promo_price', 'promo_min_qty', 'rolls',
    'meters_per_roll', 'qty', 'unit', 'packs', 'count', 'sheets', 'notes'],
};

const AI_SYSTEM = `You read photos taken inside a Brazilian supermarket so the shopper can compare the real unit price (per metre, kg, litre, 100 sheets or item). All photos in one request show the SAME product: usually the shelf price label, sometimes the package itself (front, back, or an open tray of eggs).

SHELF LABELS IN BRAZIL OFTEN HAVE TWO COLUMNS:
- left: product description and the REGULAR price, in large type;
- right: a dark banner "A partir de 3 UN / a UN sai por:" (or "LEVE 3 PAGUE 2") and the PROMOTIONAL price.
The promotional price is often printed LARGER than the regular one. Never let the banner text or the promotional column leak into name, price or quantities: "3 UN" there is the minimum purchase, NOT how many items are in the package. On a poster, the banner may sit on its own line with the promotional price just below it.
Labels also print the unit price in small type ("Preço por MT R$0,06", "Preço por LT R$2,85", "R$ 19,96 o litro"). That is NEVER the price field - but do use it to sanity-check yourself: price divided by the total quantity should land near it. Beware: the store's "UN" sometimes means one roll or one piece inside the package, so treat it as a hint, not as truth.

Fill every field of the JSON schema:
- category: "papel" for products on rolls compared per metre (toilet paper, aluminium foil, cling film); "folha" for paper towels and napkins counted in sheets ("50F", "360F", "60 toalhas", "100 folhas") - these are compared per 100 sheets, not per metre; "liquido" when the net content is a volume; "peso" when it is a weight; "unidade" for products compared per item (eggs, diapers, wet wipes, tea bags, batteries, towel sets and anything else sold by the piece).
- name: short product name as a shopper would say it, in Portuguese with normal capitalisation, expanding shelf-label abbreviations ("PAP HIG MIL FT 20M" -> "Papel higiênico folha tripla 20 m"; "CERV" -> "Cerveja"; "REFRI" -> "Refrigerante"; "LENCO HIG UMED" -> "Lenço umedecido"; "AGUA SANIT" -> "Água sanitária"; "SALG" -> "Salgadinho"; "FD"/"FT" -> "folha dupla"/"folha tripla"). No price or promotion text in the name.
- brand: the brand, or "" if not visible.
- type: generic product type in Portuguese used to group comparable products. Use the SAME wording for the same kind of product every time, e.g. "Papel higiênico", "Papel toalha", "Ovos", "Arroz", "Café", "Refrigerante", "Cerveja", "Leite", "Água sanitária", "Lenço umedecido". Never answer just "Papel" for toilet paper - two spellings split the ranking and the products stop being compared.
- price: the REGULAR price in BRL for ONE package as sold (the left column), even when the promotional price is bigger on the label. 0 if no price is visible.
- promo_price / promo_min_qty: the promotional price per package and the minimum quantity from the banner ("A partir de 3 UN" -> 3; "LEVE 3 PAGUE 2" -> 3). Otherwise 0 and 0.
- rolls / meters_per_roll: only for "papel". "C/18" or "18 ROLOS" is the number of rolls; "20M" or "30M" is metres per roll. "L32P28" means a pack of 32 rolls sold at the price of 28, so rolls = 32.
- sheets: only for "folha" - sheets per roll ("50F" -> 50, "360F" -> 360, "60 toalhas" -> 60). Use packs for how many rolls come in the package ("C/2" -> 2). Otherwise 0.
- qty / unit / packs: net content of ONE item and how many items come in the package ("12x350ml" -> qty 350, unit "ml", packs 12). Single package -> packs 1. For "papel", "folha" and "unidade" use qty 0, unit "".
- count: only for "unidade" - how many items in the package ("C/48 UN" -> 48, "30 unidades" -> 30, "2P" -> 2 pieces, "dúzia" = 12, "meia dúzia" = 6). If none is printed, count the visible items (e.g. eggs in a tray: rows x columns) and say so in notes. A single item with no count -> 1. Otherwise 0.
- notes: one short sentence in Portuguese for the shopper about anything uncertain or worth knowing (e.g. "Contei 30 ovos (5 x 6).", "O preço de R$ 2,49 vale só a partir de 2 unidades.", "A etiqueta diz R$ 0,06/m, mas são 32 rolos: o metro sai por R$ 0,052."), or "".
If a value is unreadable, use 0 or "" instead of guessing.`;

let sdkPromise = null;
async function getAnthropic() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      let last;
      for (const url of ANTHROPIC_SDK_URLS) {
        try { return (await import(url)).default; } catch (err) { last = err; }
      }
      throw last || new Error('SDK indisponivel');
    })();
    sdkPromise.catch(() => { sdkPromise = null; });
  }
  try {
    return await sdkPromise;
  } catch {
    throw new Error('Nao consegui carregar a leitura por IA (sem internet?). Tente de novo ou preencha manualmente.');
  }
}

function aiErrorMessage(err, Anthropic) {
  const msg = String(err?.message || '');
  if (err instanceof Anthropic.AuthenticationError) return 'Chave da IA inválida. Confira em ⚙️ Configurações.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Sua chave não tem permissão para este modelo.';
  if (err instanceof Anthropic.RateLimitError) return 'Muitas leituras seguidas. Aguarde alguns segundos.';
  if (/credit balance|billing/i.test(msg)) return 'Sem créditos na conta Anthropic. Adicione créditos no console.';
  if (err instanceof Anthropic.APIConnectionError) return 'Sem conexão com a IA. Verifique a internet.';
  if (err instanceof Anthropic.APIError) return `Erro da IA (${err.status ?? '?'}). Preencha manualmente.`;
  return msg || 'Falha na leitura por IA.';
}

async function readWithClaude(images) {
  const Anthropic = await getAnthropic();
  const client = new Anthropic({ apiKey: getApiKey(), dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 90_000 });
  const content = [
    ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
    { type: 'text', text: `${images.length} foto(s) do mesmo produto. Extraia os dados.` },
  ];
  let resp;
  try {
    resp = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',                     // se o modelo recusar, a API tenta outro automaticamente
      output_config: { effort: 'low', format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
      system: AI_SYSTEM,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    throw new Error(aiErrorMessage(err, Anthropic));
  }
  if (resp.stop_reason === 'refusal') throw new Error('A IA não conseguiu ler esta foto. Preencha manualmente.');
  if (resp.parsed_output) return resp.parsed_output;          // structured outputs ja devolve o objeto
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Resposta da IA incompleta. Tente outra foto.');
  }
}

/** Converte a resposta da IA para o formato usado pelo formulário. */
function fromAi(d) {
  const pos = v => (Number.isFinite(v) && v > 0 ? v : undefined);
  return {
    category: CATS[d.category] ? d.category : undefined,
    name: d.name || undefined,
    brand: d.brand || undefined,
    type: d.type || undefined,
    price: pos(d.price),
    promo: pos(d.promo_price) ? { price: d.promo_price, minQty: d.promo_min_qty || 1 } : null,
    rolls: pos(d.rolls),
    metersPerRoll: pos(d.meters_per_roll),
    qty: pos(d.qty),
    unit: d.unit || undefined,
    packs: d.packs > 0 ? d.packs : undefined,
    count: pos(d.count),
    sheets: pos(d.sheets),
  };
}

/* ---------- leitura offline (Tesseract) ---------- */
let ocrWorkerPromise = null;
let ocrLogger = null;
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('Não foi possível carregar o OCR (sem internet?)'));
    document.head.appendChild(s);
  });
}
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      if (!window.Tesseract) await loadScript(TESS_URL);
      return window.Tesseract.createWorker('por', 1, { logger: m => ocrLogger && ocrLogger(m) });
    })();
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
  }
  return ocrWorkerPromise;
}
/** Tons de cinza + contraste: melhora o OCR de etiquetas. */
function preprocess(canvas) {
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    let g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
    g = Math.max(0, Math.min(255, (g - 128) * 1.5 + 128));
    p[i] = p[i + 1] = p[i + 2] = g;
  }
  ctx.putImageData(d, 0, 0);
  return canvas;
}
async function readWithOcr(img) {
  ocrLogger = m => {
    if (m.status === 'recognizing text') { $('#ocr-msg').textContent = 'Lendo texto da foto…'; $('#ocr-progress').value = m.progress; }
    else if (m.status) $('#ocr-msg').textContent = 'Carregando leitor: ' + m.status + '…';
  };
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(preprocess(drawScaled(img, 1800)));
    const lines = (data.lines || []).map(l => ({
      text: l.text.trim(), conf: l.confidence, h: l.bbox ? l.bbox.y1 - l.bbox.y0 : 0,
    }));
    return { text: (data.text || '').trim(), lines };
  } finally {
    ocrLogger = null;
  }
}

/* =========================================================
   PARSER DE ETIQUETA (usado pelo OCR offline)
   A etiqueta das redes brasileiras tem DUAS COLUNAS:
     esquerda = produto + preco normal
     direita  = tarja "A partir de N UN / a UN sai por:" + preco promocional
   Como as colunas dividem a mesma linha de base, o OCR funde as duas numa
   linha so. Por isso o parser separa as colunas ANTES de ler qualquer coisa:
   senao o "3 UN" da promocao vira a quantidade do produto e o preco
   promocional vira o preco normal.
   ========================================================= */

/** Tarja da promocao: marca onde termina a coluna da esquerda. */
const RE_TARJA = /(a\s*partir\s*de\s*\d{1,3}\s*(?:un\w*|pe[cç]as?|cx)?|a\s*un\s*sai\s*por|acima\s*de\s*\d{1,3}\s*un\w*|na\s*compra\s*de\s*\d{1,3}|leve\s*\d{1,3}\s*(?:e\s*)?pague\s*\d{1,3})/i;
const RE_QTD_MIN = /(?:a\s*partir\s*de|acima\s*de|na\s*compra\s*de|levando|leve)\s*(\d{1,3})/i;
const RE_LEVE_PAGUE = /\bleve\s*(\d{1,3})\s*(?:e\s*)?pague\s*(\d{1,3})\b/i;
/** "L32P28" na descricao: pacote de 32 rolos com preco de 28. */
const RE_LPACK = /\bL\s?(\d{1,3})\s?P\s?(\d{1,3})\b/i;

/** Trechos que indicam preco por unidade de medida, e nao o preco do pacote. */
const RE_PRECO_UNITARIO = /(pre[cç]o\s*(por|do|da)\b|\bpor\s*(kg|quilo|quilograma|litro|lt?\b|metro|mt?\b|unidade|unid|un\b|pe[cç]a)|\bo\s*(kg|quilo|litro|metro)\b|\ba\s*unidade\b|\bcada\s*(kg|quilo|litro|metro|100)|\b100\s*(g|gr|ml)\b|\/\s*(kg|quilo|lt?|litro|mt?|metro|un|unid|pe[cç]a)\b)/i;
/** Linha que carrega o preco PROMOCIONAL, mesmo sem a tarja ao lado. */
const RE_LINHA_PROMO = /\bcada\b|sai\s*por|\bpromo|\boferta\b|\bclube\b|\bapp\b|\bsócio|\bsocio\b/i;
/** Linhas que nunca contem o preco do pacote. */
const RE_LIXO = /\b(c[oó]d(igo)?|sku|ref|refer[eê]ncia|validade|val\b|ean|barras|origem|lote|pmtr)\b/i;

/** Abreviacoes de etiqueta -> texto legivel. Ordem importa. */
const ABREVS = [
  [/\bpap(el)?\s*hig(i[eê]n\w*)?\b/gi, 'Papel higiênico'],
  [/\btoalha\s*pap(el)?\b|\bpap(el)?\s*toalha\b/gi, 'Papel toalha'],
  [/\blen[cç]o\w*\s*hig\w*\s*umed\w*\b|\blen[cç]o\w*\s*umed\w*\b/gi, 'Lenço umedecido'],
  [/\b[aá]gua\s*sanit\w*\b/gi, 'Água sanitária'],
  [/\bcerv(eja)?\b/gi, 'Cerveja'],
  [/\brefri(g(erante)?)?\b/gi, 'Refrigerante'],
  [/\bsalg(ado|adinho)?\b/gi, 'Salgadinho'],
  [/\bachoc(olatado)?\b/gi, 'Achocolatado'],
  [/\bdeterg(ente)?\b/gi, 'Detergente'],
  [/\bamac(iante)?\b/gi, 'Amaciante'],
  [/\bsab(ao|ão)\s*(em\s*)?p[oó]\b/gi, 'Sabão em pó'],
  [/\bcond(icionador)?\b/gi, 'Condicionador'],
  [/\bf(ol)?h(a)?\s*dupla\b|\bfd\b/gi, 'folha dupla'],
  [/\bf(ol)?h(a)?\s*tripla\b|\bft\b/gi, 'folha tripla'],
  [/\bf(ol)?h(a)?\s*simples\b|\bfs\b/gi, 'folha simples'],
  [/\bint(egral)?\b(?=\s|$)/gi, 'integral'],
  [/\bdesn(atado)?\b/gi, 'desnatado'],
  [/\bc\/\s*(\d)/gi, 'com $1'],
];

/** Tipo generico canonico: e ele que agrupa os produtos no ranking.
    Sem isso o mesmo papel higienico cai em "Papel" e em "Papel higienico"
    e os dois nunca se comparam. */
const TIPOS = [
  [/papel\s*toalha|toalha\s*de\s*papel/i, 'Papel toalha'],
  [/papel\s*hig|\bpapel\b(?!\s*toalha)/i, 'Papel higiênico'],
  [/guardanapo/i, 'Guardanapo'], [/alum[ií]nio/i, 'Papel alumínio'],
  [/len[cç]o\w*\s*umed/i, 'Lenço umedecido'], [/len[cç]o/i, 'Lenço de papel'],
  [/[aá]gua\s*sanit/i, 'Água sanitária'],
  [/\bovos?\b/i, 'Ovos'], [/\barroz\b/i, 'Arroz'], [/\bfeij[ãa]o\b/i, 'Feijão'],
  [/\bcaf[eé]\b/i, 'Café'], [/\bleite\b/i, 'Leite'],
  [/refrigerante/i, 'Refrigerante'], [/\bcerveja\b/i, 'Cerveja'],
  [/\bsuco\b/i, 'Suco'], [/\b[aá]gua\b/i, 'Água'],
  [/salgadinho|\bchips\b/i, 'Salgadinho'], [/\bbiscoito|bolacha\b/i, 'Biscoito'],
  [/\bfralda/i, 'Fraldas'], [/\bsabonete\b/i, 'Sabonete'], [/detergente/i, 'Detergente'],
  [/\bamaciante\b/i, 'Amaciante'], [/sab[ãa]o\s*em\s*p[óo]/i, 'Sabão em pó'],
  [/\b[oó]leo\b/i, 'Óleo'], [/\ba[cç][uú]car\b/i, 'Açúcar'], [/\bmacarr[ãa]o\b/i, 'Macarrão'],
  [/\bmanteiga\b/i, 'Manteiga'], [/\bqueijo\b/i, 'Queijo'], [/\bfarinha\b/i, 'Farinha'],
  [/jogo\s*(de\s*)?toalha|toalha\s*(de\s*)?banho/i, 'Jogo de toalha'],
  [/\bcarne\b|picanha|alcatra|patinho|coxao/i, 'Carne bovina'],
];
/** Normaliza o que o usuario digitou ou a foto leu para o tipo canonico. */
function tipoCanonico(t) {
  if (!t) return t;
  const achado = TIPOS.find(([re]) => re.test(t));
  return achado ? achado[1] : t.trim();
}

/** Corrige confusoes classicas do OCR em numeros (O/0, l/1, S/5). */
function limpaNum(t) {
  return t.replace(/(?<=\d)[Oo]+/g, m => '0'.repeat(m.length))   // 5OOg -> 500g
          .replace(/[Oo]+(?=\d)/g, m => '0'.repeat(m.length))
          .replace(/(?<=\d)[lI](?=\d)/g, '1')
          .replace(/(?<=\d)[Ss](?=\d)/g, '5');
}

/** Linha com cara de texto de verdade (não lixo do OCR). */
function looksLikeWords(l) {
  const words = l.split(/\s+/).filter(Boolean);
  const letters = (l.match(/\p{L}/gu) || []).length;
  return l.length >= 5 && letters / Math.max(1, l.replace(/\s/g, '').length) >= 0.6
    && words.some(w => w.replace(/[^\p{L}]/gu, '').length >= 3)
    && words.filter(w => w.length <= 2).length <= words.length / 2;
}

/** Valores monetarios de um texto, com o que vem logo depois deles. */
function achaValores(txt) {
  const re = /(R\s*\$)?\s*(\d{1,4}(?:\.\d{3})*,\d{2}|\d{1,4},\d{2}|\d{1,4}\.\d{2})(?!\d)/g;
  const out = [];
  let m;
  while ((m = re.exec(txt))) {
    const depois = txt.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (/^\s*(kg|g|gr|ml|l|lt|m|mts?|un)\b/i.test(depois)) continue;   // quantidade, nao preco
    out.push({ valor: num(m[2]), temCifrao: !!m[1], idx: m.index, depois });
  }
  return out;
}

/** Separa cada linha em coluna normal (esquerda) e coluna da promocao (direita).
    Dois layouts aparecem na pratica:
      a) duas colunas na mesma linha  -> "PAPEL HIG PERSONAL FD | A partir de 2 UN"
      b) tarja sozinha e o preco promocional na linha DE BAIXO (cartaz de oferta)
    No caso (b) a linha seguinte tambem pertence a promocao. */
function separaColunas(ls) {
  const esq = [], dir = [];
  let tarjaSozinhaAcima = false;
  for (const l of ls) {
    const m = l.text.match(RE_TARJA);
    if (m && m.index > 0) {
      esq.push({ ...l, text: l.text.slice(0, m.index).trim() });
      dir.push({ ...l, text: l.text.slice(m.index).trim() });
      tarjaSozinhaAcima = false;
    } else if (m) {
      dir.push(l);
      tarjaSozinhaAcima = !achaValores(l.text).length;   // tarja sem preco: o preco vem abaixo
    } else if (tarjaSozinhaAcima && achaValores(l.text).length && !RE_PRECO_UNITARIO.test(l.text)) {
      dir.push(l);
      tarjaSozinhaAcima = false;
    } else {
      esq.push(l);
      tarjaSozinhaAcima = false;
    }
  }
  return { esq: esq.filter(l => l.text), dir: dir.filter(l => l.text) };
}

/** Nota de um valor como "preco do pacote" desta linha. */
function notaPreco(v, l, maxH) {
  if (RE_PRECO_UNITARIO.test(v.depois)) return null;        // "12,99 / kg"
  if (RE_PRECO_UNITARIO.test(l.text)) return null;          // "Preço por MT R$0,06"
  if (RE_LIXO.test(l.text)) return null;
  const alt = (l.h || 0) / maxH;
  let nota = 4 + (v.temCifrao ? 2 : 0) + alt * 6;
  if (v.valor < 0.2) nota -= 3;                             // pacote raramente custa < R$0,20
  if (RE_LINHA_PROMO.test(l.text)) nota -= 7;               // "R$ 25,90 CADA" e o preco promocional
  return nota;
}

/** Como melhorPreco, mas sem descontar a penalidade de linha promocional:
    serve para escolher o melhor valor DENTRO da propria promocao. */
function melhorPrecoBruto(ls, maxH) {
  let melhor = null;
  for (const l of ls) {
    for (const v of achaValores(l.text)) {
      if (RE_PRECO_UNITARIO.test(v.depois) || RE_PRECO_UNITARIO.test(l.text) || RE_LIXO.test(l.text)) continue;
      const nota = 4 + (v.temCifrao ? 2 : 0) + ((l.h || 0) / maxH) * 6;
      if (!melhor || nota > melhor.nota) melhor = { ...v, nota, linha: l.text };
    }
  }
  return melhor;
}

/** Melhor candidato a preco entre um conjunto de linhas. */
function melhorPreco(ls, maxH) {
  let melhor = null;
  for (const l of ls) {
    for (const v of achaValores(l.text)) {
      const nota = notaPreco(v, l, maxH);
      if (nota == null) continue;
      if (!melhor || nota > melhor.nota) melhor = { ...v, nota, linha: l.text, alt: (l.h || 0) / maxH };
    }
  }
  return melhor;
}

/** Extrai preço, quantidades e categoria do texto do OCR. */
function parseLabel(raw, lines = []) {
  const out = {};
  const ls = (lines.length ? lines : raw.split('\n').map(text => ({ text, conf: 100, h: 0 })))
    .map(l => ({ ...l, text: limpaNum((l.text || '').trim()) }))
    .filter(l => l.text);
  const maxH = Math.max(1, ...ls.map(l => l.h || 0));
  const { esq, dir } = separaColunas(ls);

  // Texto SO da coluna normal: quantidades e nome saem daqui, nunca da tarja.
  const flat = esq.map(l => l.text).join(' ').replace(/\s+/g, ' ');
  const flatTudo = ls.map(l => l.text).join(' ').replace(/\s+/g, ' ');
  let flatExp = flat;
  for (const [re, sub] of ABREVS) flatExp = flatExp.replace(re, sub);

  /* ---------- preço normal e preço promocional ---------- */
  const temTarja = ls.some(l => RE_TARJA.test(l.text));
  const melhor = melhorPreco(esq, maxH);
  if (melhor) out.price = melhor.valor;

  let promoVal = melhorPreco(dir, maxH);
  // Quando as duas colunas caem na mesma linha ("R$ 49,90 R$ 48,49"), a da
  // esquerda e o preco normal e a da direita e o promocional.
  if (temTarja && melhor && !promoVal) {
    for (const l of esq) {
      const vs = achaValores(l.text).filter(v => notaPreco(v, l, maxH) != null);
      if (vs.length >= 2 && vs.some(v => v.valor === melhor.valor)) {
        const depois = vs.filter(v => v.idx > melhor.idx);
        if (depois.length) promoVal = depois[0];
        break;
      }
    }
  }
  if (temTarja && !promoVal) {
    // Promocao em linha propria ("A PARTIR DE 2 UN" / "R$ 25,90 CADA"), sem duas colunas.
    const linhasPromo = esq.filter(l => RE_LINHA_PROMO.test(l.text));
    const cand = melhorPrecoBruto(linhasPromo, maxH);
    if (cand && cand.valor !== (melhor && melhor.valor)) promoVal = cand;
  }
  const mLeve = flatTudo.match(RE_LEVE_PAGUE);
  const mMin = (dir.map(l => l.text).join(' ') || flatTudo).match(RE_QTD_MIN);
  if (promoVal && promoVal.valor > 0 && promoVal.valor !== out.price) {
    out.promo = { price: promoVal.valor, minQty: mMin ? +mMin[1] : (mLeve ? +mLeve[1] : 1) };
  } else if (mLeve && out.price > 0) {
    out.promo = { price: out.price * (+mLeve[2] / +mLeve[1]), minQty: +mLeve[1] };
  }

  /* ---------- quantidades (só da coluna normal) ---------- */
  const lpack = flat.match(RE_LPACK);                       // L32P28 -> 32 rolos
  const mult = flat.match(/(\d{1,2})\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|gr|ml|l|lt)\b/i)
    || flat.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|ml|l|lt)\b\s*[x×]\s*(\d{1,2})\b/i);
  const multInv = mult && /^\d+(?:[.,]\d+)?$/.test(mult[1]) && /^(kg|g|gr|ml|l|lt)$/i.test(mult[2]);
  const peso = flat.match(/(\d+(?:[.,]\d+)?)\s*(kg|quilos?|kgs|g|gr|gramas?)\b/i);
  const volume = flat.match(/(\d+(?:[.,]\d+)?)\s*(ml|mls|l|lt|litros?)\b/i);
  const rolos = flat.match(/(\d{1,3})\s*(rolos?|rls?)\b(?!\s*\$)/i)
    || flat.match(/\bc\/\s*(\d{1,3})\b/i) || flat.match(/\bcom\s*(\d{1,3})\s*rolos?\b/i);
  const metros = flat.match(/(\d{1,3}(?:[.,]\d{1,2})?)\s*(m|mts?|metros?)\b/i);
  // "50F" / "360 folhas": papel toalha e vendido por folha, nao por metro.
  const folhas = flat.replace(RE_LPACK, ' ').match(/(\d{2,4})\s*(?:f\b|fls?\b|folhas?\b|toalhas?\b)/i);
  // "2P" = 2 pecas (jogo de toalha). Ignora o P de L32P28.
  const pecas = flat.replace(RE_LPACK, ' ').match(/(\d{1,2})\s*(?:p\b|pe[cç]as?\b)/i);
  const unids = flat.match(/(\d{1,3})\s*(unidades?|unid\.?|un\b|und\b|ovos|fraldas?|c[aá]psulas?|sach[eê]s?)\b/i)
    || flat.match(/\b(?:c\/|com|contendo|bandeja\s*c?\/?)\s*(\d{1,3})\s*(?:unidades?|unid|un\b|ovos)?/i);
  const ovos = /\bovos?\b/i.test(flatExp);
  const duzia = /meia\s*d[uú]zia/i.test(flat) ? 6 : /d[uú]zia/i.test(flat) ? 12 : 0;
  const ehToalhaPapel = /papel\s*toalha|toalha\s*de\s*papel/i.test(flatExp);
  const ehPapelRolo = /papel\s*higi|papel\b|rolo|guardanapo|alum[ií]nio|pvc|filme/i.test(flatExp) && !ehToalhaPapel;

  if (ovos || (duzia && !peso && !volume)) {
    out.category = 'unidade';
    out.count = unids ? num(unids[1]) : duzia || undefined;
  } else if (ehToalhaPapel && folhas) {
    out.category = 'folha';
    out.sheets = num(folhas[1]);
    if (rolos) out.packs = num(rolos[1]);
  } else if (ehPapelRolo && (rolos || metros || lpack)) {
    out.category = 'papel';
    if (lpack) out.rolls = num(lpack[1]);                   // leve 32 pague 28 -> 32 rolos
    else if (rolos) out.rolls = num(rolos[1]);
    if (metros) out.metersPerRoll = num(metros[1]);
  } else if (mult) {
    const packs = num(multInv ? mult[3] : mult[1]);
    const qty = num(multInv ? mult[1] : mult[2]);
    const un = (multInv ? mult[2] : mult[3]).toLowerCase();
    const liquido = /^(ml|l|lt)$/.test(un);
    out.category = liquido ? 'liquido' : 'peso';
    out.packs = packs;
    out.qty = qty;
    out.unit = liquido ? (un === 'ml' ? 'ml' : 'L') : (un === 'kg' ? 'kg' : 'g');
  } else if (volume) {
    out.category = 'liquido';
    out.qty = num(volume[1]);
    out.unit = /^ml/i.test(volume[2]) ? 'ml' : 'L';
  } else if (peso) {
    out.category = 'peso';
    out.qty = num(peso[1]);
    out.unit = /^(kg|quilo)/i.test(peso[2]) ? 'kg' : 'g';
  } else if (folhas) {
    out.category = 'folha';
    out.sheets = num(folhas[1]);
    if (rolos) out.packs = num(rolos[1]);
  } else if (unids) {
    out.category = 'unidade';
    out.count = num(unids[1]);
  } else if (pecas) {
    out.category = 'unidade';
    out.count = num(pecas[1]);
  }

  /* ---------- confere contra o preço por unidade impresso na etiqueta ----------
     A etiqueta imprime "Preço por MT R$0,06" / "Preço por LT R$2,85". Se o
     preco escolhido nao bate com isso vezes a quantidade, troca por um
     candidato que feche a conta. */
  const mUnit = flatTudo.match(/pre[cç]o\s*(?:por|do|da)\s*(kg|lt?|mt?|un\w*|litro|metro|quilo)\s*(?:R\s*\$)?\s*(\d{1,4}(?:\.\d{3})*,\d{2})/i)
    || flatTudo.match(/(R\s*\$)?\s*(\d{1,4}(?:\.\d{3})*,\d{2})\s*(?:\/|\bo\b|\bpor\b|\ba\b|\bcada\b)\s*(kg|quilo|litro|lt?\b|metro|mt?\b|unidade|un\b)/i);
  const UNID_CAT = { kg: 'peso', quilo: 'peso', l: 'liquido', lt: 'liquido', litro: 'liquido',
                     m: 'papel', mt: 'papel', metro: 'papel', un: 'unidade', unidade: 'unidade' };
  if (mUnit && out.category) {
    const unidLabel = (mUnit[1] && !mUnit[1].includes('$') ? mUnit[1] : mUnit[3] || '').toLowerCase().replace(/[^a-zç]/g, '');
    const valorUnit = num(mUnit[2].includes(',') ? mUnit[2] : mUnit[3]);
    // A loja imprime "por UN" tanto para rolo quanto para pacote: so vale se
    // a unidade dela for a mesma medida que o app usa para esta categoria.
    if (UNID_CAT[unidLabel] !== out.category) { out.unitPriceLabel = valorUnit; }
    else {
    const base = baseQty({
      category: out.category, rolls: out.rolls, metersPerRoll: out.metersPerRoll,
      qty: out.qty, unit: out.unit, packs: out.packs || 1, count: out.count, sheets: out.sheets,
    });
    const esperado = valorUnit * base;
    if (Number.isFinite(esperado) && esperado > 0) {
      const todos = ls.flatMap(l => achaValores(l.text).map(v => v.valor));
      const perto = todos.filter(v => Math.abs(v / esperado - 1) <= 0.12)
        .sort((a, b) => Math.abs(a - esperado) - Math.abs(b - esperado))[0];
      if (perto && (!(out.price > 0) || Math.abs(out.price / esperado - 1) > 0.25)) out.price = perto;
    }
    }
  }

  /* ---------- tipo, marca e nome ---------- */
  out.type = tipoCanonico((TIPOS.find(([re]) => re.test(flatExp)) || [])[1]);
  if (out.category === 'unidade' && ovos) out.type = 'Ovos';

  const marcas = [...new Set(state.entries.map(e => e.brand).filter(b => b && b.length > 1))];
  const nflat = norm(flat);
  out.brand = marcas.find(b => new RegExp(`\\b${norm(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(nflat));

  // Nome: so da coluna da esquerda, a linha mais alta com cara de texto.
  const cands = esq
    .filter(l => (l.conf ?? 100) >= 60 && !RE_LIXO.test(l.text) && !RE_PRECO_UNITARIO.test(l.text))
    .map(l => ({ h: l.h || 0, t: l.text.replace(/[^\p{L}\d\s.,%\/-]/gu, ' ').replace(/\s+/g, ' ').trim() }))
    .filter(l => looksLikeWords(l.t) && !/R\s?\$|\d+,\d{2}|pre[cç]o|oferta|promo/i.test(l.t));
  if (cands[0]) {
    let nome = cands[0].t;
    for (const [re, sub] of ABREVS) nome = nome.replace(re, sub);
    nome = nome.toLowerCase().replace(/\s+/g, ' ').trim()
      .replace(/(^|\s)\p{L}/gu, s => s.toUpperCase());
    out.name = nome;
  }
  return out;
}

let pendingCat = null;   // leitura de outra categoria aguardando confirmacao

/** Aviso "a leitura indica outra categoria" acima do formulario. */
function renderCatConflict() {
  const b = $('#cat-conflict');
  if (!b) return;
  b.hidden = !pendingCat;
  if (pendingCat) {
    b.innerHTML = `A leitura indica <b>${CATS[pendingCat.cat].short}</b> (por ${CATS[pendingCat.cat].unit}), `
      + 'mas você já preencheu quantidades nesta categoria. Toque para trocar e usar os dados lidos.';
  }
}

/**
 * Preenche o formulário com dados lidos da foto.
 * Sobrescreve o que foi preenchido automaticamente antes (fotos novas corrigem as antigas),
 * mas nunca o que o usuário digitou. Campos alterados ficam em amarelo.
 */
function applyParsed(p, { keepText = false } = {}) {
  let count = 0;
  // keepText (OCR): nome/marca só entram se o campo ainda estiver vazio
  if (keepText) {
    if (F('name').value.trim()) delete p.name;
    if (F('brand').value.trim()) delete p.brand;
  }
  const canWrite = el => el.dataset.user !== '1';
  const set = (id, val, fmt = v => v) => {
    const el = F(id);
    if (val == null || val === '' || (typeof val === 'number' && !Number.isFinite(val))) return;
    if (!canWrite(el)) return;
    const v = String(fmt(val));
    if (el.tagName === 'SELECT') { el.value = v; return; }
    if (el.value === v) return;
    el.value = v;
    el.classList.add('autofilled');
    count++;
  };
  const qtyIds = { papel: ['rolls', 'mpr'], peso: ['wqty', 'wpacks'], liquido: ['vqty', 'vpacks'], folha: ['sheets', 'fpacks'], unidade: ['count'] };
  const curCat = form.dataset.category;
  const userTypedQty = qtyIds[curCat].some(id => F(id).dataset.user === '1');
  const conflito = p.category && p.category !== curCat && userTypedQty;
  if (p.category && p.category !== curCat && !userTypedQty) setCategory(p.category);
  const cat = form.dataset.category;

  set('price', p.price, money);
  set('name', p.name);
  set('brand', p.brand);
  set('type', tipoCanonico(p.type));
  // Houve leitura de outra categoria, mas voce ja tinha digitado quantidades aqui:
  // em vez de descartar calado, oferece a troca.
  if (conflito) pendingCat = { parsed: p, cat: p.category };
  else pendingCat = null;
  renderCatConflict();
  if (p.category === cat) {
    if (cat === 'papel') { set('rolls', p.rolls); set('mpr', p.metersPerRoll, v => fmtN(v, 2)); }
    if (cat === 'peso' || cat === 'liquido') {
      const [q, u, k] = cat === 'peso' ? ['wqty', 'wunit', 'wpacks'] : ['vqty', 'vunit', 'vpacks'];
      set(u, p.unit);
      set(q, p.qty, v => fmtN(v, 3));
      if (p.packs > 1) set(k, p.packs);
      else if (p.packs === 1 && canWrite(F(k))) F(k).value = '';
    }
    if (cat === 'folha') { set('sheets', p.sheets); if (p.packs > 1) set('fpacks', p.packs); }
    if (cat === 'unidade') set('count', p.count);
  }
  if (p.promo !== undefined) setPromo(p.promo);
  updateLive();
  return count;
}

/* =========================================================
   VIEW: CONFIGURAÇÕES (chave da IA)
   ========================================================= */
function renderSettings() {
  const key = getApiKey();
  $('#s-key').value = key;
  $('#key-status').textContent = key ? '✔️ Chave salva neste celular.' : 'Nenhuma chave salva — usando leitura básica (OCR).';
}
$('#btn-key-save').addEventListener('click', async () => {
  const key = $('#s-key').value.trim();
  const st = $('#key-status');
  if (!key.startsWith('sk-')) { st.textContent = '⚠️ A chave deve começar com "sk-".'; return; }
  try { localStorage.setItem(KEY_STORAGE, key); } catch { st.textContent = '⚠️ Não consegui salvar.'; return; }
  st.textContent = 'Testando a chave…';
  try {
    const Anthropic = await getAnthropic();
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1 });
    await client.models.retrieve(AI_MODEL);       // não gasta créditos
    st.textContent = '✅ Chave válida! A leitura por IA está ativada.';
  } catch (err) {
    const Anthropic = await getAnthropic().catch(() => null);
    st.textContent = '⚠️ ' + (Anthropic ? aiErrorMessage(err, Anthropic) : err.message) + ' (a chave ficou salva).';
  }
});
$('#btn-key-remove').addEventListener('click', () => {
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignora */ }
  renderSettings();
  toast('Chave removida — usando leitura básica');
});

/* =========================================================
   VIEW: HISTÓRICO
   ========================================================= */
let historyFilter = 'all';
$('#h-search').addEventListener('input', () => renderHistory());

function renderHistory() {
  renderChips($('#history-filter'), historyFilter, k => { historyFilter = k; renderHistory(); });
  const q = norm($('#h-search').value);
  const map = new Map();
  for (const e of state.entries) {
    const k = productKey(e);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  const visitId = state.currentVisitId;
  let prods = [...map.values()].map(l => l.sort((a, b) => b.createdAt - a.createdAt));
  prods = prods.filter(l => {
    const e = l[0];
    if (historyFilter !== 'all' && e.category !== historyFilter) return false;
    if (!q) return true;
    return l.some(x => norm([x.name, x.brand, x.type, x.store].join(' ')).includes(q));
  }).sort((a, b) => b[0].createdAt - a[0].createdAt);

  $('#history-count').textContent = `${prods.length} produto${prods.length === 1 ? '' : 's'} · ${state.entries.length} registro${state.entries.length === 1 ? '' : 's'} de preço`;

  const list = $('#history-list');
  if (!prods.length) {
    list.innerHTML = `<div class="card empty"><span class="big-ico">📒</span>${state.entries.length ? 'Nada encontrado.' : 'Seu histórico está vazio.'}</div>`;
    return;
  }

  list.innerHTML = prods.map(l => {
    const last = l[0], cat = last.category, ups = l.map(unitPrice);
    const prevOther = l.find(x => x.visitId !== last.visitId);
    const thumb = l.map(thumbOf).find(Boolean);
    const entries = l.map(x => `<li>
        <span class="when">${fmtDate(x.createdAt)}${x.visitId === visitId ? '<span class="cur">visita atual</span>' : ''}</span>
        <span class="acts">
          <button class="icon-btn" data-act="edit" data-id="${x.id}" aria-label="Editar">✏️</button>
          <button class="icon-btn" data-act="del" data-id="${x.id}" aria-label="Excluir registro">🗑️</button>
        </span>
        <span class="det">${x.store ? esc(x.store) + ' · ' : ''}${brl(x.price)} · ${describeQty(x)} → <b>${fmtUnit(unitPrice(x), cat)}</b></span>
      </li>`).join('');
    return `<details class="card prod">
      <summary>
        <span class="t">
          ${thumb ? `<img src="${thumb}" alt="" style="width:36px;height:36px;border-radius:8px;object-fit:cover;float:left;margin-right:10px">` : ''}
          <strong>${CATS[cat].icon} ${esc(last.name)}</strong>
          <small>${esc(last.brand || 'Sem marca')} · ${esc(groupLabel(last))} · ${l.length} registro${l.length > 1 ? 's' : ''}</small>
        </span>
        <span class="r">
          <b>${fmtUnit(unitPrice(last), cat)}</b>
          <small>${fmtDate(last.createdAt)} ${prevOther ? trendHtml(unitPrice(last), unitPrice(prevOther)) : ''}</small>
        </span>
      </summary>
      <div class="prod-body">
        <div class="stats">
          <div>Menor<b>${fmtUnit(Math.min(...ups), cat)}</b></div>
          <div>Maior<b>${fmtUnit(Math.max(...ups), cat)}</b></div>
          <div>Último pago<b>${brl(last.price)}</b></div>
        </div>
        ${historyNote(last)}
        <ul class="entries">${entries}</ul>
        <div class="row-actions">
          <button class="btn btn-primary btn-sm" data-act="reprice" data-id="${last.id}">➕ Registrar preço de hoje</button>
          <button class="btn btn-danger btn-sm" data-act="delprod" data-id="${last.id}">Excluir produto</button>
        </div>
      </div>
    </details>`;
  }).join('');
}

/* ---------- ações (delegação) ---------- */
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  if (act === 'edit') startEdit(id);
  else if (act === 'reprice') startReprice(id);
  else if (act === 'del') {
    if (!confirm(`Excluir o registro de “${e.name}” (${brl(e.price)} em ${fmtDate(e.createdAt)})?`)) return;
    state.entries = state.entries.filter(x => x.id !== id);
    save(); refresh(); pruneThumbs(); toast('Registro excluído');
  } else if (act === 'delprod') {
    const k = productKey(e);
    const n = state.entries.filter(x => productKey(x) === k).length;
    if (!confirm(`Excluir “${e.name}” e todos os ${n} registros de preço?`)) return;
    state.entries = state.entries.filter(x => productKey(x) !== k);
    save(); refresh(); pruneThumbs(); toast('Produto excluído');
  }
});
function refresh() {
  const v = location.hash.slice(1);
  if (v === 'history') renderHistory(); else renderCompare();
}

/** Apaga visitas anteriores, ou tudo. `tudo` vem de botoes distintos: sem dialogo ambiguo. */
async function limparHistorico(tudo) {
  if (!state.entries.length) { toast('Histórico já está vazio'); return; }
  if (tudo) {
    const n = state.entries.length;
    if (!confirm(`Apagar TODO o histórico (${n} registro${n === 1 ? '' : 's'}), inclusive a visita atual?\n\nIsso não pode ser desfeito. Exporte um backup antes se quiser guardar.`)) return;
    state = { entries: [], visits: [], currentVisitId: null, lastStore: state.lastStore };
  } else {
    const n = state.entries.filter(e => e.visitId !== state.currentVisitId).length;
    if (!n) { toast('Não há visitas anteriores para apagar'); return; }
    if (!confirm(`Apagar ${n} registro${n === 1 ? '' : 's'} de visitas anteriores?\n\nOs produtos da visita atual continuam salvos.`)) return;
    state.entries = state.entries.filter(e => e.visitId === state.currentVisitId);
    state.visits = state.visits.filter(v => v.id === state.currentVisitId);
  }
  save(); renderHistory(); await pruneThumbs(); toast('Histórico limpo');
}
$('#btn-clear-old').addEventListener('click', () => limparHistorico(false));
$('#btn-clear-all').addEventListener('click', () => limparHistorico(true));

$('#btn-export').addEventListener('click', () => {
  // As fotos vivem no IndexedDB; vao junto no backup para ele ser completo.
  const fotos = {};
  for (const e of state.entries) if (e.thumbId && thumbs.has(e.thumbId)) fotos[e.thumbId] = thumbs.get(e.thumbId);
  const blob = new Blob([JSON.stringify({ ...state, thumbs: fotos }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `preco-real-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

/** Um registro do backup so entra se der para calcular o preco unitario dele. */
function entryValido(e) {
  if (!e || typeof e !== 'object' || !e.id || !CATS[e.category]) return false;
  if (!(Number(e.price) > 0) || !e.name) return false;
  const limpo = {
    category: e.category, price: Number(e.price),
    rolls: Number(e.rolls), metersPerRoll: Number(e.metersPerRoll),
    qty: Number(e.qty), unit: e.unit, packs: Number(e.packs) || 1, count: Number(e.count),
  };
  return Number.isFinite(baseQty(limpo)) && baseQty(limpo) > 0;
}

$('#in-import').addEventListener('change', async ev => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.entries)) throw new Error('formato');

    const ids = new Set(state.entries.map(e => e.id));
    const candidatos = data.entries.filter(e => e && e.id && !ids.has(e.id));
    const fresh = candidatos.filter(entryValido);
    const descartados = candidatos.length - fresh.length;

    // Visitas: traz as do backup e cria uma avulsa para registros orfaos,
    // senao eles ficariam invisiveis na tela "Comparar".
    const vids = new Set(state.visits.map(v => v.id));
    const novasVisitas = (data.visits || []).filter(v => v && v.id && !vids.has(v.id));
    state.visits.push(...novasVisitas);
    const todas = new Set(state.visits.map(v => v.id));
    let avulsa = null;
    for (const e of fresh) {
      if (todas.has(e.visitId)) continue;
      if (!avulsa) {
        avulsa = { id: uid(), startedAt: Math.min(...fresh.map(x => x.createdAt || Date.now())), imported: true };
        state.visits.push(avulsa);
        todas.add(avulsa.id);
      }
      e.visitId = avulsa.id;
    }

    state.entries.push(...fresh);
    if (!save()) throw new Error('quota');

    // Fotos do backup (formato novo) ou embutidas em e.thumb (formato antigo).
    for (const e of fresh) {
      const foto = (data.thumbs && e.thumbId && data.thumbs[e.thumbId]) || e.thumb;
      delete e.thumb;
      if (!foto) continue;
      const id = e.thumbId || uid();
      if (await putThumb(id, foto)) e.thumbId = id; else delete e.thumbId;
    }
    save();

    renderHistory();
    toast(`${fresh.length} registro${fresh.length === 1 ? '' : 's'} importado${fresh.length === 1 ? '' : 's'}`
      + (descartados ? ` · ${descartados} ignorado${descartados === 1 ? '' : 's'} (dados incompletos)` : ''), 4000);
  } catch (err) {
    toast(err.message === 'quota' ? 'Armazenamento cheio: não consegui importar.' : 'Arquivo de backup inválido');
  }
});

/* ---------- PWA: instalação + service worker ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', ev => {
  ev.preventDefault();
  deferredPrompt = ev;
  $('#btn-install').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('#btn-install').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#btn-install').hidden = true; toast('App instalado! 🎉'); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      // Avisa quando uma versao nova do app estiver pronta.
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Nova versão disponível — toque para atualizar', 8000);
            $('#toast').onclick = () => { sw.postMessage('skip-waiting'); location.reload(); };
          }
        });
      });
    } catch (err) { console.warn(err); }
  });
}

$('#cat-conflict')?.addEventListener('click', () => {
  if (!pendingCat) return;
  const { parsed, cat } = pendingCat;
  pendingCat = null;
  // a troca e pedida por voce: limpa a marca de "digitado" das quantidades
  for (const id of ['rolls', 'mpr', 'wqty', 'wpacks', 'vqty', 'vpacks', 'count']) delete F(id).dataset.user;
  setCategory(cat);
  applyParsed({ ...parsed, name: undefined, brand: undefined, type: undefined, price: undefined });
  renderCatConflict();
  toast('Categoria trocada com os dados lidos');
});

/* ---------- inicialização ---------- */
resetForm();
setCategory('papel');
showView(location.hash.slice(1) || 'compare');

// As fotos vem do IndexedDB (assincrono): quando chegarem, redesenha.
(async () => {
  await loadThumbs();
  const movidas = await migrateThumbs();     // backups/estado no formato antigo
  if (movidas) console.info(`${movidas} foto(s) movida(s) do localStorage para o IndexedDB`);
  await pruneThumbs();
  refresh();
})();
