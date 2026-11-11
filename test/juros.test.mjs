/* Testa a matemática de juros e o leitor de anúncio, sem navegador. */
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
const { impliedRate, parseFinancing } = new Function([
  corte('/** Converte "1.234,56"', 'const fmtN ='),
  "const norm = s => (s||'').toString().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().replace(/\\s+/g,' ').trim();",
  corte('function impliedRate(', 'function readFin('),
  corte('/** Leitura offline: procura "16x 43,90"', 'function applyFin('),
  'return { impliedRate, parseFinancing };',
].join('\n'))();

let ok = 0, falhas = [];
const quase = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
function t(nome, real, esperado, tol = 0.0005) {
  if (quase(real, esperado, tol)) { ok++; console.log('  ✓', nome, '→', typeof real === 'number' ? real.toFixed(4) : real); }
  else falhas.push(`${nome}: esperado ${esperado}, veio ${real}`);
}

// --- taxa mensal efetiva (conferida à mão com a fórmula da anuidade) ---
t('sem juros: 10x R$100 e R$1000 à vista', impliedRate({ cash: 1000, n: 10, pmt: 100 }), 0);
t('10x R$100 e R$800 à vista → ~4,28% a.m.', impliedRate({ cash: 800, n: 10, pmt: 100 }), 0.0428, 0.0002);
t('12x R$92,50 e R$1000 à vista → ~1,64% a.m.', impliedRate({ cash: 1000, n: 12, pmt: 92.5 }), 0.0164, 0.0002);
// esperar mais para pagar baixa a taxa: 4,28% a.m. com a 1a em 30 dias, 3,57% com a 1a em 60
t('1ª parcela só em 60 dias baixa a taxa', impliedRate({ cash: 800, n: 10, pmt: 100, days: 60 }), 0.0357, 0.0005);
// 200 de entrada + 6x100 = 800 = o proprio a vista: juros zero
t('entrada + parcelas somando o à vista dá juros zero', impliedRate({ cash: 800, n: 6, pmt: 100, down: 200 }), 0);
t('parcelado mais barato que à vista dá taxa negativa', impliedRate({ cash: 1000, n: 10, pmt: 90 }), -0.0187, 0.0005);
// a 1ª parcela no ato adianta o pagamento: mesma soma, juros zero
t('10x R$100 com 1ª no ato e R$1000 à vista', impliedRate({ cash: 1000, n: 10, pmt: 100, days: 0 }), 0);

// --- dados incompletos não podem virar número ---
for (const [nome, o] of [['sem preço à vista', { cash: 0, n: 10, pmt: 100 }],
                         ['sem parcelas', { cash: 800, n: 0, pmt: 100 }],
                         ['entrada maior que o à vista', { cash: 500, n: 10, pmt: 100, down: 600 }]]) {
  const r = impliedRate(o);
  Number.isNaN(r) ? (ok++, console.log('  ✓', nome, '→ NaN (correto)')) : falhas.push(`${nome}: devia ser NaN, veio ${r}`);
}

// --- leitura do anúncio pelo OCR ---
const anuncios = [
  ['16x R$ 43,90 com à vista', 'PANELAS TRAMONTINA\nR$ 599,00 A VISTA\nOU 16X R$ 43,90', { n: 16, pmt: 43.9, cash: 599 }],
  ['entrada + parcelas', 'SOFA 3 LUGARES\nENTRADA R$ 200,00\n10X DE R$ 149,90', { n: 10, pmt: 149.9, down: 200 }],
  ['1+9 vira entrada', 'BICICLETA\n1 + 9 DE R$ 120,00', { n: 9, pmt: 120, down: 120 }],
  ['1ª parcela em 60 dias', 'GELADEIRA\nR$ 2.199,00 NO PIX\n12X R$ 219,90\n1o PAGAMENTO EM 60 DIAS', { n: 12, pmt: 219.9, cash: 2199, days: 60 }],
];
for (const [nome, texto, esperado] of anuncios) {
  const r = parseFinancing(texto);
  const erros = Object.entries(esperado).filter(([k, v]) => !quase(r[k], v, 0.001));
  if (!erros.length) { ok++; console.log('  ✓', nome, '→', JSON.stringify(r)); }
  else falhas.push(`${nome}: ${erros.map(([k, v]) => `${k} esperado ${v}, veio ${r[k]}`).join('; ')} | leu ${JSON.stringify(r)}`);
}

falhas.forEach(f => console.log('  ✗', f));
console.log(`\n${ok}/${ok + falhas.length} verificações OK`);
process.exit(falhas.length ? 1 : 0);
