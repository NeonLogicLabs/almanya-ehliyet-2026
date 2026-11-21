/* ═══════════════════════════════════════════════════════════════════════════
   KİLİT — Şifreli içerik yükleyicisi (tarayıcı tarafı)

   Yayındaki sitede sorular ve tüm resim/videolar AES-256-GCM ile şifrelidir
   (sifreli/ klasörü). Şifre bilinmeden içerik okunamaz; repoyu indiren kişi de
   yalnız anlamsız baytlar görür.

   Akış:
   1. sifreli/kilit.json yoksa (yerel kaynak klasörü) → düz dosyalarla açılır.
   2. Varsa: cihazda kayıtlı anahtar yoksa giriş ekranı gösterilir.
      Şifre → PBKDF2-SHA256 (600.000 tur) → AES anahtarı. Anahtar,
      dışa aktarılamaz CryptoKey olarak IndexedDB'de saklanır (şifre saklanmaz).
   3. sorular.bin çözülür ve çalıştırılır, ardından app.js yüklenir.
   4. Resim/videoları service worker (sw.js) aynı anahtarla çözer.
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const SURUM = '35';
  const IDB_AD = 'ehliyet-kilit';
  const IDB_DEPO = 'anahtar';
  const IDB_ANAHTAR = 'k';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ── IndexedDB yardımcıları ─────────────────────────────────────────────
  function idbAc() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(IDB_AD, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(IDB_DEPO);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbIslem(mod, fn) {
    const db = await idbAc();
    try {
      return await new Promise((res, rej) => {
        const tx = db.transaction(IDB_DEPO, mod);
        const st = tx.objectStore(IDB_DEPO);
        const r = fn(st);
        tx.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
        tx.onerror = () => rej(tx.error);
      });
    } finally { db.close(); }
  }
  const anahtarOku = () => idbIslem('readonly', st => st.get(IDB_ANAHTAR)).catch(() => null);
  const anahtarYaz = k => idbIslem('readwrite', st => st.put(k, IDB_ANAHTAR));
  const anahtarSil = () => idbIslem('readwrite', st => st.delete(IDB_ANAHTAR)).catch(() => {});

  // ── Kripto ─────────────────────────────────────────────────────────────
  function b64Bayt(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Dosya biçimi: [12 bayt IV][şifreli veri + 16 bayt GCM etiketi]
  async function coz(anahtar, buf) {
    const u8 = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.slice(0, 12) }, anahtar, u8.slice(12));
  }

  async function sifredenAnahtar(sifre, kilit) {
    const temel = await crypto.subtle.importKey('raw', enc.encode(sifre), 'PBKDF2', false, ['deriveBits']);
    const bitler = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64Bayt(kilit.tuz), iterations: kilit.tekrar },
      temel, 256
    );
    // Dışa aktarılamaz: kod bile ham anahtarı geri okuyamaz.
    return crypto.subtle.importKey('raw', bitler, { name: 'AES-GCM' }, false, ['decrypt']);
  }

  async function anahtarDogruMu(anahtar, kilit) {
    try {
      const duz = await coz(anahtar, b64Bayt(kilit.kontrol));
      return dec.decode(duz) === 'ehliyet-kilit-ok';
    } catch (_) {
      return false;
    }
  }

  // ── Betik yükleme ──────────────────────────────────────────────────────
  function betikYukle(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('Yüklenemedi: ' + src));
      document.body.appendChild(s);
    });
  }

  async function swHazir() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    } catch (_) { return; }
    if (navigator.serviceWorker.controller) {
      try { sessionStorage.removeItem('sw-yenile'); } catch (_) {}
      return;
    }
    // Sayfa service worker'sız açıldı: ya ilk kurulum, ya da sert yenileme (Ctrl+Shift+R / Ctrl+F5).
    // Sert yenilemede tarayıcı SW'yi bilerek atlar; o zaman resim/videolar çözülemez (hepsi boş kalır).
    const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
    const bekle = ms => new Promise(res => {
      navigator.serviceWorker.addEventListener('controllerchange', res, { once: true });
      setTimeout(res, ms);
    });
    if (reg && reg.active) {
      reg.active.postMessage({ tip: 'devral' }); // SW sayfayı hemen devralsın
      await bekle(3000);
      if (navigator.serviceWorker.controller) return;
      // Devralamadıysa bir kez normal yenile (sonsuz döngüye girmesin diye işaretli).
      let denendi = false;
      try { denendi = sessionStorage.getItem('sw-yenile') === '1'; sessionStorage.setItem('sw-yenile', '1'); } catch (_) {}
      if (!denendi) { location.reload(); await new Promise(() => {}); }
      return;
    }
    // İlk kurulum: sw.js clients.claim() ile sayfayı devralana kadar bekle (en çok 8 sn).
    await bekle(8000);
  }

  // ── Giriş ekranı ───────────────────────────────────────────────────────
  function girisEkrani(kilit, hataMesaji) {
    return new Promise(resolve => {
      const kap = document.createElement('div');
      kap.id = 'kilit-ekrani';
      kap.innerHTML = `
        <style>
          #kilit-ekrani { position: fixed; inset: 0; z-index: 99999; display: grid; place-items: center;
            padding: 16px; background: var(--zemin, none), var(--bg, #0b1020); color: var(--text, #eef2fb);
            font-family: var(--f-metin, system-ui, -apple-system, "Segoe UI", sans-serif); }
          #kilit-ekrani form { width: 100%; max-width: 360px; background: var(--card, #151c33); border: 1px solid var(--hair, #2a3350);
            box-shadow: 0 0 0 5px var(--shell, transparent), 0 0 0 6px var(--border, transparent), inset 0 1px 1px var(--hilite, transparent), var(--golge, none);
            border-radius: 24px; padding: 28px 22px; display: flex; flex-direction: column; gap: 14px; text-align: center; }
          #kilit-ekrani h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; margin: 0; }
          #kilit-ekrani p { margin: 0; font-size: 13px; color: var(--muted, #94a0bb); line-height: 1.5; }
          #kilit-ekrani input { width: 100%; padding: 13px 16px; border-radius: 14px; border: 1px solid var(--border-light, #334155);
            background: var(--input-bg, #0b1220); color: var(--text, #fff); font-size: 16px; box-sizing: border-box; }
          #kilit-ekrani input:focus { outline: 3px solid var(--primary, #7c9bff); border-color: transparent; }
          #kilit-ekrani button { padding: 13px; min-height: 50px; border: 0; border-radius: 999px; background: var(--cta, #fff); color: var(--cta-ink, #0b1020);
            font-size: 15px; font-weight: 600; cursor: pointer; }
          #kilit-ekrani button:disabled { opacity: .6; cursor: wait; }
          #kilit-ekrani .hata { color: var(--red-ink, #fca5a5); font-size: 13px; font-weight: 600; min-height: 1em; }
        </style>
        <form autocomplete="on">
          <div style="font-size:40px;">🔐</div>
          <h1>Führerschein 2026 GOLD</h1>
          <p>İçerik şifrelidir. Şifreyi bir kez gir; bu cihaz hatırlar.</p>
          <input type="password" name="sifre" placeholder="Şifre" required autocomplete="current-password" />
          <div class="hata"></div>
          <button type="submit">🔓 Kilidi Aç</button>
        </form>`;
      document.body.appendChild(kap);
      const form = kap.querySelector('form');
      const inp = kap.querySelector('input');
      const hata = kap.querySelector('.hata');
      const btn = kap.querySelector('button');
      if (hataMesaji) hata.textContent = hataMesaji;
      setTimeout(() => inp.focus(), 50);

      form.addEventListener('submit', async e => {
        e.preventDefault();
        btn.disabled = true;
        hata.textContent = '';
        btn.textContent = '⏳ Açılıyor...';
        try {
          const anahtar = await sifredenAnahtar(inp.value, kilit);
          if (await anahtarDogruMu(anahtar, kilit)) {
            try { await anahtarYaz(anahtar); } catch (_) { /* gizli sekme: yalnız bu oturum */ }
            kap.remove();
            resolve(anahtar);
            return;
          }
          hata.textContent = '❌ Şifre yanlış.';
        } catch (err) {
          hata.textContent = '❌ Açılamadı: ' + (err && err.message ? err.message : err);
        }
        inp.value = '';
        inp.focus();
        btn.disabled = false;
        btn.textContent = '🔓 Kilidi Aç';
      });
    });
  }

  function hataGoster(mesaj) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;z-index:99999;padding:12px 14px;border-radius:10px;background:#7f1d1d;color:#fff;font:600 14px system-ui,sans-serif;';
    d.textContent = mesaj;
    document.body.appendChild(d);
  }

  // ── Dışarıya açık: çıkış ───────────────────────────────────────────────
  window.kilitCikis = async function () {
    if (!confirm('Bu cihazda kilit kapatılsın mı? Tekrar açmak için şifre gerekir. (Çalışma ilerlemen silinmez.)')) return;
    await anahtarSil();
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      reg?.active?.postMessage({ tip: 'anahtar-silindi' });
    } catch (_) {}
    location.reload();
  };

  // ── Başlat ─────────────────────────────────────────────────────────────
  async function baslat() {
    await swHazir();

    let kilit = null;
    try {
      const r = await fetch(`sifreli/kilit.json?v=${SURUM}`, { cache: 'no-store' });
      if (r.ok) kilit = await r.json();
    } catch (_) { /* çevrimdışı ve önbellekte yoksa aşağıda ele alınır */ }

    if (!kilit) {
      // Yerel kaynak klasörü (şifresiz geliştirme kopyası).
      await betikYukle(`questions_full.js?v=${SURUM}`);
      await betikYukle(`app.js?v=${SURUM}`);
      return;
    }

    let anahtar = await anahtarOku();
    if (anahtar && !(await anahtarDogruMu(anahtar, kilit))) {
      await anahtarSil(); // şifre değişmiş
      anahtar = null;
    }
    if (!anahtar) anahtar = await girisEkrani(kilit);

    const yanit = await fetch(`sifreli/sorular.bin?v=${SURUM}`);
    if (!yanit.ok) throw new Error('Soru dosyası alınamadı (' + yanit.status + ')');
    const duz = await coz(anahtar, await yanit.arrayBuffer());
    const url = URL.createObjectURL(new Blob([duz], { type: 'text/javascript' }));
    await betikYukle(url);
    URL.revokeObjectURL(url);
    await betikYukle(`app.js?v=${SURUM}`);
  }

  function hazir(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }
  hazir(() => baslat().catch(err => {
    console.error(err);
    hataGoster('Uygulama açılamadı: ' + (err && err.message ? err.message : err) + ' — İnternet bağlantını kontrol edip sayfayı yenile.');
  }));
})();
