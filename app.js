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
/** Quantidade total na unidade padrão (m, kg, L ou un). */
function baseQty(e) {
  const packs = e.packs > 0 ? e.packs : 1;
  switch (e.category) {
    case 'papel':   return e.rolls * e.metersPerRoll;
    case 'peso':    return e.qty * (e.unit === 'g' ? 0.001 : 1) * packs;
    case 'liquido': return e.qty * (e.unit === 'ml' ? 0.001 : 1) * packs;
    case 'unidade': return e.count;
  }
  return NaN;
}
const unitPrice = e => e.price / baseQty(e);
const isEggs = e => /\bovos?\b/.test(norm(`${e.type} ${e.name}`));

function describeQty(e) {
  const packs = e.packs > 1 ? `${fmtN(e.packs)} × ` : '';
  switch (e.category) {
    case 'papel': return `${fmtN(e.rolls)} rolo${e.rolls > 1 ? 's' : ''} × ${fmtN(e.metersPerRoll)} m = ${fmtN(baseQty(e))} m`;
    case 'peso':
    case 'liquido': return `${packs}${fmtN(e.qty, 3)} ${e.unit}`;
    case 'unidade': return `${fmtN(e.count)} un`;
  }
  return '';
}
const fmtBase = e => `${fmtN(baseQty(e), 3)} ${CATS[e.category].unit}`;

const productKey = e => [e.category, norm(e.name), norm(e.brand)].join('|');
const groupLabel = e => (e.type || '').trim() || CATS[e.category].short;
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
  const sorted = g.items.slice().sort((a, b) => unitPrice(a) - unitPrice(b));
  const best = unitPrice(sorted[0]);
  const worst = unitPrice(sorted[sorted.length - 1]);
  const multi = sorted.length > 1;

  const lis = sorted.map((e, i) => {
    const up = unitPrice(e);
    const diff = (up / best - 1) * 100;
    const isBest = i === 0 && multi;
    const pic = thumbOf(e);
    return `<li class="item ${isBest ? 'best' : ''} ${pic ? 'has-pic' : ''}">
      <span class="pos">${i + 1}</span>
      ${pic ? `<img class="pic" src="${pic}" alt="">` : ''}
      <div class="info">
        ${isBest ? '<span class="badge">Melhor custo-benefício</span>' : ''}
        <strong>${esc(e.name)}</strong>
        <small>${esc(e.brand || 'Sem marca')} · ${describeQty(e)} · ${brl(e.price)}${isEggs(e) ? ` · dúzia ${brl(up * 12)}` : ''}</small>
      </div>
      <div class="up">
        <b>${fmtUnit(up, e.category)}</b>
        ${multi ? (i === 0 ? '<small>mais barato</small>' : `<small>+${fmtN(diff, 1)}%</small>`) : ''}
      </div>
      ${multi ? `<div class="bar"><i style="width:${Math.max(6, (up / worst) * 100).toFixed(1)}%"></i></div>` : ''}
      <div class="extra">${historyNote(e)}</div>
      <div class="tools">
        <button class="icon-btn" data-act="edit" data-id="${e.id}" aria-label="Editar">✏️</button>
        <button class="icon-btn" data-act="del" data-id="${e.id}" aria-label="Remover">🗑️</button>
      </div>
    </li>`;
  }).join('');

  const saving = multi && worst > best
    ? `<div class="saving">💡 O mais barato custa <b>${fmtN((1 - best / worst) * 100, 1)}% menos</b> por ${c.unitName} que o mais caro.</div>`
    : (multi ? '' : `<p class="muted small">Adicione outro produto do tipo “${esc(g.label)}” para comparar.</p>`);

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
  F('type').placeholder = { papel: 'Ex.: Papel higiênico', peso: 'Ex.: Arroz', liquido: 'Ex.: Refrigerante', unidade: 'Ex.: Ovos' }[cat];
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
  let note = `Total: ${fmtN(base, 3)} ${c.unit} por ${brl(e.price)}`;
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
    if (baseQty(prev) > base * 1.005) note += `<br>⚠️ <b>Reduflação:</b> antes vinha ${fmtBase(prev)}, agora ${fmtN(base, 3)} ${c.unit}.`;
  }
  const label = e.category === 'unidade' && isEggs(e) ? 'Preço por ovo' : `Preço real por ${c.unitName}`;
  out.innerHTML = `<div class="result-box ${isBest ? 'best' : ''}">
    <div class="muted small">${label}</div>
    <div class="big">${fmtUnit(up, e.category)}</div>
    <div class="note">${note}</div></div>`;
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
    for (const k of ['rolls', 'metersPerRoll', 'qty', 'unit', 'packs', 'count', 'thumb'] ) delete target[k];
    Object.assign(target, e, { updatedAt: Date.now(), thumbId });
  } else {
    target = { ...e, id: uid(), visitId: visit.id, createdAt: Date.now(), thumbId };
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

async function processPhoto(photo) {
  if (!photos.includes(photo)) return;          // removida enquanto esperava
  try {
    if (hasAi()) {
      // A IA lê TODAS as fotos do produto juntas; se há outra foto na fila, deixa para ela.
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
      } finally {
        batch.forEach(p => { p.b64 = null; p.img = null; });   // libera memoria
      }
      batch.forEach(p => { p.status = '✓'; });
      const n = applyParsed(fromAi(data));
      const notes = (data.notes || '').trim();
      $('#ai-notes').hidden = !notes;
      $('#ai-notes').textContent = notes ? '🤖 ' + notes : '';
      toast(n ? `IA preencheu ${n} campo${n > 1 ? 's' : ''} — confira os amarelos` : 'A IA não encontrou dados novos nesta foto', 3500);
    } else {
      photo.status = '🔤';
      photo.b64 = null;
      renderThumbs();
      setBusy('Lendo texto da foto…');
      const { text, lines } = await readWithOcr(photo.img);
      photo.status = '✓';
      $('#ocr-text').textContent = text || '(nenhum texto encontrado)';
      $('#ocr-raw').hidden = false;
      const n = applyParsed(parseLabel(text, lines), { keepText: true });
      toast(n ? `Preenchi ${n} campo${n > 1 ? 's' : ''} — confira os amarelos` : 'Não reconheci dados. Preencha manualmente.', 3500);
    }
  } catch (err) {
    console.error(err);
    photo.status = '⚠️';
    toast(err.message || 'Falha na leitura. Preencha manualmente.', 4500);
  } finally {
    photo.img = null;      // libera memória
    renderThumbs();
    setBusy('');
  }
}

/* ---------- leitura por IA (Claude) ---------- */
const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: ['papel', 'peso', 'liquido', 'unidade'] },
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
    notes: { type: 'string' },
  },
  required: ['category', 'name', 'brand', 'type', 'price', 'promo_price', 'promo_min_qty', 'rolls',
    'meters_per_roll', 'qty', 'unit', 'packs', 'count', 'notes'],
};

const AI_SYSTEM = `You read photos taken inside a Brazilian supermarket so the shopper can compare the real unit price (per metre, kg, litre or item). All photos in one request show the SAME product: usually the shelf price label, sometimes the package itself (front, back, or an open tray of eggs).

Fill every field of the JSON schema:
- category: "papel" for products on rolls compared per metre (toilet paper, paper towels, aluminium foil, cling film); "liquido" when the net content is a volume; "peso" when it is a weight; "unidade" for products compared per item (eggs, diapers, tea bags, batteries, etc.).
- name: short product name as a shopper would say it, in Portuguese with normal capitalisation, expanding shelf-label abbreviations (e.g. "PAP HIG MIL FT 20M" -> "Papel higiênico folha tripla 20 m"). No price or promotion text in the name.
- brand: the brand, or "" if not visible.
- type: generic product type in Portuguese used to group comparable products, e.g. "Papel higiênico", "Ovos", "Arroz", "Café em pó", "Refrigerante", "Leite".
- price: the regular price in BRL for ONE package as sold. Shelf labels also print a price per kg/litre/metre/unit in smaller text - never use that one as price. 0 if no price is visible.
- promo_price / promo_min_qty: if the label offers a lower price from a minimum quantity ("a partir de 2 un", "leve 3", club or app price), the promotional price per package and the minimum quantity (1 if there is no minimum); otherwise 0 and 0.
- rolls / meters_per_roll: only for "papel" (number of rolls in the package and metres per roll); otherwise 0.
- qty / unit / packs: net content of ONE item and how many items come in the package (e.g. "12x350ml" -> qty 350, unit "ml", packs 12). Single package -> packs 1. For "papel" and "unidade" use qty 0, unit "", packs 1.
- count: only for "unidade" - how many items in the package. Prefer the number printed ("30 unidades", "dúzia" = 12, "meia dúzia" = 6). If none is printed, count the visible items (e.g. eggs in a tray: rows x columns) and say so in notes. Otherwise 0.
- notes: one short sentence in Portuguese for the shopper about anything uncertain or worth knowing (e.g. "Contei 30 ovos (5 x 6).", "O preço de R$ 2,49 vale só a partir de 2 unidades."), or "".
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

/** Linha com cara de texto de verdade (não lixo do OCR). */
function looksLikeWords(l) {
  const words = l.split(/\s+/).filter(Boolean);
  const letters = (l.match(/\p{L}/gu) || []).length;
  return l.length >= 5 && letters / l.replace(/\s/g, '').length >= 0.7
    && words.some(w => w.replace(/[^\p{L}]/gu, '').length >= 4)
    && words.filter(w => w.length <= 2).length <= words.length / 2;
}

/** Extrai preço, quantidades e categoria do texto do OCR. */
function parseLabel(raw, lines = []) {
  const out = {};
  const flat = raw.replace(/\s+/g, ' ');
  const low = flat.toLowerCase();
  const maxH = Math.max(1, ...lines.map(l => l.h));
  const heightOf = s => Math.max(0, ...lines.filter(l => l.text.includes(s)).map(l => l.h));

  // Preço: o maior número "R$ xx,xx" da etiqueta que não seja preço por kg/L/m
  const re = /(R\s?\$)?\s*(\d{1,4}(?:\.\d{3})*,\d{2}|\d{1,4}\.\d{2})(?!\d)/gi;
  let m, bestScore = -1;
  while ((m = re.exec(flat))) {
    const before = low.slice(Math.max(0, m.index - 16), m.index);
    const after = low.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (/^\s*(kg|g|gr|ml|l|lt|m|mts?)\b/.test(after)) continue;   // é quantidade, não preço
    const isUnitPrice = /(kg|\/\s?l|litro|por|unit|\/\s?m\b|metro|100\s?g|100\s?ml)/.test(before)
      || /^\s*\/\s*(kg|l|m|un|100)/.test(after);
    const score = (m[1] ? 2 : 0) + (isUnitPrice ? 0 : 3) + (heightOf(m[2]) / maxH) * 4;
    if (score > bestScore) { bestScore = score; out.price = num(m[2]); }
  }

  const multi = flat.match(/(\d{1,2})\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|gr|ml|l|lt)\b/i);
  const weight = flat.match(/(\d+(?:[.,]\d+)?)\s*(kg|quilos?|g|gr|gramas)\b/i);
  const volume = flat.match(/(\d+(?:[.,]\d+)?)\s*(ml|l|lt|litros?)\b/i);
  const rolls = flat.match(/(\d{1,3})\s*(rolos?|rls?)\b/i);
  const meters = flat.match(/(\d{1,3}(?:[.,]\d{1,2})?)\s*(m|mts?|metros?)\b/i);
  const units = flat.match(/(\d{1,3})\s*(unidades|unid\.?|un|und|ovos)\b/i);
  const eggs = /\bovos?\b/i.test(flat);
  const dozen = /meia\s*d[uú]zia/i.test(flat) ? 6 : /d[uú]zia/i.test(flat) ? 12 : 0;

  const isPaper = /papel|rolo|toalha|guardanapo|alum[ií]nio|pvc/i.test(flat) || rolls;
  if (eggs || (dozen && !weight && !volume)) {
    out.category = 'unidade';
    out.type = 'Ovos';
    out.count = units ? num(units[1]) : dozen || undefined;
  } else if (isPaper && (rolls || meters)) {
    out.category = 'papel';
    if (rolls) out.rolls = num(rolls[1]);
    else if (units) out.rolls = num(units[1]);
    if (meters) out.metersPerRoll = num(meters[1]);
    out.type = /toalha/i.test(flat) ? 'Papel toalha' : /higi/i.test(flat) ? 'Papel higiênico' : undefined;
  } else if (multi && /ml|l|lt/i.test(multi[3])) {
    out.category = 'liquido'; out.packs = num(multi[1]); out.qty = num(multi[2]); out.unit = /ml/i.test(multi[3]) ? 'ml' : 'L';
  } else if (multi) {
    out.category = 'peso'; out.packs = num(multi[1]); out.qty = num(multi[2]); out.unit = /kg/i.test(multi[3]) ? 'kg' : 'g';
  } else if (volume) {
    out.category = 'liquido'; out.qty = num(volume[1]); out.unit = /ml/i.test(volume[2]) ? 'ml' : 'L';
  } else if (weight) {
    out.category = 'peso'; out.qty = num(weight[1]); out.unit = /^(kg|quilo)/i.test(weight[2]) ? 'kg' : 'g';
  } else if (units) {
    out.category = 'unidade'; out.count = num(units[1]);
  }

  // Marca: procura marcas já conhecidas no histórico
  const brands = [...new Set(state.entries.map(e => e.brand).filter(b => b && b.length > 1))];
  const nflat = norm(flat);
  out.brand = brands.find(b => new RegExp(`\\b${norm(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(nflat));

  // Nome: só linhas lidas com confiança e com cara de palavras (melhor vazio que lixo)
  const candidates = (lines.length ? lines : raw.split('\n').map(text => ({ text, conf: 100 })))
    .filter(l => (l.conf ?? 100) >= 65)
    .map(l => l.text.replace(/[^\p{L}\d\s.,%-]/gu, '').trim())
    .filter(l => looksLikeWords(l) && !/R\s?\$|\d+,\d{2}|pre[cç]o|oferta|c[oó]d|validade|a partir/i.test(l));
  if (candidates[0]) out.name = candidates[0].toLowerCase().replace(/(^|\s)\p{L}/gu, s => s.toUpperCase());
  return out;
}

let pendingCat = null;   // leitura de outra categoria aguardando confirmacao

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
  const qtyIds = { papel: ['rolls', 'mpr'], peso: ['wqty', 'wpacks'], liquido: ['vqty', 'vpacks'], unidade: ['count'] };
  const curCat = form.dataset.category;
  const userTypedQty = qtyIds[curCat].some(id => F(id).dataset.user === '1');
  const conflito = p.category && p.category !== curCat && userTypedQty;
  if (p.category && p.category !== curCat && !userTypedQty) setCategory(p.category);
  const cat = form.dataset.category;

  set('price', p.price, money);
  set('name', p.name);
  set('brand', p.brand);
  set('type', p.type);
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
