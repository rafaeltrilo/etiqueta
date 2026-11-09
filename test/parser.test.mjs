/* Testa parseLabel() isoladamente, sem navegador.
   Extrai do app.js o bloco do parser + as funções de que ele depende. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, '..', 'app.js'), 'utf8');

const corte = (de, ate) => {
  const i = src.indexOf(de), f = ate ? src.indexOf(ate) : -1;
  if (i < 0) throw new Error('não achei: ' + de);
  return src.slice(i, f < 0 ? undefined : f);
};
const codigo = [
  corte('const CATS = {', '/* ---------- utilidades ---------- */'),
  corte('/** Converte "1.234,56"', 'const fmtN ='),
  "const norm = s => (s||'').toString().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().replace(/\\s+/g,' ').trim();",
  corte('/** Quantidade total na unidade padrão', 'const unitPrice ='),
  corte('/* =========================================================\n   PARSER DE ETIQUETA', '/**\n * Preenche o formulário'),
  'return { parseLabel };',
].join('\n');
const { parseLabel } = new Function('state', codigo)({ entries: [] });

const casos = JSON.parse(fs.readFileSync(path.join(dir, 'etiquetas.json'), 'utf8'));
let ok = 0, falhas = [];
for (const c of casos) {
  const raw = c.linhas.map(l => l[0]).join('\n');
  const lines = c.linhas.map(l => ({ text: l[0], conf: 90, h: l[1] }));
  const r = parseLabel(raw, lines);
  const erros = [];
  for (const [k, esperado] of Object.entries(c.esperado)) {
    const got = r[k];
    if (k === 'promo') {
      for (const [pk, pv] of Object.entries(esperado)) {
        if (!r.promo || Math.abs(r.promo[pk] - pv) > 0.01) erros.push(`promo.${pk}: esperado ${pv}, veio ${r.promo ? r.promo[pk] : '—'}`);
      }
    } else if (typeof esperado === 'number') {
      if (!(Math.abs((got ?? NaN) - esperado) < 0.011)) erros.push(`${k}: esperado ${esperado}, veio ${got}`);
    } else if (got !== esperado) erros.push(`${k}: esperado "${esperado}", veio "${got}"`);
  }
  if (erros.length) falhas.push({ nome: c.nome, erros, lido: r });
  else { ok++; console.log('  ✓', c.nome, '→', JSON.stringify({ price: r.price, cat: r.category, name: r.name })); }
}
for (const f of falhas) {
  console.log('  ✗', f.nome);
  f.erros.forEach(e => console.log('      ', e));
  console.log('       lido:', JSON.stringify(f.lido));
}
console.log(`\n${ok}/${casos.length} etiquetas OK`);
process.exit(falhas.length ? 1 : 0);
