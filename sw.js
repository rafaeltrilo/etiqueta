/* Service worker: funciona offline (app shell) e guarda o OCR baixado da CDN.
   Ao alterar os arquivos do app, mude VERSION para forçar a atualização nos celulares. */
const VERSION = 'preco-real-v5';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];

self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Um a um: se um arquivo faltar (ex.: um ícone), o resto do app continua
    // funcionando offline. Com cache.addAll(), uma única falha aborta tudo.
    const falhas = [];
    await Promise.all(SHELL.map(async url => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await cache.put(url, res);
      } catch (err) {
        falhas.push(url + ': ' + err.message);
      }
    }));
    if (falhas.length) console.warn('[sw] não consegui cachear:', falhas);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'ocr-cdn').map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', ev => {
  if (ev.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Arquivos do Tesseract (script, wasm, idioma): cache-first
  if (url.hostname === 'cdn.jsdelivr.net') {
    ev.respondWith(
      caches.open('ocr-cdn').then(async cache => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // Navegação: rede primeiro, cai para o cache offline
  if (req.mode === 'navigate') {
    ev.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        ev.waitUntil(caches.open(VERSION).then(c => c.put('index.html', copy)));
        return res;
      }).catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Código do app (app.js / styles.css): rede primeiro, para uma atualização
  // valer já na próxima abertura em vez de só na seguinte.
  if (/\.(js|css)$/.test(url.pathname)) {
    ev.respondWith(
      fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          ev.waitUntil(caches.open(VERSION).then(c => c.put(req, copy)));
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // Demais arquivos (ícones, imagens): stale-while-revalidate
  ev.respondWith(
    caches.open(VERSION).then(async cache => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
