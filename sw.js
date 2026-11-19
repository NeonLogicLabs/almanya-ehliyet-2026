const CACHE_NAME = 'fahrschule-gold-v25';
// Uygulama kabuğu. Şifreli yayında questions_full.js yoktur (yerine sifreli/sorular.bin);
// bu yüzden dosyalar tek tek ve hata yutularak önbelleğe alınır.
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './kilit.js',
  './app.js',
  './manifest.json',
  './sifreli/kilit.json',
  './sifreli/sorular.bin',
  './questions_full.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(CORE_ASSETS.map(u => cache.add(u).catch(() => {})))
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Şifre çözme anahtarı (kilit.js'in IndexedDB'ye koyduğu CryptoKey) ────
let anahtarBellek = null;

function anahtarOku() {
  if (anahtarBellek) return Promise.resolve(anahtarBellek);
  return new Promise(res => {
    let r;
    try { r = indexedDB.open('ehliyet-kilit', 1); } catch (_) { res(null); return; }
    r.onupgradeneeded = () => r.result.createObjectStore('anahtar');
    r.onerror = () => res(null);
    r.onsuccess = () => {
      const db = r.result;
      try {
        const g = db.transaction('anahtar', 'readonly').objectStore('anahtar').get('k');
        g.onsuccess = () => { db.close(); anahtarBellek = g.result || null; res(anahtarBellek); };
        g.onerror = () => { db.close(); res(null); };
      } catch (_) { db.close(); res(null); }
    };
  });
}

self.addEventListener('message', e => {
  if (e.data && e.data.tip === 'anahtar-silindi') anahtarBellek = null;
  // Sert yenilemeyle SW'siz açılan sayfayı devral (yoksa medya çözülemez).
  if (e.data && e.data.tip === 'devral') e.waitUntil(self.clients.claim());
});

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', mp4: 'video/mp4' };

// Ağdan al, 200 ise önbelleğe koy; ağ yoksa önbellekten ver.
async function onbellektenYaDaAgdan(cache, url) {
  const kayitli = await cache.match(url);
  if (kayitli) return kayitli;
  const yanit = await fetch(url);
  if (yanit.status === 200) await cache.put(url, yanit.clone());
  return yanit;
}

// Tam (200) bir gövdeden gerekirse Range (206) yanıtı üretir — videolar için.
function aralikliYanit(req, buf, tur) {
  const total = buf.byteLength;
  const range = req.headers.get('range');
  const m = range && /bytes=(\d+)-(\d+)?/.exec(range);
  if (!m) {
    return new Response(buf, { status: 200, headers: { 'Content-Type': tur, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' } });
  }
  const start = parseInt(m[1], 10);
  const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
  if (start >= total || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  const parca = buf.slice(start, end + 1);
  return new Response(parca, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': tur,
      'Content-Length': String(parca.byteLength),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes'
    }
  });
}

async function medyaIstegi(req, ad) {
  const cache = await caches.open(CACHE_NAME);
  const uzanti = (ad.split('.').pop() || '').toLowerCase();
  const tur = MIME[uzanti] || 'application/octet-stream';

  // 1) Şifreli yayın: sifreli/media/<ad>.bin → anahtarla çöz.
  const sifreliUrl = new URL(`sifreli/media/${ad}.bin`, self.registration.scope).href;
  let sifreli = null;
  try { sifreli = await onbellektenYaDaAgdan(cache, sifreliUrl); } catch (_) { sifreli = null; }

  if (sifreli && sifreli.status === 200) {
    const anahtar = await anahtarOku();
    if (!anahtar) return new Response('Kilitli', { status: 401 });
    try {
      const u8 = new Uint8Array(await sifreli.arrayBuffer());
      const duz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.slice(0, 12) }, anahtar, u8.slice(12));
      return aralikliYanit(req, duz, tur);
    } catch (_) {
      anahtarBellek = null; // anahtar eskimiş olabilir; bir sonraki istekte yeniden oku
      return new Response('Çözülemedi', { status: 403 });
    }
  }

  // 2) Yerel kaynak klasörü (şifresiz): media/<ad>
  const duzUrl = new URL(`media/${ad}`, self.registration.scope).href;
  try {
    const yanit = await onbellektenYaDaAgdan(cache, duzUrl);
    if (yanit.status !== 200) return yanit;
    return aralikliYanit(req, await yanit.arrayBuffer(), yanit.headers.get('Content-Type') || tur);
  } catch (_) {
    return new Response('Çevrimdışı', { status: 504 });
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const medyaKoku = new URL('media/', self.registration.scope);

  if (url.origin === medyaKoku.origin && url.pathname.startsWith(medyaKoku.pathname)) {
    const ad = decodeURIComponent(url.pathname.slice(medyaKoku.pathname.length));
    event.respondWith(medyaIstegi(req, ad));
    return;
  }

  // Başka sitelere giden istekler (ör. senkron sunucusu) SW'ye uğramadan doğrudan gitsin.
  if (url.origin !== self.location.origin) return;

  // Uygulama kabuğu: önce ağ (güncellemeler hemen gelsin), ağ yoksa önbellek.
  event.respondWith(
    fetch(req, { cache: 'no-store' })
      .then(yanit => {
        if (yanit && yanit.status === 200 && url.origin === self.location.origin) {
          const kopya = yanit.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, kopya));
        }
        return yanit;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
