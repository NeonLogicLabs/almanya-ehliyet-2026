/* ═══════════════════════════════════════════════════════════════════════════
   FÜHRERSCHEIN 2026 GOLD (TR / DE) — MAIN APPLICATION ENGINE v3.0
   Includes:
   1. Multi-Input Number Questions (e.g. 2.2.30-202, 2.2.30-203)
   2. Official TÜV (B, C, CE, Combo, Mistakes) & Official IHK Kod 95 Engine
   3. Encrypted content (kilit.js + sw.js, AES-256-GCM), Timer Auto-Pause on Tab Switch, Full Sidebar List
═══════════════════════════════════════════════════════════════════════════ */

const DB = Array.isArray(window.QUESTIONS_DB) ? window.QUESTIONS_DB : [];
const STORAGE_KEY = 'FAHRSCHULE_GOLD_PROGRESS_V1';

// ── State Management ─────────────────────────────────────────────────────
let state = {
  // qStats[code] = { status: 'wrong' | 'learning' | 'learned', correctStreak: 0..3, wrongCount: 0, lastSeen: ts }
  qStats: {},
  starred: {},
  examHistory: [],
  alwaysShowDE: false
};

// Study View State
let studyFiltered = [...DB];
let studyIndex = 0;
let studySelectedChoices = new Set();
let studyNumberValues = ['']; // Array supporting 1 or 2+ number inputs
let studyActiveNumIdx = 0;
let studyRevealed = false;
let studyLocalShowDE = false;
let studyShuffledOptions = [];
let studySonuc = null;
let studyBakildi = false; // bu soruda "Doğru cevabı gör" kullanıldı mı (aralıklı tekrar) // son "Cevabı kontrol et" sonucunun özeti (geri bildirim kutusu için)
let sinavSonDakikaUyarildi = false;

// Exam View State
let selectedExamMode = 'B'; // 'B' | 'C' | 'CE' | 'COMBO' | 'KOD95'
let comboStages = ['B', 'C', 'CE'];
let comboCurrentStageIdx = 0;
let activeExamClass = 'B';
let isMistakesExamActive = false;
let examSmartWeightedActive = false;
let examQuestions = [];
let examIdx = 0;
let examAnswers = new Map(); // code -> { selected: Set, numberVals: string[] }
let examActiveNumIdx = 0;
let examFlags = new Set();
let examVideoState = new Map(); // code -> { plays: 0, unlockedOptions: false }
let examOptionOrder = new Map(); // code -> shuffled array of answers_tr
let examLocalShowDE = false;
let examTimerInterval = null;
let examSecondsLeft = 45 * 60;
let examPaused = false;

// Tarayıcı geri tuşuyla gezinme durumu (bkz. gecmisiBaslat)
const GORUNUMLER = ['dashboard', 'study', 'exam', 'cheatsheet', 'stats'];
let aktifGorunum = 'dashboard';
let aktifSekme = 'dashboard';
let gecmisHazir = false;

// ── Official Exam Configs ────────────────────────────────────────────────
const EXAM_CONFIG = {
  B: {
    title: 'Klasse B (Otomobil)',
    grundCount: 20,
    classCount: 10,
    total: 30,
    classMatch: 'Klasse B'
  },
  C: {
    title: 'Klasse C (Kamyon)',
    grundCount: 10,
    classCount: 27,
    total: 37,
    classMatch: 'Klasse C'
  },
  CE: {
    title: 'Klasse CE (Tır / Çekici)',
    grundCount: 10,
    classCount: 20,
    total: 30,
    classMatch: 'Klasse CE'
  },
  KOD95: {
    title: 'Kod 95 (IHK LKW Güterkraftverkehr)',
    grundCount: 0,
    classCount: 50,
    total: 50,
    classMatch: 'Kod 95',
    isIHK: true
  },
  MISTAKES: {
    title: '⚡ Hatalarım & Tuzak Sorular Özel Sınavı',
    grundCount: 0,
    classCount: 20,
    total: 20,
    classMatch: 'ALL'
  }
};

// ── Initialization ───────────────────────────────────────────────────────
// İçerik kilidi kilit.js'tedir: sorular ve medya şifreli yayınlanır, bu dosya
// ancak kilit açıldıktan sonra yüklenir. Tarayıcıda şifre tutulmaz.
// Eski sürümlerin bıraktığı istemci PIN kayıtlarını temizle.
['FAHRSCHULE_GOLD_PIN_HASH_V2', 'FAHRSCHULE_GOLD_PIN_UNLOCKED_V1'].forEach(k => {
  try { localStorage.removeItem(k); } catch (_) {}
});

// kilit.js bu dosyayı DOMContentLoaded'dan SONRA yükler; o yüzden olayı beklemeden de başlayabilmeli.
// Ama fn hemen ÇALIŞMAMALI: dosyanın aşağısındaki const'lar (SON_KONUM_KEY, FILTRE_KONUM_KEY, senkron…)
// henüz tanımlanmamış olur ("TDZ"); try/catch'ler hatayı yutar ve kayıtlı konum boş okunur.
// setTimeout ile dosyanın tamamı değerlendirildikten sonra başlat.
function onAppReady(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else setTimeout(fn, 0);
}

onAppReady(() => {
  loadProgress();
  updateDynamicCounts();
  updateGlobalDEButton();
  refreshDashboard();
  applyStudyFilters();
  updateFormulaCalc();

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
      reg.update();
    }).catch(() => {});
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Only reload when upgrading from an existing service worker, never on first install!
      if (hadController && !refreshing && !sinavSuruyor()) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  document.addEventListener('keydown', handleKeyboardShortcuts);
  gecmisiBaslat();
  // Sınav çubuğu, üstteki menü çubuğunun hemen altına yapışsın
  const ustCubukOlc = () => {
    const t = document.querySelector('.topbar');
    if (t) document.documentElement.style.setProperty('--ust-cubuk', (t.offsetHeight + 14) + 'px');
  };
  ustCubukOlc();
  window.addEventListener('resize', ustCubukOlc);
});

function sanitizeLoadedState(parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  if (parsed.qStats && typeof parsed.qStats === 'object' && !Array.isArray(parsed.qStats)) {
    state.qStats = parsed.qStats;
  }
  if (parsed.starred && typeof parsed.starred === 'object' && !Array.isArray(parsed.starred)) {
    state.starred = parsed.starred;
  }
  if (Array.isArray(parsed.examHistory)) {
    const sayi = v => (Number.isFinite(+v) ? +v : 0);
    state.examHistory = parsed.examHistory.filter(h => h && typeof h === 'object').slice(0, 30).map(h => ({
      date: String(h.date ?? ''), mode: String(h.mode ?? ''), passed: !!h.passed, isIHK: !!h.isIHK,
      wrongPoints: sayi(h.wrongPoints), earnedPoints: sayi(h.earnedPoints), totalPointsPossible: sayi(h.totalPointsPossible),
      fivePtWrong: sayi(h.fivePtWrong), correctCount: sayi(h.correctCount), total: sayi(h.total)
    }));
  }
  if (typeof parsed.alwaysShowDE === 'boolean') {
    state.alwaysShowDE = parsed.alwaysShowDE;
  }
  if (parsed.gunluk && typeof parsed.gunluk === 'object' && !Array.isArray(parsed.gunluk)) {
    state.gunluk = gunlukTemizle(parsed.gunluk);
  }
  if (parsed.gunlukCihaz && typeof parsed.gunlukCihaz === 'object' && !Array.isArray(parsed.gunlukCihaz)) {
    const c = {};
    for (const [id, g] of Object.entries(parsed.gunlukCihaz)) {
      if (/^[a-z0-9]{6,32}$/.test(id) && g && typeof g === 'object' && !Array.isArray(g)) c[id] = gunlukTemizle(g);
    }
    state.gunlukCihaz = c;
  }
  if ([10, 20, 30, 50].includes(parsed.gunlukHedef)) {
    state.gunlukHedef = parsed.gunlukHedef;
  }
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      sanitizeLoadedState(JSON.parse(raw));
    }
  } catch (e) {
    console.warn('Progress load error:', e);
  }
}

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Progress save error:', e);
  }
  try { senkronKirlet(); } catch (_) { /* senkron bölümü henüz yüklenmediyse */ }
}

// ── Leitner Mastery Helpers (3-Streak System) ────────────────────────────
function getLeitnerBox(code) {
  const st = state.qStats[code];
  if (!st) return 'unseen';
  const streak = st.correctStreak || 0;
  if (st.status === 'wrong' || streak === 0) return 'wrong';
  if (streak >= 3) return 'learned';
  return 'learning';
}

function renderLeitnerDotsHtml(code) {
  const st = state.qStats[code];
  const streak = st ? Math.min(3, st.correctStreak || 0) : 0;
  const isWrong = st && st.status === 'wrong';

  let dots = '';
  for (let i = 1; i <= 3; i++) {
    let cls = 'l-dot';
    if (streak >= i) cls += ' filled';
    else if (isWrong && i === 1) cls += ' err';
    dots += `<span class="${cls}"></span>`;
  }

  let label = 'Yeni (0/3)';
  if (streak >= 3) label = 'Tam Öğrenildi (3/3)';
  else if (streak > 0) label = `Gelişiyor (${streak}/3)`;
  else if (isWrong) label = 'Hatalı (0/3)';
  if (st) {
    const t = tekrarGunu(st);
    label += t <= bugunAnahtar() ? ' · 🔁 tekrar zamanı' : ` · tekrar ${tekrarMetni(t)}`;
  }

  return `<span class="leitner-dots" title="Aralıklı tekrar: doğru cevaptan sonra 1, 3 ve 7 gün sonra yeniden sorulur">${dots} <span>${label}</span></span>`;
}

// ── Tarayıcı geri/ileri tuşuyla gezinme ─────────────────────────────────
// Her sekme değişimi tarayıcı geçmişine yazılır; geri tuşu bir önceki ekrana ve
// oradaki kaydırma konumuna döner. Telefondaki soru çekmecesi ve büyütülmüş resim de
// geçmişe "katman" olarak yazılır, geri tuşu önce onları kapatır.
// (Değişkenler dosyanın başında tanımlı: başlangıç kodu bu satırlardan önce çalışır.)
function gecmiseYaz(durum) {
  if (!gecmisHazir) return;
  try {
    // Ayrılmadan önce bulunduğumuz ekranın kaydırma konumunu sakla
    history.replaceState(Object.assign({}, history.state, { y: window.scrollY }), '');
    const iz = '#' + durum.view + (durum.katman ? '-' + durum.katman : '');
    history.pushState(durum, '', iz);
  } catch (_) { /* geçmiş API'si yoksa sessizce geç */ }
}

function gecmisiBaslat() {
  try { history.scrollRestoration = 'manual'; } catch (_) {}
  const istenen = (location.hash || '').slice(1).split('-')[0];
  const ilk = GORUNUMLER.includes(istenen) ? istenen : 'dashboard';
  try { history.replaceState({ view: ilk, tab: ilk }, '', '#' + ilk); } catch (_) {}
  if (ilk !== 'dashboard') switchView(ilk, null, { gecmis: true });
  gecmisHazir = true;
  window.addEventListener('popstate', e => {
    const s = e.state || { view: 'dashboard', tab: 'dashboard' };
    if (lightboxAcikMi() && s.katman !== 'resim') closeLightbox(true);
    if (cekmeceAcikMi() && s.katman !== 'cekmece') closeStudyDrawer(true);
    if (s.view && (s.view !== aktifGorunum || (s.tab || s.view) !== aktifSekme)) {
      switchView(s.view, s.tab && s.tab !== s.view ? s.tab : null, { gecmis: true, y: s.y });
    }
  });
}

// ── Navigation & View Switching (Pauses Exam Timer When Leaving Exam) ────
function switchView(viewName, highlightTabName = null, secenek = {}) {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  const tabKeyYeni = highlightTabName || viewName;
  if (!secenek.gecmis && (viewName !== aktifGorunum || tabKeyYeni !== aktifSekme)) {
    if (cekmeceAcikMi()) closeStudyDrawer(true);
    gecmiseYaz({ view: viewName, tab: tabKeyYeni });
  }
  aktifGorunum = viewName;
  aktifSekme = tabKeyYeni;

  // Pause exam timer when navigating away from exam view; resume when returning
  if (viewName !== 'exam') {
    examPaused = true;
  } else if (document.getElementById('exam-active-view')?.style.display !== 'none') {
    examPaused = false;
  }

  document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('view-' + viewName);
  if (target) target.classList.add('active');

  const tabKey = highlightTabName || viewName;
  document.querySelectorAll('.nav-tab, .bottom-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === tabKey);
  });

  if (viewName === 'dashboard') refreshDashboard();
  if (viewName === 'exam') sinavDevamKutusu();
  if (viewName === 'stats') renderStatsView();
  if (viewName === 'cheatsheet') {
    updateFormulaCalc();
    renderSignFlashcards();
  }
  if (typeof secenek.y === 'number') {
    // Geri tuşuyla dönüldü: o ekrandaki eski kaydırma konumuna dön
    const y = secenek.y;
    requestAnimationFrame(() => window.scrollTo(0, y));
  } else {
    window.scrollTo({ top: 0, behavior: secenek.gecmis ? 'auto' : 'smooth' });
  }
}

function toggleGlobalGerman() {
  state.alwaysShowDE = !state.alwaysShowDE;
  saveProgress();
  updateGlobalDEButton();
  if (document.getElementById('view-study').classList.contains('active')) {
    renderStudyQuestion();
  }
  if (document.getElementById('view-exam').classList.contains('active') &&
      document.getElementById('exam-active-view').style.display !== 'none') {
    renderExamQuestion();
  }
}

function updateGlobalDEButton() {
  const btn = document.getElementById('global-de-btn');
  const txt = document.getElementById('global-de-state');
  if (!btn || !txt) return;
  btn.classList.toggle('active', !!state.alwaysShowDE);
  txt.textContent = state.alwaysShowDE ? 'AÇIK' : 'KAPALI';
}

// ── Text-to-Speech (Checks Active View Properly!) ────────────────────────
function speakCurrentQuestion() {
  if (!('speechSynthesis' in window)) {
    alert('Tarayıcınız sesli okuma özelliğini desteklemiyor.');
    return;
  }
  window.speechSynthesis.cancel();

  let q = null;
  let useDE = state.alwaysShowDE;
  const isExamViewActive = document.getElementById('view-exam')?.classList.contains('active') &&
                           document.getElementById('exam-active-view')?.style.display !== 'none';

  if (isExamViewActive) {
    q = examQuestions[examIdx];
    useDE = useDE || examLocalShowDE;
  } else {
    q = studyFiltered[studyIndex];
    useDE = useDE || studyLocalShowDE;
  }
  if (!q) return;

  // Soru ve ardından şıklar (ekrandaki sırayla, harfleriyle) okunur.
  const almanca = useDE && !!q.question_de;
  const parcalar = [almanca ? q.question_de : [q.question_tr, q.pretext_tr].filter(Boolean).join(' ')];
  if (q.type !== 'number') {
    let siklar;
    if (almanca) siklar = q.answers_de || [];
    else siklar = (isExamViewActive ? examOptionOrder.get(q.code) : studyShuffledOptions) || q.answers_tr || [];
    siklar.forEach((a, i) => {
      const harf = String.fromCharCode(65 + i);
      const metin = (a.text || '').replace(/^-\s*/, '') || (almanca ? 'Bild' : 'resim');
      parcalar.push(almanca ? `Antwort ${harf}: ${metin}` : `${harf} şıkkı: ${metin}`);
    });
  }
  parcalar.forEach(t => {
    const utter = new SpeechSynthesisUtterance(t);
    utter.lang = almanca ? 'de-DE' : 'tr-TR';
    utter.rate = 0.96;
    window.speechSynthesis.speak(utter);
  });
}

// ── Dashboard Logic ──────────────────────────────────────────────────────
function refreshDashboard() {
  renderDashUst();
  sinifKonumlariniGoster();
  // Eski (2026 havuzunda olmayan) Kod 95 soruları çalışma listesinde görünmediği için sayılmaz;
  // yoksa hazırlık yüzdesi hiç %100 olamaz ve "Hatalarım" sayısı listeyle tutmaz.
  const havuz = DB.filter(q => !isEskiKod95(q));
  const total = havuz.length;
  let learned = 0;
  let learning = 0;
  let wrong = 0;

  havuz.forEach(q => {
    const box = getLeitnerBox(q.code);
    if (box === 'learned') learned++;
    else if (box === 'learning') learning++;
    else if (box === 'wrong') wrong++;
  });

  const starredCount = Object.keys(state.starred).filter(k => state.starred[k]).length;
  const seen = learned + learning + wrong;
  const weightedScore = learned + (learning * 0.5);
  const pct = total > 0 ? Math.min(100, Math.round((weightedScore / total) * 100)) : 0;
  const passedExams = state.examHistory.filter(e => e.passed).length;

  document.getElementById('kpi-total-q').textContent = total.toLocaleString('tr-TR');
  document.getElementById('kpi-learned').textContent = learned.toLocaleString('tr-TR');
  document.getElementById('kpi-wrong').textContent = wrong.toLocaleString('tr-TR');
  document.getElementById('kpi-starred').textContent = starredCount.toLocaleString('tr-TR');

  document.getElementById('dash-ready-pct').textContent = pct + '%';
  document.getElementById('dash-ready-bar').style.width = pct + '%';
  document.getElementById('dash-seen-text').textContent = `Çözülen: ${seen} / ${total} (3/3 Ustalaşılan: ${learned})`;
  document.getElementById('dash-exams-passed').textContent = `Geçilen Sınav: ${passedExams}`;

  const lbl = document.getElementById('dash-ready-label');
  if (pct >= 85) lbl.textContent = '🟢 Sınava Tamamen Hazırsın!';
  else if (pct >= 50) lbl.textContent = '🟡 İyi Gidiyorsun, Devam Et!';
  else if (seen > 0) lbl.textContent = '🟠 Temel Oluşuyor, Pratiğe Devam';
  else lbl.textContent = '🚀 Hemen İlk Sorudan Başla';
}

function openClassStudy(clsName) {
  document.getElementById('study-class-filter').value = clsName;
  const tur = document.getElementById('study-type-filter'); if (tur) tur.value = 'ALL';
  const ara = document.getElementById('study-search'); if (ara) ara.value = '';
  document.getElementById('study-status-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = 'ALL';
  applyStudyFilters();
  switchView('study');
}

// Ana ekran kısayolları önceki aramayı ve soru türünü sıfırlar (yoksa liste eksik/boş görünür)
function aramaVeTuruSifirla() {
  const tur = document.getElementById('study-type-filter'); if (tur) tur.value = 'ALL';
  const ara = document.getElementById('study-search'); if (ara) ara.value = '';
}

function openFilteredStudy(statusType) {
  aramaVeTuruSifirla();
  document.getElementById('study-class-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = 'ALL';
  document.getElementById('study-status-filter').value = statusType;
  applyStudyFilters();
  switchView('study', statusType === 'wrong' ? 'mistakes' : 'study');
}

function filterCriticalFivePoints() {
  aramaVeTuruSifirla();
  document.getElementById('study-class-filter').value = 'ALL';
  document.getElementById('study-status-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = '5';
  applyStudyFilters();
  switchView('study');
}

function bugunTekrarSayisi() {
  return DB.filter(q => !isEskiKod95(q) && tekrarZamaniGeldi(q.code)).length;
}
function openTodayReview() {
  aramaVeTuruSifirla();
  document.getElementById('study-class-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = 'ALL';
  document.getElementById('study-status-filter').value = 'due';
  applyStudyFilters();
  switchView('study');
}

function filterTrapQuestions() {
  aramaVeTuruSifirla();
  document.getElementById('study-class-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = 'ALL';
  document.getElementById('study-status-filter').value = 'trap';
  applyStudyFilters();
  switchView('study');
}

function openMistakesAndFavorites() {
  const wrongCount = DB.filter(q => !isEskiKod95(q) && getLeitnerBox(q.code) === 'wrong').length;
  aramaVeTuruSifirla();
  document.getElementById('study-class-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = 'ALL';
  document.getElementById('study-status-filter').value = wrongCount > 0 ? 'wrong' : 'starred';
  applyStudyFilters();
  // Highlight the 'mistakes' tab in the topbar!
  switchView('study', 'mistakes');
}

// ── Study Mode Logic ─────────────────────────────────────────────────────
function isEskiKod95(q) {
  return !!(q.kaynak && (q.kaynak.durum === 'eski' || q.kaynak.durum === 'bulunamadi'));
}

function isKod95Question(q) {
  return Array.isArray(q.classes) && q.classes.includes('Kod 95');
}

// Counts shown in labels are computed from the data so they never drift out of sync.
function updateDynamicCounts() {
  const fmt = n => n.toLocaleString('tr-TR');
  const countClass = cls => DB.filter(q => questionBelongsToClass(q, cls) && !isEskiKod95(q)).length;

  const clsSel = document.getElementById('study-class-filter');
  if (clsSel) {
    Array.from(clsSel.options).forEach(opt => {
      if (!opt.dataset.baseLabel) opt.dataset.baseLabel = opt.textContent.trim();
      opt.textContent = `${opt.dataset.baseLabel} – ${fmt(countClass(opt.value))}`;
    });
  }

  const trapTotal = DB.filter(q => q.is_trap).length;
  const trapBtn = document.getElementById('dash-trap-btn');
  if (trapBtn) trapBtn.textContent = `🛑 Tuzak Sorular (${fmt(trapTotal)})`;
  const trapOpt = document.querySelector('#study-status-filter option[value="trap"]');
  if (trapOpt) trapOpt.textContent = `🛑 Tuzak Sorular (${fmt(trapTotal)})`;
}

function questionBelongsToClass(q, clsFilter) {
  if (clsFilter === 'ALL') return true;
  return Array.isArray(q.classes) && q.classes.includes(clsFilter);
}

function applyStudyFilters() {
  const searchVal = (document.getElementById('study-search')?.value || '').trim().toLowerCase();
  const clsVal = document.getElementById('study-class-filter')?.value || 'ALL';
  const ptsVal = document.getElementById('study-points-filter')?.value || 'ALL';
  const statusVal = document.getElementById('study-status-filter')?.value || 'ALL';
  const typeVal = document.getElementById('study-type-filter')?.value || 'ALL';

  studyFiltered = DB.filter(q => {
    if (!questionBelongsToClass(q, clsVal)) return false;
    if (ptsVal !== 'ALL' && String(q.points) !== ptsVal) return false;
    if (typeVal !== 'ALL' && q.type !== typeVal) return false;

    const box = getLeitnerBox(q.code);
    // 2026 resmi havuzundan çıkarılmış eski Kod 95 soruları yalnız kendi filtresinde görünür.
    const eskiSoru = isEskiKod95(q);
    if (statusVal === 'eski') return eskiSoru && (!searchVal || `${q.code} ${q.question_tr} ${q.question_de}`.toLowerCase().includes(searchVal));
    if (eskiSoru) return false;
    if (statusVal === 'trap' && !q.is_trap) return false;
    if (statusVal === 'unseen' && box !== 'unseen') return false;
    if (statusVal === 'wrong' && box !== 'wrong') return false;
    if (statusVal === 'learning' && box !== 'learning') return false;
    // Fixed Bug #3: Box 3 ('learned') strictly filters 3/3 mastered questions only!
    if (statusVal === 'learned' && box !== 'learned') return false;
    if (statusVal === 'starred' && !state.starred[q.code]) return false;
    if (statusVal === 'due' && !tekrarZamaniGeldi(q.code)) return false;
    if (statusVal === 'ozel' && ozelListe && !ozelListe.kodlar.has(q.code)) return false;

    if (searchVal) {
      const hay = `${q.code} ${q.question_tr} ${q.question_de}`.toLowerCase();
      if (!hay.includes(searchVal)) return false;
    }
    return true;
  });

  document.getElementById('study-filter-count').textContent = `${studyFiltered.length} soru`;
  // Aynı filtreye (ör. Klasse B) dönüldüğünde baştan değil, o filtrede kalınan sorudan devam et.
  const kayitli = aramaVarMi() ? null : filtreKonumOku()[filtreAnahtari()];
  const devamIdx = kayitli ? studyFiltered.findIndex(q => q.code === kayitli.code) : -1;
  studyIndex = devamIdx >= 0 ? devamIdx : 0;
  renderStudySidebarList();
  selectStudyQuestion(studyIndex);
}

// ── Filtre bazında kaldığın yer (v27) ── her filtre birleşimi kendi son sorusunu hatırlar
const FILTRE_KONUM_KEY = 'FAHRSCHULE_FILTRE_KONUM_V1';
function filtreAnahtari(sinif, puan, durum, tur, arama) {
  const deger = (id, v) => v != null ? v : (document.getElementById(id)?.value || 'ALL');
  // Son alan eskiden arama metniydi; artık hep boş (eski kayıtlarla aynı biçim kalsın diye duruyor).
  return [deger('study-class-filter', sinif), deger('study-points-filter', puan), deger('study-status-filter', durum), deger('study-type-filter', tur), ''].join('|');
}
function aramaVarMi() {
  return !!(document.getElementById('study-search')?.value || '').trim();
}
function filtreKonumOku() {
  try { const m = JSON.parse(localStorage.getItem(FILTRE_KONUM_KEY) || '{}'); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch (_) { return {}; }
}
function filtreKonumYaz(m) {
  // Eski sürümlerin arama metniyle açtığı kayıtları at (anahtarın son alanı dolu olanlar)
  const temiz = {};
  for (const [k, v] of Object.entries(m || {})) if (k.endsWith('|') && v && typeof v.code === 'string') temiz[k] = { code: v.code, ts: +v.ts || 0 };
  try { localStorage.setItem(FILTRE_KONUM_KEY, JSON.stringify(temiz)); } catch (_) {}
}
// Sınıf kartlarında "Kaldığın yer: 11 / 559" satırı
function sinifKonumlariniGoster() {
  const m = filtreKonumOku();
  document.querySelectorAll('.class-konum[data-sinif]').forEach(el => {
    const sinif = el.dataset.sinif;
    const k = m[filtreAnahtari(sinif, 'ALL', 'ALL', 'ALL', '')];
    const liste = k ? DB.filter(q => questionBelongsToClass(q, sinif) && !isEskiKod95(q)) : [];
    const i = k ? liste.findIndex(q => q.code === k.code) : -1;
    el.textContent = i >= 0 ? `📍 Kaldığın yer: ${i + 1} / ${liste.length}` : '';
  });
}

// Fixed Bug #6: Render ALL filtered questions in sidebar using fast DocumentFragment
function renderStudySidebarList() {
  const listEl = document.getElementById('study-q-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (let i = 0; i < studyFiltered.length; i++) {
    const q = studyFiltered[i];
    const box = getLeitnerBox(q.code);
    const isStarred = !!state.starred[q.code];

    const item = document.createElement('div');
    item.className = 'q-list-item' + (i === studyIndex ? ' active' : '');
    item.dataset.idx = i;

    let statusIcon = '⚪';
    if (box === 'learned') statusIcon = '🟩';
    else if (box === 'learning') statusIcon = '🟨';
    else if (box === 'wrong') statusIcon = '🟥';

    item.innerHTML = `
      <div class="q-list-top">
        <span>${statusIcon} ${esc(q.code)} ${isStarred ? '⭐' : ''}</span>
        <div class="q-list-badges">
          <span class="mini-pill ${q.points === 5 ? 'pts-5' : ''}">${q.points}P</span>
        </div>
      </div>
      <div class="q-list-title">${esc(q.question_tr)}</div>
    `;
    item.onclick = () => {
      selectStudyQuestion(i);
      closeStudyDrawer();
    };
    frag.appendChild(item);
  }
  listEl.appendChild(frag);
}

function selectStudyQuestion(idx) {
  if (!studyFiltered.length) {
    document.getElementById('study-question-container').innerHTML = `
      <div style="text-align:center;padding:40px 20px;color:var(--muted);">
        <div style="font-size:42px;margin-bottom:10px;">📭</div>
        <h3>Bu filtreye uygun soru bulunamadı</h3>
        <p style="font-size:13px;margin-top:6px;">Filtreleri sıfırlayarak tüm sorulara dönebilirsin.</p>
        <button class="btn btn-outline" style="margin-top:14px;" onclick="resetStudyFilters()">Filtreleri Sıfırla</button>
      </div>
    `;
    return;
  }

  studyIndex = Math.max(0, Math.min(idx, studyFiltered.length - 1));
  const curQ = studyFiltered[studyIndex];
  const numInputsCount = (curQ && Array.isArray(curQ.number_inputs) && curQ.number_inputs.length)
    ? curQ.number_inputs.length
    : 1;
  studySelectedChoices = new Set();
  studyNumberValues = Array(numInputsCount).fill('');
  studyActiveNumIdx = 0;
  studyRevealed = false;
  studySonuc = null;
  studyBakildi = false;
  studyLocalShowDE = false;
  studyShuffledOptions = curQ && Array.isArray(curQ.answers_tr)
    ? sikSirasi(curQ)
    : [];
  sonKonumKaydet(curQ);

  document.querySelectorAll('#study-q-list .q-list-item').forEach(el => {
    const match = Number(el.dataset.idx) === studyIndex;
    el.classList.toggle('active', match);
    if (match) el.scrollIntoView({ block: 'nearest' });
  });

  renderStudyQuestion();
}

function resetStudyFilters() {
  document.getElementById('study-search').value = '';
  document.getElementById('study-class-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = 'ALL';
  document.getElementById('study-status-filter').value = 'ALL';
  document.getElementById('study-type-filter').value = 'ALL';
  applyStudyFilters();
}

function renderStudyQuestion() {
  const container = document.getElementById('study-question-container');
  const q = studyFiltered[studyIndex];
  if (!q || !container) return;

  const showDE = state.alwaysShowDE || studyLocalShowDE;
  const isStarred = !!state.starred[q.code];
  const isLastQuestion = studyIndex >= studyFiltered.length - 1;

  let ptsClass = '';
  if (q.points === 5) ptsClass = 'pts-5';
  else if (q.points === 4) ptsClass = 'pts-4';

  container.innerHTML = `
    <div class="q-toolbar">
      <div class="q-meta-tags">
        <span class="q-tag">${studyIndex + 1} / ${studyFiltered.length}</span>
        <span class="q-tag">Kod: ${esc(q.code)}</span>
        <span class="q-tag cat">${esc(q.category)}</span>
        <span class="q-tag ${ptsClass}">${q.points} Puan ${q.points === 5 ? '⚠️' : ''}</span>
        ${renderLeitnerDotsHtml(q.code)}
      </div>
      <div class="q-tool-btns">
        <button class="tool-btn ${showDE ? 'active-de' : ''}" onclick="toggleStudyLocalDE()">
          🇩🇪 ${showDE ? 'Almancayı Gizle' : 'Almancasını Göster'}
        </button>
        <button class="tool-btn ${studyRevealed ? 'active-corr' : ''}" onclick="peekStudyCorrectAnswer()">
          👁️ ${studyRevealed ? 'Cevap Açık' : 'Doğru Cevabı Gör'}
        </button>
        <button class="tool-btn ${isStarred ? 'active-star' : ''}" onclick="toggleStar('${esc(q.code)}')">
          ${isStarred ? '⭐ Kayıtlı' : '☆ Kaydet'}
        </button>
      </div>
    </div>

    ${studySonucHtml(q)}
    <div class="q-title-tr">${esc(q.question_tr)}</div>
    ${sadeSoruHtml(q)}
    ${showDE && q.question_de ? `<div class="q-title-de">🇩🇪 ${esc(q.question_de)}</div>` : ''}
    ${q.pretext_tr ? `<div class="q-pretext">${esc(q.pretext_tr)}</div>` : ''}
    ${buildKaynakNotuHtml(q)}

    ${buildMediaHtml(q)}
    ${buildStudyAnswerAreaHtml(q)}

    ${studyRevealed && q.explanation_tr ? `
      <div class="tr-explanation-box">
        <b>🇹🇷 Neden böyle?</b><br/>
        ${esc(q.explanation_tr)}
      </div>
    ` : ''}

    ${showDE ? buildGermanReferenceHtml(q, studyRevealed) : ''}

    <div class="study-footer-nav">
      <button class="btn btn-outline" ${studyIndex <= 0 ? 'disabled' : ''} onclick="selectStudyQuestion(${studyIndex - 1})">
        ← Önceki Soru
      </button>

      ${!studyRevealed ? `
        <button class="btn btn-gold" style="min-width:210px;" onclick="checkStudyAnswer()">
          ✓ Cevabı Kontrol Et
        </button>
      ` : (isLastQuestion ? `
        <button class="btn btn-primary" style="min-width:210px;" onclick="selectStudyQuestion(0)">
          🏁 Liste Bitti (Başa Dön ↺)
        </button>
      ` : `
        <button class="btn btn-primary" style="min-width:210px;" onclick="selectStudyQuestion(${studyIndex + 1})">
          Sonraki Soruya Geç →
        </button>
      `)}

      <button class="btn btn-outline" ${isLastQuestion ? 'disabled' : ''} onclick="selectStudyQuestion(${studyIndex + 1})">
        Sonraki →
      </button>
    </div>
  `;
}

function toggleStudyLocalDE() {
  studyLocalShowDE = !studyLocalShowDE;
  renderStudyQuestion();
}

function peekStudyCorrectAnswer() {
  const q = studyFiltered[studyIndex];
  if (!q) return;
  studySonuc = null; // "Doğru cevabı gör" bir deneme değildir; geri bildirim kutusu gösterilmez
  if (studyRevealed) {
    const numCount = (Array.isArray(q.number_inputs) && q.number_inputs.length) ? q.number_inputs.length : 1;
    studyRevealed = false;
    studySelectedChoices.clear();
    studyNumberValues = Array(numCount).fill('');
    renderStudyQuestion();
    return;
  }
  studySelectedChoices.clear();
  studyBakildi = true;
  if (q.type === 'number') {
    const expNums = parseAllNumbers(q.correct_answer_text);
    const numCount = (Array.isArray(q.number_inputs) && q.number_inputs.length) ? q.number_inputs.length : 1;
    studyNumberValues = Array.from({ length: numCount }, (_, i) => expNums[i] != null ? String(expNums[i]) : '');
  } else {
    (q.answers_tr || []).forEach((a, idx) => {
      if (a.is_correct) {
        const key = String(a.num != null ? a.num : idx + 1);
        studySelectedChoices.add(key);
      }
    });
  }
  studyRevealed = true;
  renderStudyQuestion();
}

function openStudyDrawer() {
  if (!document.getElementById('view-study').classList.contains('active')) {
    switchView('study');
  }
  if (cekmeceAcikMi()) return;
  document.getElementById('study-sidebar-drawer')?.classList.add('drawer-open');
  document.getElementById('drawer-backdrop')?.classList.add('open');
  gecmiseYaz({ view: aktifGorunum, tab: aktifSekme, katman: 'cekmece' });
}

function cekmeceAcikMi() {
  return !!document.getElementById('study-sidebar-drawer')?.classList.contains('drawer-open');
}

// gecmistenGeldi=true: geri tuşuyla kapanıyor (geçmişe dokunma)
function closeStudyDrawer(gecmistenGeldi = false) {
  const acikti = cekmeceAcikMi();
  document.getElementById('study-sidebar-drawer')?.classList.remove('drawer-open');
  document.getElementById('drawer-backdrop')?.classList.remove('open');
  if (acikti && !gecmistenGeldi && history.state && history.state.katman === 'cekmece') {
    history.back(); // çekmecenin geçmiş kaydını geri al
  }
}

function toggleStar(code) {
  state.starred[code] = !state.starred[code];
  if (!state.starred[code]) delete state.starred[code];
  saveProgress();
  renderStudyQuestion();
  renderStudySidebarList();
}

// Sade Türkçe (v28): resmi sınav metni aynen kalır, altında anlaşılır anlatımı gösterilir.
function sadeSoruHtml(q) {
  return q && q.question_sade_tr && q.question_sade_tr !== q.question_tr
    ? `<div class="q-sade"><span class="q-sade-etiket">Kısaca</span>${esc(q.question_sade_tr)}</div>` : '';
}
function sadeSikHtml(a) {
  return a && a.sade && a.sade !== a.text ? `<div class="option-sade">${esc(a.sade)}</div>` : '';
}

// Şıklar ezber olmasın diye karıştırılır; levhalı (resimli) şıklarda sıra sabit kalır,
// çünkü açıklama ve Almanca kutusu A/B/C harfleriyle bu sıraya atıf yapar.
function sikSirasi(q) {
  const a = q.answers_tr || [];
  return a.some(x => x && x.img) ? a.slice() : sampleRandom(a, a.length);
}

// Resimli şık (ör. "Hangi trafik işareti…?" sorularında levha seçenekleri)
function sikResmiHtml(a) {
  if (!a || !a.img) return '';
  return `<span class="option-img-kap"><img class="option-img" src="media/${esc(a.img)}" alt="Şık görseli" loading="lazy" />`
    + `<button class="sik-buyut" type="button" aria-label="Görseli büyüt" onclick="event.stopPropagation(); openLightbox('media/${esc(a.img)}')">🔍</button></span>`;
}

function buildMediaHtml(q) {
  const imgs = q.media?.images || [];
  const vids = q.media?.videos || [];
  const posters = q.media?.posters || [];
  if (!imgs.length && !vids.length) return '';

  let html = '<div class="q-media-box">';
  if (vids.length) {
    vids.forEach((v, idx) => {
      const posterAttr = posters[idx] ? `poster="media/${esc(posters[idx])}"` : '';
      html += `
        <video controls preload="metadata" playsinline muted ${posterAttr}>
          <source src="media/${esc(v)}" type="video/mp4" onerror="videoAcilmadi(this)" />
        </video>
      `;
    });
  } else {
    imgs.forEach(img => {
      html += `<img src="media/${esc(img)}" alt="Soru Görseli" onclick="openLightbox('media/${esc(img)}')" />`;
    });
  }
  html += '</div>';
  return html;
}

// Fixed Bug #1: Render ALL number_inputs (1 or 2 boxes) and validate all of them!
function buildStudyAnswerAreaHtml(q) {
  if (q.type === 'number') {
    const inputs = (Array.isArray(q.number_inputs) && q.number_inputs.length)
      ? q.number_inputs
      : [{}];

    let feedbackHtml = '';
    if (studyRevealed) {
      const ok = evaluateNumberQuestion(q, studyNumberValues);
      feedbackHtml = ok
        ? `<div style="margin-top:12px;padding:10px 14px;border-radius:9px;background:var(--green-soft);border:1px solid var(--green);color:var(--green-ink);font-weight:700;">
             ✅ Doğru Cevap! (${esc(q.correct_answer_text)})
           </div>`
        : `<div style="margin-top:12px;padding:10px 14px;border-radius:9px;background:var(--red-soft);border:1px solid var(--red);color:var(--red-ink);font-weight:700;">
             ❌ Yanlış! Doğru Cevap: <b>${esc(q.correct_answer_text)}</b>
           </div>`;
    }

    const linesHtml = inputs.map((inp, idx) => {
      const before = inp.label_before || inp.label || '';
      const after = inp.label_after || inp.unit || '';
      const val = studyNumberValues[idx] ?? '';
      const isFocused = studyActiveNumIdx === idx;
      return `
        <div class="number-input-line">
          ${before ? `<span style="font-size:13px;color:var(--muted);">${esc(before)}</span>` : ''}
          <input id="study-num-input-${idx}" type="text" inputmode="decimal"
            class="num-field" style="${isFocused && inputs.length > 1 ? 'border-color:var(--primary);' : ''}"
            value="${esc(val)}" placeholder="?"
            ${studyRevealed ? 'readonly' : ''}
            onfocus="studyActiveNumIdx = ${idx}"
            oninput="studyActiveNumIdx = ${idx}; studyNumberValues[${idx}] = this.value"
            onkeydown="if (event.key === 'Enter') { event.preventDefault(); studyNumberValues[${idx}] = this.value; if (!studyRevealed) checkStudyAnswer(); }" />
          ${after ? `<span style="font-size:13px;color:var(--muted);">${esc(after)}</span>` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="number-answer-box">
        ${linesHtml}
        ${!studyRevealed ? `
          <div class="numpad-grid">
            ${['1','2','3','4','5','6','7','8','9','0',',','⌫'].map(k =>
              `<button class="numpad-key" onclick="pressStudyNumpad('${k}')">${k}</button>`
            ).join('')}
          </div>
        ` : ''}
        ${feedbackHtml}
      </div>
    `;
  }

  // Multiple choice (Shuffled order to prevent position memorization!)
  const answers = (studyShuffledOptions && studyShuffledOptions.length)
    ? studyShuffledOptions
    : (q.answers_tr || []);
  let html = cokDogruNotuHtml(q) + '<div class="options-list">';
  answers.forEach((a, displayIdx) => {
    const key = String(a.num != null ? a.num : displayIdx + 1);
    const displayLabel = String.fromCharCode(65 + displayIdx); // A, B, C
    const isSel = studySelectedChoices.has(key);
    const isCorr = !!a.is_correct;

    let rowCls = 'option-row';
    let badgeHtml = '';
    let checkSymbol = displayLabel;

    if (!studyRevealed) {
      if (isSel) {
        rowCls += ' selected';
        checkSymbol = '✓';
      }
    } else {
      if (isCorr && isSel) {
        rowCls += ' correct-hit';
        checkSymbol = '✓';
        badgeHtml = '<div class="option-status-badge" style="color:var(--green);">✓ Doğru İşaretledin</div>';
      } else if (!isCorr && isSel) {
        rowCls += ' wrong-hit';
        checkSymbol = '✕';
        badgeHtml = '<div class="option-status-badge" style="color:var(--red);">✕ Yanlış İşaretledin (Bu şık yanlış)</div>';
      } else if (isCorr && !isSel) {
        rowCls += ' missed-hit';
        checkSymbol = '!';
        badgeHtml = '<div class="option-status-badge" style="color:var(--gold);">⚠️ Bu şıkkı da işaretlemeliydin!</div>';
      }
    }

    html += `
      <div class="${rowCls}" onclick="toggleStudyChoice('${key}')">
        <div class="option-check">${checkSymbol}</div>
        <div class="option-content">
          ${sikResmiHtml(a)}${a.text ? `<div class="option-tr">${esc(a.text)}</div>` : ''}${sadeSikHtml(a)}
          ${badgeHtml}
        </div>
      </div>
    `;
  });
  html += '</div>';
  return html;
}

// Şıklı sorularda puanlama kuralını hatırlatan kısa not.
// TÜV/DEKRA: birden fazla şık doğru olabilir; soru ancak TÜM doğrular işaretlenip hiç yanlış
// işaretlenmezse doğru sayılır. IHK (Kod 95): 1 puanlık soruda 1, 2 puanlıkta 2 doğru şık vardır.
function cokDogruNotuHtml(q) {
  const dogruSayisi = (q.answers_tr || []).filter(a => a.is_correct).length;
  const metin = isKod95Question(q)
    ? `☑️ Bu soruda <b>${dogruSayisi}</b> doğru şık var. Hepsini işaretle; eksik veya fazla işaret yanlış sayılır.`
    : '☑️ Birden fazla şık doğru olabilir. <b>Tüm doğru şıkları</b> işaretle; eksik veya fazla işaret yanlış sayılır.';
  return `<div class="cok-dogru-notu" style="margin:6px 0 8px;font-size:12px;color:var(--muted);">${metin}</div>`;
}

// Kod 95: sorunun resmi DIHK havuzuyla karşılaştırma sonucu + "cevap resmi değil" uyarısı.
function buildKaynakNotuHtml(q) {
  if (!q.kaynak) return '';
  const k = q.kaynak;
  const iyi = k.durum === 'birebir' || k.durum === 'onarildi';
  const orta = k.durum === 'metin_farkli';
  const ikon = iyi ? '✅' : (orta ? '🟡' : '⚠️');
  const renk = iyi ? 'var(--green)' : (orta ? 'var(--gold)' : 'var(--red)');
  const kaynak = k.pdf_no ? ` <span style="opacity:.8;">(DIHK ${k.baski}, Bölüm ${esc(k.pdf_no.replace('.', ' • Soru '))})</span>` : '';
  const puan = k.resmi_puan ? ` Resmi puan: ${k.resmi_puan}.` : '';
  return `
    <div style="margin:10px 0;padding:9px 12px;border-radius:9px;border:1px solid ${renk};background:color-mix(in srgb, var(--muted) 6%, transparent);font-size:12.5px;line-height:1.5;">
      <div style="color:${renk};font-weight:700;">${ikon} ${esc(k.not)}${esc(puan)}${kaynak}</div>
      ${k.uyari ? `<div style="color:var(--gold);font-weight:700;margin-top:3px;">⚠️ ${esc(k.uyari)}</div>` : ''}
      <div style="color:var(--muted);margin-top:3px;">ℹ️ İşaretli cevap resmi değildir: DIHK yalnız soruları yayımlar, cevap anahtarı yayımlamaz.</div>
    </div>
  `;
}

function buildGermanReferenceHtml(q, showCorrectness) {
  if (!q.question_de && (!q.answers_de || !q.answers_de.length)) return '';
  const opts = q.answers_de || [];
  return `
    <div class="de-reference-box">
      <div class="de-reference-head">
        <span>🇩🇪 ALMANCA ORİJİNAL ŞIKLAR & AÇIKLAMA (${esc(q.theme_de || 'TÜV Katalog')})</span>
      </div>
      ${opts.length ? `
        <ul class="de-options-ul">
          ${opts.map(o => `
            <li class="${showCorrectness && o.is_correct ? 'de-corr' : ''}">
              <b>${esc(o.letter)}:</b> ${o.text ? esc(o.text) : (o.img ? '(levha / resim)' : '')}
              ${showCorrectness && o.is_correct ? ' <b style="color:var(--green);">✓ (Richtig)</b>' : ''}
            </li>
          `).join('')}
        </ul>
      ` : ''}
      ${showCorrectness && q.comment_de ? `
        <div class="de-comment">
          <b>💡 ${q.kaynak ? 'Kaynak Notu (DE)' : 'Resmi Açıklama (DE)'}:</b> ${esc(q.comment_de)}
        </div>
      ` : ''}
    </div>
  `;
}

function toggleStudyChoice(key) {
  if (studyRevealed) return;
  if (studySelectedChoices.has(key)) studySelectedChoices.delete(key);
  else studySelectedChoices.add(key);
  renderStudyQuestion();
}

function pressStudyNumpad(key) {
  if (studyRevealed) return;
  const idx = studyActiveNumIdx || 0;
  let cur = String(studyNumberValues[idx] || '');
  if (key === '⌫') cur = cur.slice(0, -1);
  else if (key === ',') {
    if (!cur.includes(',')) cur += ',';
  } else {
    cur += key;
  }
  studyNumberValues[idx] = cur;
  renderStudyQuestion();
}

function checkStudyAnswer() {
  const q = studyFiltered[studyIndex];
  if (!q) return;
  const bos = q.type === 'number'
    ? !(studyNumberValues || []).some(v => String(v ?? '').trim())
    : studySelectedChoices.size === 0;
  if (bos) {
    kisaBildirim(q.type === 'number' ? 'Önce cevabı yaz, sonra kontrol et.' : 'Önce en az bir şık seç, sonra kontrol et.');
    return;
  }

  let isCorrect = false;
  if (q.type === 'number') {
    isCorrect = evaluateNumberQuestion(q, studyNumberValues);
  } else {
    isCorrect = evaluateChoiceQuestion(q, studySelectedChoices);
  }

  // Kontrol sonucunun özeti: ekranın üstünde büyük geri bildirim olarak gösterilir
  if (q.type === 'number') {
    studySonuc = { dogru: isCorrect, sayi: true };
  } else {
    const dogrular = (q.answers_tr || []).filter(a => a.is_correct).map((a, i) => String(a.num != null ? a.num : i + 1));
    const secili = Array.from(studySelectedChoices).map(String);
    studySonuc = {
      dogru: isCorrect,
      eksik: dogrular.filter(k => !secili.includes(k)).length,
      fazla: secili.filter(k => !dogrular.includes(k)).length,
      toplamDogru: dogrular.length
    };
  }
  studyRevealed = true;
  studySonuc.tekrar = recordQuestionAttempt(q.code, isCorrect, { bakildi: studyBakildi });
  gunlukSay();
  renderStudyQuestion();
  renderStudySidebarList();
  const kutu = document.getElementById('study-sonuc');
  if (kutu) kutu.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// 1) Hızlı geri bildirim: kontrol sonrası sorunun üstünde büyük, renkli sonuç
function tekrarNotuHtml(t) {
  if (!t) return '';
  if (t.bakildi) return `<small class="tekrar-not">👁️ Cevaba baktığın için ilerlemeye sayılmadı; bu soru ${tekrarMetni(t.tekrar)} yeniden sorulacak.</small>`;
  if (t.erken) return `<small class="tekrar-not">⏳ Tekrar zamanı gelmeden çözdün; aşama ilerlemedi. Sıradaki tekrar: ${tekrarMetni(t.tekrar)}.</small>`;
  if (t.sayildi) return `<small class="tekrar-not">🔁 ${t.asama >= 3 ? 'Öğrenildi (3/3)! ' : `Aşama ${t.asama}/3. `}Sıradaki tekrar: ${tekrarMetni(t.tekrar)}.</small>`;
  return `<small class="tekrar-not">🔁 Bu soru bugün yeniden tekrar listende.</small>`;
}
function studySonucHtml(q) {
  if (!studyRevealed || !studySonuc) return '';
  const s = studySonuc;
  if (s.dogru) {
    return `<div id="study-sonuc" class="sonuc-kutu sonuc-dogru" role="status">✅ Doğru!<small>${s.sayi ? 'Cevabın doğru.' : (s.toplamDogru > 1 ? `${s.toplamDogru} doğru şıkkın hepsini buldun.` : 'Doğru şıkkı buldun.')}</small>${tekrarNotuHtml(s.tekrar)}</div>`;
  }
  let neden = '';
  if (s.sayi) neden = `Doğru cevap: ${esc(q.correct_answer_text)}`;
  else {
    const parca = [];
    if (s.eksik) parca.push(`${s.eksik} doğru şıkkı kaçırdın`);
    if (s.fazla) parca.push(`${s.fazla} yanlış şıkkı işaretledin`);
    neden = parca.join(', ') + '.' + (s.toplamDogru > 1 ? ` Bu soruda ${s.toplamDogru} doğru şık vardı; hepsini işaretlemelisin.` : '');
  }
  return `<div id="study-sonuc" class="sonuc-kutu sonuc-yanlis" role="status">❌ Yanlış<small>${neden}</small>${tekrarNotuHtml(s.tekrar)}</div>`;
}

// 5) Günlük hedef ve çalışma serisi
function bugunAnahtar(tarih = new Date()) {
  const y = tarih.getFullYear(), m = String(tarih.getMonth() + 1).padStart(2, '0'), g = String(tarih.getDate()).padStart(2, '0');
  return `${y}-${m}-${g}`;
}
function gunlukTemizle(g) {
  const t = {};
  for (const [gun, n] of Object.entries(g || {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(gun) && Number.isFinite(+n) && +n > 0) t[gun] = Math.floor(+n);
  }
  return t;
}
function cihazKimligi() {
  try {
    let id = localStorage.getItem('FAHRSCHULE_CIHAZ_ID');
    if (!id || !/^[a-z0-9]{6,32}$/.test(id)) {
      id = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
      localStorage.setItem('FAHRSCHULE_CIHAZ_ID', id);
    }
    return id;
  } catch (_) { return 'yerel000'; }
}
// v31 öncesi sayaç (state.gunluk) dondurulmuş "eski" kısımdır; yeni sayımlar cihaz kovasına yazılır.
function gunlukDeger(gun) {
  let n = (state.gunluk || {})[gun] || 0;
  for (const g of Object.values(state.gunlukCihaz || {})) n += (g && g[gun]) || 0;
  return n;
}
function gunlukSay(adet = 1) {
  if (!state.gunlukCihaz || typeof state.gunlukCihaz !== 'object') state.gunlukCihaz = {};
  const id = cihazKimligi();
  const k = bugunAnahtar();
  const g = state.gunlukCihaz[id] || (state.gunlukCihaz[id] = {});
  g[k] = (g[k] || 0) + adet;
  saveProgress();
}
function calismaSerisi() {
  const gun = new Date();
  if (!gunlukDeger(bugunAnahtar(gun))) gun.setDate(gun.getDate() - 1); // bugün henüz çalışılmadıysa dünden say
  let seri = 0;
  while (gunlukDeger(bugunAnahtar(gun)) > 0) { seri++; gun.setDate(gun.getDate() - 1); }
  return seri;
}
function gunlukHedefSec(n) {
  state.gunlukHedef = n;
  saveProgress();
  renderDashUst();
}

// 4) Kaldığın yerden devam: son çalışılan soru ve filtreler
const SON_KONUM_KEY = 'FAHRSCHULE_SON_KONUM_V1';
function sonKonumKaydet(q) {
  if (!q || !document.getElementById('view-study')?.classList.contains('active')) return;
  const deger = id => document.getElementById(id)?.value || 'ALL';
  try {
    localStorage.setItem(SON_KONUM_KEY, JSON.stringify({
      code: q.code, ts: Date.now(),
      arama: document.getElementById('study-search')?.value || '',
      sinif: deger('study-class-filter'), puan: deger('study-points-filter'),
      durum: deger('study-status-filter'), tur: deger('study-type-filter'),
      sira: studyIndex + 1, toplam: studyFiltered.length
    }));
  } catch (_) {}
  if (aramaVarMi()) return; // aramada gezinmek sınıfta kaldığın yeri değiştirmesin
  const m = filtreKonumOku();
  m[filtreAnahtari()] = { code: q.code, ts: Date.now() };
  filtreKonumYaz(m);
}
function sonKonumOku() {
  try { return JSON.parse(localStorage.getItem(SON_KONUM_KEY) || 'null'); } catch (_) { return null; }
}
function kaldiginYerdenDevam() {
  const k = sonKonumOku();
  if (!k) { switchView('study'); return; }
  const ata = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  ata('study-search', k.arama || '');
  ata('study-class-filter', k.sinif); ata('study-points-filter', k.puan);
  ata('study-status-filter', k.durum); ata('study-type-filter', k.tur);
  applyStudyFilters();
  switchView('study');
  const i = studyFiltered.findIndex(q => q.code === k.code);
  if (i >= 0) selectStudyQuestion(i);
}

function renderDashUst() {
  const kap = document.getElementById('dash-ust');
  if (!kap) return;
  const k = sonKonumOku();
  const q = k && DB.find(x => x.code === k.code);
  const sinifAd = { ALL: 'Tüm sorular', Grundstoff: 'Grundstoff', 'Klasse B': 'Klasse B', 'Klasse C': 'Klasse C', 'Klasse CE': 'Klasse CE', 'Kod 95': 'Kod 95' };
  const devam = q ? `
    <div class="dash-kart dash-devam">
      <span class="dash-etiket">Kaldığın yerden devam</span>
      <strong>${esc(sinifAd[k.sinif] || k.sinif)} · Soru ${k.sira} / ${k.toplam}</strong>
      <span class="dash-soluk">${esc((q.question_tr || '').slice(0, 90))}${(q.question_tr || '').length > 90 ? '…' : ''}</span>
      <button class="btn btn-primary ada" onclick="kaldiginYerdenDevam()">Devam et<span class="ok" aria-hidden="true">↗</span></button>
    </div>` : `
    <div class="dash-kart dash-devam">
      <span class="dash-etiket">Başla</span>
      <strong>İlk sorudan başla</strong>
      <span class="dash-soluk">Çalıştıkça burada kaldığın soru görünecek.</span>
      <button class="btn btn-primary ada" onclick="switchView('study')">Soru çalış<span class="ok" aria-hidden="true">↗</span></button>
    </div>`;
  const simdi = new Date(), saat = simdi.getHours();
  const tarihEl = document.getElementById('dash-tarih'), selamEl = document.getElementById('dash-selam-yazi');
  if (tarihEl) tarihEl.textContent = simdi.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
  if (selamEl) selamEl.textContent = saat < 5 ? 'İyi geceler' : saat < 11 ? 'Günaydın' : saat < 17 ? 'İyi günler' : saat < 22 ? 'İyi akşamlar' : 'İyi geceler';
  const hedef = state.gunlukHedef || 30;
  const bugun = gunlukDeger(bugunAnahtar());
  const seri = calismaSerisi();
  const yuzde = Math.min(100, Math.round(bugun / hedef * 100));
  const hedefDugmeleri = [10, 20, 30, 50].map(n =>
    `<button class="hedef-btn${n === hedef ? ' secili' : ''}" onclick="gunlukHedefSec(${n})" aria-pressed="${n === hedef}">${n}</button>`).join('');
  const yarim = sinavSuruyor() ? null : sinavKaydiOku();
  const sinavKart = yarim ? `
    <div class="dash-kart dash-devam dash-sinav-yarim">
      <span class="dash-etiket">Yarım kalan sınav</span>
      <strong>${sinavOzetMetni(yarim)}</strong>
      <button class="btn btn-primary ada" onclick="sinavDevamEt()">Sınava dön<span class="ok" aria-hidden="true">↗</span></button>
    </div>` : '';
  const tekrarSayi = bugunTekrarSayisi();
  const tekrarKart = tekrarSayi > 0 ? `
    <div class="dash-kart dash-tekrar">
      <span class="dash-etiket">Bugünkü tekrar</span>
      <strong>🔁 Tekrar zamanı gelen ${tekrarSayi.toLocaleString('tr-TR')} soru var</strong>
      <span class="dash-soluk">Yanlış yaptıkların ve tekrar günü gelenler. Unutmadan pekiştir.</span>
      <button class="btn btn-primary ada" onclick="openTodayReview()">Tekrar et<span class="ok" aria-hidden="true">↗</span></button>
    </div>` : '';
  kap.innerHTML = sinavKart + tekrarKart + devam + `
    <div class="dash-kart dash-hedef">
      <div class="hedef-ust">
        <div class="halka" style="--p:${yuzde}" role="img" aria-label="Bugünkü hedefin yüzde ${yuzde} kadarı tamam"><span>${yuzde}%</span></div>
        <div class="hedef-yazi">
          <span class="dash-etiket">Bugünkü hedef</span>
          <strong>${bugun} / ${hedef} soru${bugun >= hedef ? ' · tamam 🎉' : ''}</strong>
          <span class="seri-rozet">🔥 ${seri} gün seri</span>
        </div>
      </div>
      <div class="dash-satir"><span class="dash-soluk">Günlük hedef</span><span class="hedef-grup">${hedefDugmeleri}</span></div>
    </div>`;
}

// ── Açık / koyu tema (v23) ── seçim cihazda saklanır; seçim yoksa cihazın ayarı geçerli
function etkinTema() {
  const t = document.documentElement.dataset.tema;
  if (t === 'acik' || t === 'koyu') return t;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'koyu' : 'acik';
}
function temaDugmesiGuncelle() {
  const koyu = etkinTema() === 'koyu';
  const btn = document.getElementById('tema-btn');
  if (btn) {
    btn.textContent = koyu ? '☀️' : '🌙';
    btn.setAttribute('aria-label', koyu ? 'Açık temaya geç' : 'Koyu temaya geç');
  }
  if (document.documentElement.dataset.tema) {
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', koyu ? '#0b1020' : '#dfe9f6'));
  }
}
function temaDegistir() {
  const yeni = etkinTema() === 'koyu' ? 'acik' : 'koyu';
  document.documentElement.dataset.tema = yeni;
  try { localStorage.setItem('FAHRSCHULE_TEMA', yeni); } catch (_) {}
  temaDugmesiGuncelle();
}
if (window.matchMedia) {
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', temaDugmesiGuncelle); } catch (_) {}
}
temaDugmesiGuncelle();

// ── Aralıklı tekrar (v32) ──────────────────────────────────────────────
// Bir soru, art arda aynı gün 3 kez doğru bilinince "öğrenildi" sayılmaz. Her doğru cevaptan
// sonra soru bir sonraki tekrar gününe kadar bekler: 1. doğru → 1 gün, 2. → 3 gün, 3. → 7 gün
// (3/3 = öğrenildi), sonrası → 30 gün. Vakti gelmeden doğru çözmek aşamayı ilerletmez.
// Yanlış cevap aşamayı sıfırlar ve soru aynı gün yeniden tekrar listesine girer.
// Cevaba bakıp sonra doğru işaretlemek aşamayı ilerletmez; soru ertesi gün yeniden sorulur.
const TEKRAR_ARALIGI = [0, 1, 3, 7, 30]; // yeni aşamaya göre gün
function gunEkle(gun, n) {
  const [y, a, g] = gun.split('-').map(Number);
  return bugunAnahtar(new Date(y, a - 1, g + n));
}
// Bir sorunun sıradaki tekrar günü (YYYY-MM-DD). Eski kayıtlarda alan yoksa son görülme + aralıktan hesaplanır.
function tekrarGunu(st) {
  if (!st) return null;
  if (st.status === 'wrong' || !(st.correctStreak > 0)) return st.tekrar || bugunAnahtar();
  if (typeof st.tekrar === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(st.tekrar)) return st.tekrar;
  const son = st.lastSeen ? bugunAnahtar(new Date(st.lastSeen)) : bugunAnahtar();
  return gunEkle(son, TEKRAR_ARALIGI[Math.min(4, st.correctStreak)]);
}
function tekrarZamaniGeldi(code) {
  const st = state.qStats[code];
  return !!st && tekrarGunu(st) <= bugunAnahtar();
}
function gunFarki(gun) {
  const [y, a, g] = gun.split('-').map(Number);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, a - 1, g) - b) / 86400000);
}
function tekrarMetni(gun) {
  const f = gunFarki(gun);
  if (f <= 0) return 'bugün';
  if (f === 1) return 'yarın';
  const [y, a, g] = gun.split('-').map(Number);
  return `${f} gün sonra (${new Date(y, a - 1, g).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })})`;
}
// Sonuç: { sayildi, erken, bakildi, asama, tekrar }
function recordQuestionAttempt(code, isCorrect, secenek = {}) {
  const prev = state.qStats[code] || { status: 'unseen', correctStreak: 0, wrongCount: 0 };
  const bugun = bugunAnahtar();
  const sonuc = { sayildi: false, erken: false, bakildi: false };
  if (isCorrect && secenek.bakildi) {
    // Cevaba bakarak doğru: bilinmiyor sayılır, aşama değişmez, yarın yeniden sorulur
    sonuc.bakildi = true;
    if (!prev.correctStreak) prev.status = 'wrong'; // aşaması 0 olan soru 'bilinmiyor' kutusunda kalır
    const yarin = gunEkle(bugun, 1);
    const eski = tekrarGunu(state.qStats[code]);
    prev.tekrar = eski && eski < yarin ? eski : yarin;
  } else if (isCorrect) {
    const vakit = !state.qStats[code] || prev.status === 'wrong' || tekrarGunu(prev) <= bugun;
    if (vakit) {
      prev.correctStreak = Math.min(4, (prev.correctStreak || 0) + 1);
      prev.tekrar = gunEkle(bugun, TEKRAR_ARALIGI[prev.correctStreak]);
      sonuc.sayildi = true;
    } else {
      prev.tekrar = tekrarGunu(prev); // eski kayıtlarda tarihi sabitle
      sonuc.erken = true;
    }
    prev.status = prev.correctStreak >= 3 ? 'learned' : 'learning';
  } else {
    prev.correctStreak = 0;
    prev.wrongCount = (prev.wrongCount || 0) + 1;
    prev.status = 'wrong';
    prev.tekrar = bugun;
  }
  prev.lastSeen = Date.now();
  state.qStats[code] = prev;
  saveProgress();
  sonuc.asama = Math.min(3, prev.correctStreak || 0);
  sonuc.tekrar = tekrarGunu(prev);
  return sonuc;
}

// ── Shared Evaluation Helpers (Supports Single & Multi-Input Numbers!) ───
function parseAllNumbers(str) {
  if (!str) return [];
  const norm = String(str).replace(/,/g, '.');
  const matches = norm.match(/-?\d+(?:\.\d+)?/g);
  return matches ? matches.map(Number).filter(Number.isFinite) : [];
}

function evaluateNumberQuestion(q, givenRawOrArray) {
  const expectedNums = parseAllNumbers(q.correct_answer_text);
  if (!expectedNums.length) return false;

  const givenArr = Array.isArray(givenRawOrArray) ? givenRawOrArray : [givenRawOrArray];
  if (expectedNums.length === 1) {
    const g = parseAllNumbers(givenArr[0])[0];
    return g != null && Math.abs(expectedNums[0] - g) < 1e-6;
  }

  // Multi-input question (e.g., 2.2.30-202: [7, 20], 2.2.30-203: [0, 22])
  if (givenArr.length < expectedNums.length) return false;
  for (let i = 0; i < expectedNums.length; i++) {
    const g = parseAllNumbers(givenArr[i])[0];
    if (g == null || Math.abs(expectedNums[i] - g) >= 1e-6) return false;
  }
  return true;
}

function evaluateChoiceQuestion(q, selectedSet) {
  const answers = q.answers_tr || [];
  const expectedKeys = answers
    .filter(a => !!a.is_correct)
    .map((a, idx) => String(a.num != null ? a.num : idx + 1))
    .sort();
  const givenKeys = Array.from(selectedSet).map(String).sort();
  if (expectedKeys.length !== givenKeys.length) return false;
  return expectedKeys.every((val, i) => val === givenKeys[i]);
}

// ── Official TÜV / DEKRA & IHK Exam Simulation Engine ────────────────────
function selectExamMode(mode) {
  selectedExamMode = mode;
  document.querySelectorAll('.exam-mode-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.mode === mode);
  });
}

function quickStartExam(mode) {
  if (!yeniSinavOnayi()) { switchView('exam'); return; }
  switchView('exam');
  selectExamMode(mode);
  startSelectedExam(false);
}

function startSelectedExam(smartWeighted = false, onayli = false) {
  if (!onayli && !yeniSinavOnayi()) return;
  isMistakesExamActive = false;
  examSmartWeightedActive = smartWeighted;
  if (selectedExamMode === 'COMBO') {
    comboCurrentStageIdx = 0;
    launchExamStage(comboStages[0], true, smartWeighted);
  } else {
    launchExamStage(selectedExamMode, false, smartWeighted);
  }
}

function restartCurrentExamType() {
  if (isMistakesExamActive) {
    startMistakesExam(true);
  } else {
    startSelectedExam(examSmartWeightedActive, true);
  }
}

function sampleSmartWeighted(pool, count) {
  const buckets = { wrong: [], due: [], unseen: [], learning: [], learned: [] };
  pool.forEach(q => {
    const b = getLeitnerBox(q.code);
    buckets[b !== 'wrong' && b !== 'unseen' && tekrarZamaniGeldi(q.code) ? 'due' : b].push(q);
  });
  const ordered = [
    ...sampleRandom(buckets.wrong, buckets.wrong.length),
    ...sampleRandom(buckets.due, buckets.due.length),
    ...sampleRandom(buckets.unseen, buckets.unseen.length),
    ...sampleRandom(buckets.learning, buckets.learning.length),
    ...sampleRandom(buckets.learned, buckets.learned.length)
  ];
  return ordered.slice(0, count);
}

function sampleOfficialQuota(pool, count, smartWeighted, quotas) {
  const baseOrder = smartWeighted ? sampleSmartWeighted(pool, pool.length) : sampleRandom(pool, pool.length);
  const picked = [];
  const usedCodes = new Set();

  function takeMatching(predicate, needed) {
    let got = 0;
    for (const q of baseOrder) {
      if (got >= needed || picked.length >= count) break;
      if (!usedCodes.has(q.code) && predicate(q)) {
        picked.push(q);
        usedCodes.add(q.code);
        got++;
      }
    }
  }

  if (quotas.fivePt) takeMatching(q => q.points === 5, quotas.fivePt);
  if (quotas.video) takeMatching(q => q.type === 'video', quotas.video);
  if (quotas.number) takeMatching(q => q.type === 'number', quotas.number);
  if (quotas.fourPt) takeMatching(q => q.points === 4, quotas.fourPt);

  takeMatching(() => true, count - picked.length);
  return sampleRandom(picked, picked.length);
}

function launchExamStage(clsKey, isCombo, smartWeighted = false) {
  isMistakesExamActive = false;
  activeExamClass = clsKey;
  const cfg = EXAM_CONFIG[clsKey];

  if (cfg.isIHK) {
    // Sınav simülasyonu yalnız güncel (2026) resmi havuzda bulunan sorulardan kurulur;
    // eski baskıdan kalan, bulunamayan ve şıkları uydurulmuş sorular yalnız çalışma modunda görünür.
    const sinavaUygun = q => !q.kaynak || !['eski', 'bulunamadi', 'sik_uydurma'].includes(q.kaynak.durum);
    const kb1Pool = DB.filter(q => q.classes.includes('Kod 95 KB1') && sinavaUygun(q));
    const kb2Pool = DB.filter(q => q.classes.includes('Kod 95 KB2') && sinavaUygun(q));
    const kb3Pool = DB.filter(q => q.classes.includes('Kod 95 KB3') && sinavaUygun(q));
    const sampler = smartWeighted ? sampleSmartWeighted : sampleRandom;
    examQuestions = [
      ...sampler(kb1Pool, 20),
      ...sampler(kb2Pool, 15),
      ...sampler(kb3Pool, 15)
    ];
  } else {
    const grundPool = DB.filter(q => q.classes.includes('Grundstoff'));
    const classPool = DB.filter(q => q.classes.includes(cfg.classMatch));

    const pickedGrund = sampleOfficialQuota(grundPool, cfg.grundCount, smartWeighted, {
      fivePt: clsKey === 'B' ? 3 : 2,
      video: 2,
      number: 1,
      fourPt: clsKey === 'B' ? 6 : 3
    });
    const pickedClass = sampleOfficialQuota(classPool, cfg.classCount, smartWeighted, {
      fivePt: 1,
      video: 1,
      number: 1,
      fourPt: Math.max(3, Math.floor(cfg.classCount * 0.35))
    });

    examQuestions = [...pickedGrund, ...pickedClass];
  }

  examIdx = 0;
  examActiveNumIdx = 0;
  examAnswers.clear();
  examFlags.clear();
  examVideoState.clear();
  examOptionOrder.clear();
  examQuestions.forEach(q => {
    if (Array.isArray(q.answers_tr) && q.answers_tr.length) {
      examOptionOrder.set(q.code, sikSirasi(q));
    }
  });
  examLocalShowDE = false;

  document.getElementById('exam-setup-view').style.display = 'none';
  document.getElementById('exam-result-view').style.display = 'none';
  document.getElementById('exam-active-view').style.display = 'block';

  const stagePrefix = isCombo ? `[Kombo Oturum ${comboCurrentStageIdx + 1}/3] ` : (smartWeighted ? '[🧠 Zeki Sınav] ' : '');
  document.getElementById('exam-stage-title').textContent = `${stagePrefix}${cfg.title} — ${examQuestions.length} Soru`;

  startExamTimer(cfg.isIHK ? 90 * 60 : 45 * 60);
  renderExamQuestion();
}

// Fixed Bug #2: Mistakes Exam sets activeExamClass = 'MISTAKES' and isMistakesExamActive = true
function startMistakesExam(onayli = false) {
  if (onayli !== true && !yeniSinavOnayi()) { switchView('exam'); return; }
  const wrongPool = DB.filter(q => getLeitnerBox(q.code) === 'wrong');
  const starredPool = DB.filter(q => state.starred[q.code] && getLeitnerBox(q.code) !== 'wrong');
  // Trap filler questions must match the track the user is studying:
  // Kod 95 (IHK) traps only when the Kod 95 exam is selected, otherwise only TÜV (B/C/CE) traps.
  const wantKod95 = selectedExamMode === 'KOD95';
  const trapPool = DB.filter(q =>
    q.is_trap &&
    !isEskiKod95(q) &&
    isKod95Question(q) === wantKod95 &&
    getLeitnerBox(q.code) !== 'wrong' &&
    !state.starred[q.code]
  );

  let combined = [...sampleRandom(wrongPool, wrongPool.length), ...sampleRandom(starredPool, starredPool.length)];
  let modeLabel = '⚡ Hatalarım & Favorilerim İntikam Sınavı';
  if (combined.length < 15) {
    combined = [...combined, ...sampleRandom(trapPool, 20 - combined.length)];
    modeLabel = '⚡ Hatalarım + 🛑 Tuzak Sorular Özel Sınavı';
  } else {
    combined = combined.slice(0, 30);
  }

  isMistakesExamActive = true;
  activeExamClass = 'MISTAKES';
  EXAM_CONFIG.MISTAKES.title = modeLabel;
  examQuestions = combined;
  examIdx = 0;
  examActiveNumIdx = 0;
  examAnswers.clear();
  examFlags.clear();
  examVideoState.clear();
  examOptionOrder.clear();
  examQuestions.forEach(q => {
    if (Array.isArray(q.answers_tr) && q.answers_tr.length) {
      examOptionOrder.set(q.code, sikSirasi(q));
    }
  });
  examLocalShowDE = false;

  switchView('exam');
  document.getElementById('exam-setup-view').style.display = 'none';
  document.getElementById('exam-result-view').style.display = 'none';
  document.getElementById('exam-active-view').style.display = 'block';
  document.getElementById('exam-stage-title').textContent = `${modeLabel} — ${examQuestions.length} Soru`;

  startExamTimer(30 * 60);
  renderExamQuestion();
}

function startExamTimer(seconds) {
  if (examTimerInterval) clearInterval(examTimerInterval);
  examSecondsLeft = seconds;
  examPaused = false;
  sinavSonDakikaUyarildi = false;
  updateExamTimerDisplay();
  examTimerInterval = setInterval(() => {
    if (examPaused) return;
    examSecondsLeft--;
    updateExamTimerDisplay();
    if (examSecondsLeft % 5 === 0) sinavKaydet();
    if (examSecondsLeft <= 0) {
      clearInterval(examTimerInterval);
      finalizeExam();
    }
  }, 1000);
}

function updateExamTimerDisplay() {
  const m = Math.floor(Math.max(0, examSecondsLeft) / 60);
  const s = Math.max(0, examSecondsLeft) % 60;
  const el = document.getElementById('exam-timer');
  if (el) {
    el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    // 2) Son 5 dakika: süre kırmızı yanıp söner ve bir kez uyarı çıkar
    const sonDakikalar = examSecondsLeft <= 300 && examSecondsLeft > 0;
    el.classList.toggle('son-dakikalar', sonDakikalar);
    if (sonDakikalar && !sinavSonDakikaUyarildi && examQuestions.length) {
      sinavSonDakikaUyarildi = true;
      const kalan = examQuestions.length - examQuestions.filter(isExamQuestionAnswered).length;
      kisaBildirim(`⏰ Son 5 dakika! ${kalan > 0 ? kalan + ' soru cevaplanmadı.' : 'Tüm sorular cevaplandı.'}`);
    }
  }
}

// Ekranın altında birkaç saniye görünen kısa bildirim
function kisaBildirim(metin) {
  let el = document.getElementById('kisa-bildirim');
  if (!el) {
    el = document.createElement('div');
    el.id = 'kisa-bildirim';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = metin;
  el.classList.add('gorunur');
  clearTimeout(el._zaman);
  el._zaman = setTimeout(() => el.classList.remove('gorunur'), 5000);
}

// 2) Sınav üst çubuğundaki ilerleme göstergesi
function sinavIlerlemeGuncelle() {
  const cubuk = document.getElementById('exam-progress-fill');
  if (!cubuk || !examQuestions.length) return;
  const cevap = examQuestions.filter(isExamQuestionAnswered).length;
  cubuk.style.width = Math.round(cevap / examQuestions.length * 100) + '%';
}

function isExamQuestionAnswered(q) {
  const ans = examAnswers.get(q.code);
  if (!ans) return false;
  if (q.type === 'number') {
    const reqCount = (Array.isArray(q.number_inputs) && q.number_inputs.length) ? q.number_inputs.length : 1;
    const vals = Array.isArray(ans.numberVals) ? ans.numberVals : [];
    for (let i = 0; i < reqCount; i++) {
      if (!String(vals[i] || '').trim()) return false;
    }
    return true;
  }
  return ans.selected && ans.selected.size > 0;
}

function playExamVideo(code) {
  const vState = examVideoState.get(code) || { plays: 0, unlockedOptions: false };
  if (vState.plays >= 5 || vState.unlockedOptions) return;
  vState.plays += 1;
  examVideoState.set(code, vState);
  renderExamQuestion();

  setTimeout(() => {
    const vidEl = document.getElementById('tuv-exam-video-el');
    if (vidEl) {
      vidEl.currentTime = 0;
      vidEl.play().catch(() => {});
    }
  }, 60);
}

// Video yüklenemezse sessizce boş kalmasın: açıklama + yeniden deneme düğmesi göster.
function videoAcilmadi(kaynak) {
  const video = kaynak && kaynak.closest ? kaynak.closest('video') : null;
  if (!video || video.nextElementSibling?.classList?.contains('video-hata')) return;
  const kutu = document.createElement('div');
  kutu.className = 'video-hata';
  kutu.setAttribute('role', 'alert');
  kutu.innerHTML = '⚠️ Video açılamadı. Bağlantını kontrol edip yeniden dene. Sorun sürerse sayfayı normal yenile (Ctrl+Shift+R değil). '
    + '<button class="btn btn-outline" type="button">Yeniden dene</button>';
  kutu.querySelector('button').onclick = () => { kutu.remove(); video.load(); };
  video.after(kutu);
}

function unlockExamVideoOptions(code) {
  const vState = examVideoState.get(code) || { plays: 1, unlockedOptions: false };
  vState.unlockedOptions = true;
  examVideoState.set(code, vState);
  renderExamQuestion();
}

function renderExamQuestion() {
  const q = examQuestions[examIdx];
  if (!q) return;
  document.documentElement.classList.add('sinav-acik');
  sinavKaydet();

  const answeredTotal = examQuestions.filter(isExamQuestionAnswered).length;
  document.getElementById('exam-progress-sub').textContent =
    `Soru ${examIdx + 1} / ${examQuestions.length} • Cevaplanan: ${answeredTotal} / ${examQuestions.length}`;

  const showDE = state.alwaysShowDE || examLocalShowDE;
  const isFlagged = examFlags.has(q.code);
  const reqNumCount = (Array.isArray(q.number_inputs) && q.number_inputs.length) ? q.number_inputs.length : 1;
  const savedAns = examAnswers.get(q.code) || { selected: new Set(), numberVals: Array(reqNumCount).fill('') };

  const hasVideo = Array.isArray(q.media?.videos) && q.media.videos.length > 0;
  const vState = examVideoState.get(q.code) || { plays: 0, unlockedOptions: false };

  let mediaAndAnswerHtml = '';

  if (hasVideo && !vState.unlockedOptions) {
    const vidFile = q.media.videos[0];
    const posterFile = (q.media.posters && q.media.posters[0]) || (q.media.images && q.media.images[0]) || '';
    const remainingPlays = Math.max(0, 5 - vState.plays);

    mediaAndAnswerHtml = `
      <div class="tuv-video-gate">
        <div class="tuv-video-topbar">
          <span>🎬 <b>Resmi TÜV Video Kuralı:</b> Videoyu en fazla 5 kez izleyebilirsin. Şıkları açtığında video kapanır.</span>
          <span class="tuv-play-counter">Kalan İzleme Hakkı: ${remainingPlays} / 5</span>
        </div>

        <video id="tuv-exam-video-el" preload="metadata" playsinline muted ${posterFile ? `poster="media/${esc(posterFile)}"` : ''}
          style="width:100%;max-width:680px;max-height:360px;border-radius:10px;background: var(--media-bg);">
          <source src="media/${esc(vidFile)}" type="video/mp4" onerror="videoAcilmadi(this)" />
        </video>

        <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;">
          <button class="btn btn-primary" ${remainingPlays <= 0 ? 'disabled' : ''} onclick="playExamVideo('${esc(q.code)}')">
            ▶️ Videoyu Başlat (${vState.plays}/5 İzlendi)
          </button>
          <button class="btn btn-gold" ${vState.plays < 1 ? 'disabled title="Önce videoyu en az 1 kez başlatmalısın"' : ''}
            onclick="unlockExamVideoOptions('${esc(q.code)}')">
            📝 Soruya ve Şıklara Geç (Videoyu Kapat) →
          </button>
        </div>
      </div>
    `;
  } else {
    let answerHtml = '';
    if (q.type === 'number') {
      const inputs = (Array.isArray(q.number_inputs) && q.number_inputs.length) ? q.number_inputs : [{}];
      const vals = Array.isArray(savedAns.numberVals) ? savedAns.numberVals : Array(inputs.length).fill('');

      const linesHtml = inputs.map((inp, idx) => {
        const before = inp.label_before || inp.label || '';
        const after = inp.label_after || inp.unit || '';
        const v = vals[idx] ?? '';
        const isFocused = examActiveNumIdx === idx;
        return `
          <div class="number-input-line">
            ${before ? `<span style="font-size:13px;color:var(--muted);">${esc(before)}</span>` : ''}
            <input id="exam-num-input-${idx}" type="text" inputmode="decimal"
              class="num-field" style="${isFocused && inputs.length > 1 ? 'border-color:var(--primary);' : ''}"
              value="${esc(v)}" placeholder="?"
              onfocus="examActiveNumIdx = ${idx}"
              oninput="examActiveNumIdx = ${idx}; setExamNumberAnswer('${esc(q.code)}', ${idx}, this.value)" />
            ${after ? `<span style="font-size:13px;color:var(--muted);">${esc(after)}</span>` : ''}
          </div>
        `;
      }).join('');

      answerHtml = `
        <div class="number-answer-box">
          ${linesHtml}
          <div class="numpad-grid">
            ${['1','2','3','4','5','6','7','8','9','0',',','⌫'].map(k =>
              `<button class="numpad-key" onclick="pressExamNumpad('${esc(q.code)}', '${k}')">${k}</button>`
            ).join('')}
          </div>
        </div>
      `;
    } else {
      const answers = examOptionOrder.get(q.code) || q.answers_tr || [];
      answerHtml = cokDogruNotuHtml(q) + '<div class="options-list">';
      answers.forEach((a, displayIdx) => {
        const key = String(a.num != null ? a.num : displayIdx + 1);
        const displayLabel = String.fromCharCode(65 + displayIdx);
        const isSel = savedAns.selected && savedAns.selected.has(key);
        answerHtml += `
          <div class="option-row ${isSel ? 'selected' : ''}" onclick="toggleExamChoice('${esc(q.code)}', '${key}')">
            <div class="option-check">${isSel ? '✓' : displayLabel}</div>
            <div class="option-content">
              ${sikResmiHtml(a)}${a.text ? `<div class="option-tr">${esc(a.text)}</div>` : ''}${sadeSikHtml(a)}
            </div>
          </div>
        `;
      });
      answerHtml += '</div>';
    }

    const endImg = (q.media?.images && q.media.images[0]) || (q.media?.posters && q.media.posters[0]) || '';
    const mediaPart = hasVideo
      ? `<div class="q-media-box">
           ${endImg ? `<img src="media/${esc(endImg)}" alt="Video Son Kare" onclick="openLightbox('media/${esc(endImg)}')" />` : ''}
           <div style="width:100%;padding:8px 12px;border-radius:8px;background:color-mix(in srgb, var(--primary) 10%, transparent);border:1px solid var(--border);font-size:12px;color:var(--accent-ink);text-align:center;">
             🎬 Video izlendi (${vState.plays}/5) ve son kare (_ende) sabitlendi.
           </div>
         </div>`
      : buildMediaHtml(q);

    mediaAndAnswerHtml = `
      <div class="q-title-tr">${esc(q.question_tr)}</div>
      ${sadeSoruHtml(q)}
      ${showDE && q.question_de ? `<div class="q-title-de">🇩🇪 ${esc(q.question_de)}</div>` : ''}
      ${q.pretext_tr ? `<div class="q-pretext">${esc(q.pretext_tr)}</div>` : ''}
      ${mediaPart}
      ${answerHtml}
      ${showDE ? buildGermanReferenceHtml(q, false) : ''}
    `;
  }

  const body = document.getElementById('exam-question-body');
  body.innerHTML = `
    <div class="q-toolbar">
      <div class="q-meta-tags">
        <span class="q-tag">Soru ${examIdx + 1}</span>
        <span class="q-tag">${esc(q.code)}</span>
        <span class="q-tag cat">${esc(q.category)}</span>
        <span class="q-tag ${q.points === 5 ? 'pts-5' : ''}">${q.points} Puan</span>
      </div>
      <div class="q-tool-btns">
        <button class="tool-btn ${showDE ? 'active-de' : ''}" onclick="examLocalShowDE = !examLocalShowDE; renderExamQuestion();">
          🇩🇪 ${showDE ? 'Almancayı Gizle' : 'Almancasını Göster'}
        </button>
        <button class="tool-btn ${isFlagged ? 'active-star' : ''}" onclick="toggleExamFlag('${esc(q.code)}')">
          ${isFlagged ? '🚩 İşaretlendi' : '🏳️ Sonra Bak'}
        </button>
      </div>
    </div>
    ${mediaAndAnswerHtml}
  `;

  renderExamPills();
}

function toggleExamChoice(code, key) {
  const cur = examAnswers.get(code) || { selected: new Set(), numberVals: [''] };
  if (cur.selected.has(key)) cur.selected.delete(key);
  else cur.selected.add(key);
  examAnswers.set(code, cur);
  renderExamQuestion();
}

function setExamNumberAnswer(code, boxIdx, val) {
  const q = examQuestions[examIdx];
  const reqCount = (q && Array.isArray(q.number_inputs) && q.number_inputs.length) ? q.number_inputs.length : 1;
  const cur = examAnswers.get(code) || { selected: new Set(), numberVals: Array(reqCount).fill('') };
  if (!Array.isArray(cur.numberVals)) cur.numberVals = Array(reqCount).fill('');
  cur.numberVals[boxIdx] = val;
  examAnswers.set(code, cur);
  renderExamPills();
  sinavKaydet();
}

function pressExamNumpad(code, key) {
  const q = examQuestions[examIdx];
  const reqCount = (q && Array.isArray(q.number_inputs) && q.number_inputs.length) ? q.number_inputs.length : 1;
  const cur = examAnswers.get(code) || { selected: new Set(), numberVals: Array(reqCount).fill('') };
  if (!Array.isArray(cur.numberVals)) cur.numberVals = Array(reqCount).fill('');
  const boxIdx = Math.min(examActiveNumIdx || 0, reqCount - 1);
  let v = String(cur.numberVals[boxIdx] || '');
  if (key === '⌫') v = v.slice(0, -1);
  else if (key === ',') {
    if (!v.includes(',')) v += ',';
  } else {
    v += key;
  }
  cur.numberVals[boxIdx] = v;
  examAnswers.set(code, cur);
  renderExamQuestion();
}

function toggleExamFlag(code) {
  if (examFlags.has(code)) examFlags.delete(code);
  else examFlags.add(code);
  renderExamQuestion();
}

function stepExamQuestion(dir) {
  const next = examIdx + dir;
  if (next >= 0 && next < examQuestions.length) {
    examIdx = next;
    examActiveNumIdx = 0;
    renderExamQuestion();
  }
}

function renderExamPills() {
  sinavIlerlemeGuncelle();
  const grid = document.getElementById('exam-pills-grid');
  if (!grid) return;
  grid.innerHTML = '';
  examQuestions.forEach((q, i) => {
    const btn = document.createElement('button');
    btn.className = 'tuv-q-pill';
    if (i === examIdx) btn.classList.add('current');
    else if (examFlags.has(q.code)) btn.classList.add('flagged');
    else if (isExamQuestionAnswered(q)) btn.classList.add('answered');
    btn.textContent = i + 1;
    btn.onclick = () => {
      examIdx = i;
      examActiveNumIdx = 0;
      renderExamQuestion();
    };
    grid.appendChild(btn);
  });
}

function confirmFinishExam() {
  const unanswered = examQuestions.length - examQuestions.filter(isExamQuestionAnswered).length;
  const msg = unanswered > 0
    ? `Henüz cevaplanmamış ${unanswered} soru var (Boş sorular yanlış sayılır). Sınavı bitirmek istediğine emin misin?`
    : 'Sınavı bitirip sonucunu görmek istiyor musun?';
  if (confirm(msg)) {
    finalizeExam();
  }
}

function finalizeExam() {
  if (examTimerInterval) clearInterval(examTimerInterval);

  let correctCount = 0;
  let wrongCount = 0;
  let wrongPoints = 0;
  let earnedPoints = 0;
  let totalPointsPossible = 0;
  let fivePtWrong = 0;
  const wrongDetails = [];

  examQuestions.forEach((q, idx) => {
    const ans = examAnswers.get(q.code) || { selected: new Set(), numberVals: [''] };
    const ok = q.type === 'number'
      ? evaluateNumberQuestion(q, ans.numberVals)
      : evaluateChoiceQuestion(q, ans.selected);

    // Boş bırakılan soru sınav puanında yanlış sayılır ama çalışma istatistiğini bozmaz
    // (hiç görülmemiş soru "Hatalarım"a düşmesin, 3/3 bilinen soru sıfırlanmasın).
    if (isExamQuestionAnswered(q)) { recordQuestionAttempt(q.code, ok); gunlukSay(); }
    totalPointsPossible += q.points;

    if (ok) {
      correctCount++;
      earnedPoints += q.points;
    } else {
      wrongCount++;
      wrongPoints += q.points;
      if (q.points === 5) fivePtWrong++;
      wrongDetails.push({ idx: idx + 1, q });
    }
  });

  const isIHK = !!(EXAM_CONFIG[activeExamClass] && EXAM_CONFIG[activeExamClass].isIHK)
    || (isMistakesExamActive && examQuestions.length > 0 && examQuestions.filter(isKod95Question).length * 2 > examQuestions.length);
  const ihkPassThreshold = Math.ceil(totalPointsPossible * 0.5);
  const passed = isIHK
    ? (earnedPoints >= ihkPassThreshold)
    : (wrongPoints <= 10 && fivePtWrong < 2);

  state.examHistory.unshift({
    date: new Date().toLocaleString('tr-TR'),
    mode: EXAM_CONFIG[activeExamClass]?.title || 'Deneme Sınavı',
    passed,
    wrongPoints,
    earnedPoints,
    totalPointsPossible,
    isIHK,
    fivePtWrong,
    correctCount,
    total: examQuestions.length
  });
  if (state.examHistory.length > 30) state.examHistory.pop();
  saveProgress();
  sinavKaydiSil();

  renderExamResult({
    passed,
    isIHK,
    earnedPoints,
    totalPointsPossible,
    ihkPassThreshold,
    correctCount,
    wrongCount,
    wrongPoints,
    fivePtWrong,
    wrongDetails
  });
}

function renderExamResult(res) {
  document.documentElement.classList.remove('sinav-acik');
  document.getElementById('exam-active-view').style.display = 'none';
  const resView = document.getElementById('exam-result-view');
  resView.style.display = 'block';

  let failReason = res.isIHK
    ? `Tebrikler! Resmi IHK BKrFQG kurallarına göre %50 barajını (${res.ihkPassThreshold} puan) aşarak ${res.earnedPoints} puanla Kod 95 sınavını geçtin!`
    : 'Tebrikler! Resmi TÜV / DEKRA kurallarına göre sınavı başarıyla geçtin.';
  if (!res.passed) {
    if (res.isIHK) {
      failReason = `⚠️ IHK Kod 95 sınavını geçmek için en az %50 (${res.ihkPassThreshold} puan) gerekiyor. Senin puanın: ${res.earnedPoints} / ${res.totalPointsPossible}.`;
    } else if (res.fivePtWrong >= 2 && res.wrongPoints <= 10) {
      failReason = '⚠️ DİKKAT: Toplam hata puanın 10\'u geçmese bile 5 puanlık 2 soruyu yanlış yaptığın için resmi kural gereği kaldın!';
    } else if (res.fivePtWrong >= 2) {
      failReason = `⚠️ Hem 10 hata puanı sınırını aştın (${res.wrongPoints} puan) hem de 5 puanlık ${res.fivePtWrong} soruyu yanlış yaptın.`;
    } else {
      failReason = `⚠️ Toplam hata puanın (${res.wrongPoints} puan), maksimum sınır olan 10 hata puanını aştı.`;
    }
  }

  // Fixed Bug #2: Never show Combo stage button if this was a Mistakes Exam!
  const isCombo = selectedExamMode === 'COMBO' && !isMistakesExamActive;
  const hasNextComboStage = isCombo && res.passed && comboCurrentStageIdx < comboStages.length - 1;
  const nextStageKey = hasNextComboStage ? comboStages[comboCurrentStageIdx + 1] : null;

  resView.innerHTML = `
    <div class="result-banner ${res.passed ? 'pass' : 'fail'}">
      <div>
        <div style="font-size:13px;font-weight:800;opacity:0.85;">${esc(EXAM_CONFIG[activeExamClass]?.title || '')} SONUCU</div>
        <h2 style="font-size:28px;font-weight:900;margin:4px 0;">
          ${res.passed ? '✅ SINAVI GEÇTİN (BESTANDEN)!' : '❌ SINAVDAN KALDIN (NICHT BESTANDEN)'}
        </h2>
        <p style="font-size:14px;">${esc(failReason)}</p>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        ${hasNextComboStage ? `
          <button class="btn btn-gold" onclick="comboCurrentStageIdx++; launchExamStage('${nextStageKey}', true, examSmartWeightedActive);">
            🚛 Sıradaki Oturuma Geç: Klasse ${nextStageKey} →
          </button>
        ` : ''}
        <button class="btn btn-primary" onclick="restartCurrentExamType()">🔄 Yeni Sınav Başlat</button>
        <button class="btn btn-outline" onclick="returnToExamSetup()">⚙️ Sınıf Değiştir</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="lbl">TOPLAM SORU</div>
        <div class="val">${examQuestions.length}</div>
      </div>
      <div class="stat-card">
        <div class="lbl">DOĞRU SAYISI</div>
        <div class="val" style="color:var(--green);">${res.correctCount}</div>
      </div>
      <div class="stat-card">
        <div class="lbl">${res.isIHK ? 'ALINAN PUAN (IHK)' : 'TOPLAM HATA PUANI'}</div>
        <div class="val" style="color:${res.passed ? 'var(--green)' : 'var(--red)'};">
          ${res.isIHK ? `${res.earnedPoints} / ${res.totalPointsPossible}` : `${res.wrongPoints} / 10`}
        </div>
        <div class="sub">${res.isIHK ? `Geçme Barajı: ${res.ihkPassThreshold} Puan (%50)` : 'En fazla 10 puan olabilir'}</div>
      </div>
      <div class="stat-card">
        <div class="lbl">${res.isIHK ? 'BAŞARI YÜZDESİ' : '5 PUANLIK YANLIŞ'}</div>
        <div class="val" style="color:${res.passed ? 'var(--gold)' : 'var(--red)'};">
          ${res.isIHK ? `${Math.round((res.earnedPoints / Math.max(1, res.totalPointsPossible)) * 100)}%` : `${res.fivePtWrong} / 1`}
        </div>
        <div class="sub">${res.isIHK ? 'En az %50 gerekli' : '2 adet 5 puanlık yanlış = Kalır'}</div>
      </div>
    </div>

    ${konuDokumuHtml(res)}
    <div class="card">
      <h3 style="font-size:18px;font-weight:800;margin-bottom:12px;">
        ${res.wrongDetails.length ? `❌ Yanlış Yaptığın Sorular (${res.wrongDetails.length} Adet — Türkçe Açıklamalı)` : '🎉 Hiç yanlışın yok, kusursuz performans!'}
      </h3>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${res.wrongDetails.map(({ idx, q }) => {
          const corrList = (q.answers_tr || []).map((a, i) => a.is_correct ? (a.text || `${String.fromCharCode(65 + i)} şıkkındaki levha`) : null).filter(Boolean).join(' | ') || q.correct_answer_text;
          return `
            <div style="background:var(--panel);border:1px solid var(--border-light);border-radius:11px;padding:14px;">
              <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;">
                <span><b>Soru #${idx}</b> • Kod: ${esc(q.code)} (${esc(q.category)})</span>
                <span style="color:var(--red-ink);font-weight:800;">${q.points} Puan</span>
              </div>
              <div style="font-weight:700;font-size:15px;margin-bottom:6px;">${esc(q.question_tr)}</div>
              ${q.question_de ? `<div style="font-size:13px;color:var(--gold-ink);margin-bottom:6px;">🇩🇪 ${esc(q.question_de)}</div>` : ''}
              <div style="font-size:13px;color:var(--green-ink);margin-bottom:6px;"><b>✓ Doğru Cevap:</b> ${esc(corrList)}</div>
              ${q.explanation_tr ? `<div style="font-size:12.5px;color:var(--text-2);border-top:1px solid var(--border);padding-top:6px;">${esc(q.explanation_tr)}</div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ── Sınav sonrası konu dökümü (v33) ─────────────────────────────────────
// Her soru resmi katalogdaki alt bölümüne (chapter_de) göre gruplanır; Kod 95'te bölüm (KB1–3).
const KONU_TR = {
  'grundformen des verkehrsverhaltens': 'Trafikte temel davranış',
  'verhalten gegenueber fussgaengern': 'Yayalara karşı davranış',
  'fahrbahn und witterungsverhaeltnisse': 'Yol ve hava koşulları',
  'dunkelheit und schlechte sicht': 'Karanlık ve kötü görüş',
  'geschwindigkeit': 'Hız',
  'ueberholen': 'Sollama',
  'besondere verkehrssituationen': 'Özel trafik durumları',
  'alkohol drogen medikamente': 'Alkol, uyuşturucu ve ilaç',
  'gesundheitsrisiken': 'Sağlık riskleri',
  'grundregeln ueber das verhalten im strassenverkehr': 'Trafikte temel kurallar',
  'strassenbenutzung': 'Yolun kullanımı',
  'abstand': 'Takip mesafesi',
  'vorbeifahren': 'Engelin yanından geçme',
  'benutzung von fahrstreifen durch kraftfahrzeuge': 'Şerit kullanımı',
  'abbiegen wenden und rueckwaertsfahren': 'Dönüş, geri dönüş ve geri geri gitme',
  'einfahren und anfahren': 'Yola girme ve kalkış',
  'besondere verkehrslagen': 'Özel trafik hâlleri',
  'halten und parken': 'Durma ve park etme',
  'warnzeichen': 'Uyarı işaretleri (korna, selektör)',
  'beleuchtung': 'Aydınlatma',
  'bahnuebergaenge': 'Hemzemin geçitler',
  'oeffentliche verkehrsmittel und schulbusse': 'Toplu taşıma ve okul servisleri',
  'ladung': 'Yük',
  'sonstige pflichten des fahrzeugfuehrers': 'Sürücünün diğer yükümlülükleri',
  'verhalten an fussgaengerueberwegen und gegenueber fussgaengern': 'Yaya geçitleri ve yayalar',
  'unfall': 'Kaza',
  'zeichen und weisungen der polizeibeamten': 'Polisin işaret ve talimatları',
  'wechsellichtzeichen und dauerlichtzeichen': 'Trafik ışıkları',
  'blaues blinklicht und gelbes blinklicht': 'Mavi ve sarı döner lamba',
  'vorfahrt vorrang': 'Geçiş önceliği',
  'gefahrzeichen': 'Tehlike levhaları',
  'vorschriftzeichen': 'Kural levhaları (yasak / mecburiyet)',
  'richtzeichen': 'Bilgi levhaları',
  'verkehrseinrichtungen': 'Trafik düzenekleri',
  'umweltschutz': 'Çevre koruma',
  'eignung und befaehigung von kraftfahrern': 'Sürücü yeterliliği',
  'autobahn': 'Otoyol',
  'ermuedung ablenkung': 'Yorgunluk ve dikkat dağınıklığı',
  'affektiv emotionales verhalten im strassenverkehr': 'Trafikte duygusal davranış',
  'einrichtungen zur ueberwachung der parkzeit': 'Park süresi denetimi (park saati, disk)',
  'sorgfaltspflichten': 'Özen yükümlülükleri',
  'liegenbleiben und abschleppen von fahrzeugen': 'Arıza ve araç çekme',
  'autobahnen und kraftfahrstrassen': 'Otoyollar ve motorlu taşıt yolları',
  'personenbefoerderung': 'Yolcu taşıma',
  'uebermaessige strassenbenutzung': 'Özel izinli yol kullanımı',
  'sonntagsfahrverbot': 'Pazar günü sürüş yasağı',
  'verkehrshindernisse': 'Trafik engelleri',
  'fahrzeuge mit vorfahrt': 'Geçiş üstünlüğü olan araçlar',
  'untersuchung der fahrzeuge': 'Araç muayenesi',
  'zulassung zum strassenverkehr fahrzeugpapiere fahrerlaubnis': 'Tescil, araç belgeleri ve ehliyet',
  'anhaengerbetrieb': 'Römorklu sürüş',
  'lenk und ruhezeiten': 'Sürüş ve dinlenme süreleri',
  'eg kontrollgeraet': 'Takograf',
  'abmessungen gewichte und geschwindigkeitsbegrenzer': 'Ölçüler, ağırlıklar ve hız sınırlayıcı',
  'lesen einer strassenkarte und streckenplanung': 'Harita okuma ve rota planlama',
  'fahrbetrieb fahrphysik fahrtechnik': 'Sürüş tekniği ve fizik',
  'maengelerkennung lokalisierung von stoerungen': 'Arıza tespiti',
  'verbrennungsmaschine fluessigkeiten kraftstoffsystem elektrische anlage zuendung kraftuebertragung': 'Motor, sıvılar, yakıt ve elektrik sistemi',
  'schmier und frostschutzmittel': 'Yağlar ve antifriz',
  'verwendung und wartung von reifen': 'Lastik kullanımı ve bakımı',
  'bremsanlagen und geschwindigkeitsregler': 'Fren sistemleri ve hız sabitleyici',
  'anhaengekupplungssysteme': 'Römork bağlantı sistemleri',
  'wartung von kraftfahrzeugen und rechtzeitige veranlassung von reparaturen': 'Araç bakımı ve zamanında onarım',
  'entgegennahme transport und ablieferung der gueter': 'Yükün teslim alınması, taşınması ve teslimi'
};
function konuNormal(metin) {
  return String(metin || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function konuAnahtari(q) {
  if (isKod95Question(q)) return 'ihk:' + (q.theme_tr || 'Kod 95');
  const n = konuNormal(q.chapter_de);
  return n ? 'k:' + n : 't:' + (q.theme_tr || 'Diğer');
}
function konuAdi(anahtar, q) {
  if (anahtar.startsWith('k:')) return KONU_TR[anahtar.slice(2)] || (q && q.chapter_de) || anahtar.slice(2);
  return anahtar.slice(anahtar.indexOf(':') + 1);
}
let sonSinavKonular = [];   // son sınavın konu dökümü (düğmeler dizinle çağırır)
let sonSinavYanlislar = []; // son sınavın yanlış soru kodları
let sonSinavSiniflar = [];  // son sınavdaki soruların sınıfları
function konuDokumuHesapla(yanlisKodlar) {
  const yanlis = new Set(yanlisKodlar);
  const gruplar = new Map();
  examQuestions.forEach(q => {
    const k = konuAnahtari(q);
    const g = gruplar.get(k) || { anahtar: k, ad: konuAdi(k, q), toplam: 0, yanlis: 0, kayipPuan: 0, toplamPuan: 0 };
    g.toplam++; g.toplamPuan += q.points;
    if (yanlis.has(q.code)) { g.yanlis++; g.kayipPuan += q.points; }
    gruplar.set(k, g);
  });
  return [...gruplar.values()].sort((a, b) => b.kayipPuan - a.kayipPuan || b.yanlis - a.yanlis || b.toplam - a.toplam);
}
function konuSatiriHtml(g, i) {
  const dogru = g.toplam - g.yanlis;
  const oran = Math.round(dogru / g.toplam * 100);
  return `<div class="konu-satir ${g.yanlis ? 'zayif' : ''}">
      <div class="konu-bilgi"><strong>${esc(g.ad)}</strong>
        <span>${dogru} / ${g.toplam} doğru${g.kayipPuan ? ` · −${g.kayipPuan} puan` : ''}</span></div>
      <div class="konu-cubuk" role="img" aria-label="Yüzde ${oran} doğru"><i style="width:${oran}%"></i></div>
      <button class="btn btn-outline konu-calis" type="button" onclick="konuCalis(${i})">Konuyu çalış</button>
    </div>`;
}
function konuDokumuHtml(res) {
  sonSinavYanlislar = res.wrongDetails.map(w => w.q.code);
  sonSinavSiniflar = [...new Set(examQuestions.flatMap(q => q.classes || []))];
  sonSinavKonular = konuDokumuHesapla(sonSinavYanlislar);
  const zayif = sonSinavKonular.filter(g => g.yanlis > 0);
  const iyi = sonSinavKonular.filter(g => g.yanlis === 0);
  return `<div class="card konu-dokum">
      <h3>📊 Konu bazında sonuç</h3>
      <p class="konu-aciklama">${zayif.length
        ? `En çok puan kaybettiğin konu en üstte. "Konuyu çalış" o konunun bütün sorularını açar.`
        : 'Bu sınavda hiçbir konuda yanlışın yok.'}</p>
      ${zayif.length ? `<div class="konu-baslik">⚠️ Zayıf konuların (${zayif.length})</div>${zayif.map(g => konuSatiriHtml(g, sonSinavKonular.indexOf(g))).join('')}` : ''}
      ${iyi.length ? `<details class="konu-iyi"><summary>✅ Hatasız konular (${iyi.length})</summary>${iyi.map(g => konuSatiriHtml(g, sonSinavKonular.indexOf(g))).join('')}</details>` : ''}
      ${sonSinavYanlislar.length ? `<button class="btn btn-primary konu-yanlis-dugme" type="button" onclick="sinavYanlislariniCalis()">❌ Bu sınavın ${sonSinavYanlislar.length} yanlışını çalış</button>` : ''}
    </div>`;
}
// Çalış ekranında geçici özel liste (son sınavın yanlışları ya da bir konu)
let ozelListe = null; // { ad, kodlar: Set }
function ozelListeAc(ad, kodlar) {
  ozelListe = { ad, kodlar: new Set(kodlar) };
  const sec = document.getElementById('study-status-filter');
  if (sec) {
    let opt = sec.querySelector('option[value="ozel"]');
    if (!opt) { opt = document.createElement('option'); opt.value = 'ozel'; sec.appendChild(opt); }
    opt.textContent = `📌 ${ad} (${kodlar.length})`;
  }
  aramaVeTuruSifirla();
  document.getElementById('study-class-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = 'ALL';
  document.getElementById('study-status-filter').value = 'ozel';
  applyStudyFilters();
  selectStudyQuestion(0);
  switchView('study');
}
function sinavYanlislariniCalis() {
  if (!sonSinavYanlislar.length) return;
  ozelListeAc('Son sınavın yanlışları', sonSinavYanlislar);
}
function konuCalis(i) {
  const g = sonSinavKonular[i];
  if (!g) return;
  const siniflar = new Set(sonSinavSiniflar);
  const kodlar = DB.filter(q => !isEskiKod95(q) && konuAnahtari(q) === g.anahtar && (q.classes || []).some(c => siniflar.has(c))).map(q => q.code);
  ozelListeAc(g.ad, kodlar);
}

// ── Yarım kalan sınav: kaydet / geri yükle ───────────────────────────────
// Sınav yalnız bellekte durursa sayfa yenilenince, güncelleme gelince ya da yanlışlıkla
// başka sınav başlatılınca kaybolur. Her değişiklikte localStorage'a yazılır.
const SINAV_KAYIT_KEY = 'FAHRSCHULE_SINAV_V1';
function sinavSuruyor() {
  return examQuestions.length > 0 && document.getElementById('exam-active-view')?.style.display === 'block';
}
function sinavKaydet() {
  if (!sinavSuruyor()) return;
  const cevaplar = {};
  examAnswers.forEach((a, kod) => { cevaplar[kod] = { s: [...(a.selected || [])], n: a.numberVals || [] }; });
  const sira = {};
  examOptionOrder.forEach((dizi, kod) => { sira[kod] = dizi.map(a => a.num); });
  const video = {};
  examVideoState.forEach((v, kod) => { video[kod] = v; });
  try {
    localStorage.setItem(SINAV_KAYIT_KEY, JSON.stringify({
      v: 1, ts: Date.now(), sinif: activeExamClass, mod: selectedExamMode, hatalar: isMistakesExamActive,
      akilli: examSmartWeightedActive, kombo: comboCurrentStageIdx,
      baslik: document.getElementById('exam-stage-title')?.textContent || '',
      hatalarBaslik: EXAM_CONFIG.MISTAKES.title,
      kodlar: examQuestions.map(q => q.code), idx: examIdx, cevaplar, bayrak: [...examFlags], video, sira,
      kalan: examSecondsLeft
    }));
  } catch (_) {}
}
function sinavKaydiOku() {
  try {
    const k = JSON.parse(localStorage.getItem(SINAV_KAYIT_KEY) || 'null');
    if (!k || k.v !== 1 || !Array.isArray(k.kodlar) || !k.kodlar.length || !(k.kalan > 0)) return null;
    if (Date.now() - (k.ts || 0) > 7 * 24 * 3600 * 1000) return null; // bir haftadan eski yarım sınav unutulur
    return k;
  } catch (_) { return null; }
}
function sinavKaydiSil() {
  try { localStorage.removeItem(SINAV_KAYIT_KEY); } catch (_) {}
  document.documentElement.classList.remove('sinav-acik');
}
// Yeni sınav başlatmadan önce yarım kalan sınavı sessizce silme
function yeniSinavOnayi() {
  const bellekte = sinavSuruyor();
  if (!bellekte && !sinavKaydiOku()) return true;
  const ok = confirm('Yarım kalan bir sınavın var. Onu silip yeni sınav başlatılsın mı?\n\n"İptal" dersen yarım kalan sınava dönersin.');
  if (ok) {
    if (examTimerInterval) clearInterval(examTimerInterval);
    examQuestions = [];
    sinavKaydiSil();
  } else if (!bellekte) {
    sinavDevamEt();
  }
  return ok;
}
function sinavDevamEt() {
  if (sinavSuruyor()) { switchView('exam'); return; }
  const k = sinavKaydiOku();
  if (!k) return;
  const sorular = k.kodlar.map(kod => DB.find(q => q.code === kod)).filter(Boolean);
  if (!sorular.length) { sinavKaydiSil(); return; }
  activeExamClass = k.sinif; selectedExamMode = k.mod || selectedExamMode;
  isMistakesExamActive = !!k.hatalar; examSmartWeightedActive = !!k.akilli; comboCurrentStageIdx = k.kombo | 0;
  if (k.hatalar && k.hatalarBaslik) EXAM_CONFIG.MISTAKES.title = k.hatalarBaslik;
  examQuestions = sorular;
  examIdx = Math.min(Math.max(k.idx | 0, 0), sorular.length - 1);
  examActiveNumIdx = 0;
  examAnswers.clear(); examFlags.clear(); examVideoState.clear(); examOptionOrder.clear();
  sorular.forEach(q => {
    const c = k.cevaplar && k.cevaplar[q.code];
    if (c) examAnswers.set(q.code, { selected: new Set(c.s || []), numberVals: Array.isArray(c.n) ? c.n : [''] });
    if (k.video && k.video[q.code]) examVideoState.set(q.code, k.video[q.code]);
    if (Array.isArray(q.answers_tr) && q.answers_tr.length) {
      const nums = k.sira && k.sira[q.code];
      const dizi = Array.isArray(nums) ? nums.map(n => q.answers_tr.find(a => a.num === n)).filter(Boolean) : [];
      examOptionOrder.set(q.code, dizi.length === q.answers_tr.length ? dizi : sikSirasi(q));
    }
  });
  (k.bayrak || []).forEach(kod => examFlags.add(kod));
  examLocalShowDE = false;
  switchView('exam');
  document.getElementById('exam-setup-view').style.display = 'none';
  document.getElementById('exam-result-view').style.display = 'none';
  document.getElementById('exam-active-view').style.display = 'block';
  document.getElementById('exam-stage-title').textContent = k.baslik || `${EXAM_CONFIG[k.sinif]?.title || 'Sınav'} — ${sorular.length} Soru`;
  startExamTimer(k.kalan);
  renderExamQuestion();
}
function sinavKaydiniSilSor() {
  if (!confirm('Yarım kalan sınav silinsin mi? Bu sınavın cevapları kaybolur.')) return;
  sinavKaydiSil();
  sinavDevamKutusu();
  try { renderDashUst(); } catch (_) {}
}
function sinavOzetMetni(k) {
  const cevaplanan = Object.values(k.cevaplar || {}).filter(c => (c.s && c.s.length) || (c.n || []).some(x => String(x || '').trim())).length;
  const dk = Math.floor(k.kalan / 60), sn = k.kalan % 60;
  return `${esc((k.baslik || 'Sınav').replace(/\s+—.*$/, ''))} · ${cevaplanan} / ${k.kodlar.length} cevaplandı · ${dk}:${String(sn).padStart(2, '0')} kaldı`;
}
// Sınav kurulum ekranında "yarım kalan sınav" kutusu
function sinavDevamKutusu() {
  const kurulum = document.getElementById('exam-setup-view');
  if (!kurulum) return;
  let kutu = document.getElementById('sinav-devam-kutu');
  const k = sinavSuruyor() ? null : sinavKaydiOku();
  if (!k) { if (kutu) kutu.remove(); return; }
  if (!kutu) {
    kutu = document.createElement('div');
    kutu.id = 'sinav-devam-kutu';
    kutu.className = 'sinav-devam-kutu';
    kurulum.prepend(kutu);
  }
  kutu.innerHTML = `<strong>⏸️ Yarım kalan sınavın var</strong><span>${sinavOzetMetni(k)}</span>
    <div class="sinav-devam-dugmeler"><button class="btn btn-primary" type="button" onclick="sinavDevamEt()">Kaldığın yerden devam et</button>
    <button class="btn btn-outline" type="button" onclick="sinavKaydiniSilSor()">Sil</button></div>`;
}
window.addEventListener('pagehide', () => { try { sinavKaydet(); } catch (_) {} });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { try { sinavKaydet(); } catch (_) {} } });

function returnToExamSetup() {
  document.getElementById('exam-result-view').style.display = 'none';
  document.getElementById('exam-active-view').style.display = 'none';
  document.getElementById('exam-setup-view').style.display = 'block';
  sinavDevamKutusu();
}

// ── Cheatsheet Interactive Formula Calculator ────────────────────────────
function updateFormulaCalc() {
  const inp = document.getElementById('calc-speed-inp');
  const out = document.getElementById('calc-speed-results');
  if (!inp || !out) return;
  const v = Math.max(0, Number(inp.value) || 0);
  const reaktion = (v / 10) * 3;
  const brems = (v / 10) * (v / 10);
  const gefahr = brems / 2;
  const anhalte = reaktion + brems;

  out.innerHTML = `
    <span>🏃 Reaksiyon: <b style="color:var(--accent-ink);">${reaktion.toFixed(1).replace('.0','')} m</b></span>
    <span>🛑 Normal Fren: <b style="color:var(--gold-ink);">${brems.toFixed(1).replace('.0','')} m</b></span>
    <span>⚠️ Tehlike Freni: <b style="color:var(--red-ink);">${gefahr.toFixed(1).replace('.0','')} m</b></span>
    <span>🏁 Toplam Duruş: <b style="color:var(--green-ink);">${anhalte.toFixed(1).replace('.0','')} m</b></span>
  `;
}

function renderSignFlashcards() {
  const grid = document.getElementById('sign-flashcards-grid');
  if (!grid) return;
  const cards = Array.isArray(window.SIGN_FLASHCARDS) ? window.SIGN_FLASHCARDS : [];
  const q = (document.getElementById('sign-search-inp')?.value || '').trim().toLowerCase();

  const filtered = q
    ? cards.filter(c => `${c.code} ${c.q_tr} ${c.q_de} ${c.a_tr} ${c.a_de}`.toLowerCase().includes(q))
    : cards;

  grid.innerHTML = filtered.slice(0, 60).map((c) => `
    <div class="formula-card" style="cursor:pointer;" onclick="this.querySelector('.fc-ans').style.display = this.querySelector('.fc-ans').style.display === 'none' ? 'block' : 'none'">
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--muted);">
        <span><b>${esc(c.code)}</b> • ${esc(c.category)}</span>
        <span class="mini-pill">${c.points} Puan</span>
      </div>
      <div style="background: var(--media-bg);border-radius:8px;padding:8px;text-align:center;">
        <img src="media/${esc(c.img)}" alt="${esc(c.code)}" loading="lazy" style="max-height:130px;max-width:100%;object-fit:contain;" />
      </div>
      <div style="font-size:13.5px;font-weight:700;color: var(--text);">${esc(c.q_tr)}</div>
      <div style="font-size:11.5px;color:var(--gold-ink);">🇩🇪 ${esc(c.q_de)}</div>
      <div class="fc-ans" style="display:none;margin-top:6px;padding-top:8px;border-top:1px dashed var(--border-light);font-size:12.5px;">
        <div style="color:var(--green-ink);font-weight:700;">✓ TR: ${esc(c.a_tr)}</div>
        ${c.a_de ? `<div style="color:var(--muted);margin-top:3px;">✓ DE: ${esc(c.a_de)}</div>` : ''}
        <button class="btn btn-outline" style="margin-top:8px;padding:5px 10px;font-size:11px;width:100%;" onclick="event.stopPropagation(); jumpToQuestionByCode('${esc(c.code)}')">
          📚 Soruya Git →
        </button>
      </div>
      <div style="font-size:11px;color:var(--accent-ink);text-align:center;margin-top:auto;">👆 Cevabı Görmek İçin Dokun</div>
    </div>
  `).join('');
}

function jumpToQuestionByCode(code) {
  resetStudyFilters();
  const idx = studyFiltered.findIndex(q => q.code === code);
  switchView('study');
  if (idx >= 0) selectStudyQuestion(idx);
}

// ── Statistics & Leitner Box Breakdown View ──────────────────────────────
function renderStatsView() {
  const categories = ['Grundstoff', 'Klasse B', 'Klasse C', 'Klasse CE', 'Kod 95'];
  const container = document.getElementById('stats-breakdown-container');

  let html = '<div class="class-cards-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));">';
  categories.forEach(cat => {
    const pool = DB.filter(q => q.classes.includes(cat) && !isEskiKod95(q));
    const learned = pool.filter(q => getLeitnerBox(q.code) === 'learned').length;
    const learning = pool.filter(q => getLeitnerBox(q.code) === 'learning').length;
    const wrong = pool.filter(q => getLeitnerBox(q.code) === 'wrong').length;
    const pct = pool.length ? Math.round(((learned + learning * 0.5) / pool.length) * 100) : 0;

    html += `
      <div class="class-card">
        <div class="class-card-head">
          <strong>${esc(cat)}</strong>
          <span class="class-rule-pill">${pct}% Hazır</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <div style="font-size:12px;color:var(--muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;">
          <span>Toplam: <b>${pool.length}</b></span>
          <span style="color:var(--green);">🟩 3/3: <b>${learned}</b></span>
          <span style="color:var(--gold);">🟨 1-2/3: <b>${learning}</b></span>
          <span style="color:var(--red);">🟥 Hata: <b>${wrong}</b></span>
        </div>
      </div>
    `;
  });
  html += '</div>';
  container.innerHTML = html;

  const histEl = document.getElementById('exam-history-list');
  if (!state.examHistory.length) {
    histEl.innerHTML = '<p style="color:var(--muted);font-size:13px;">Henüz tamamlanmış deneme sınavın bulunmuyor.</p>';
    return;
  }

  histEl.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${state.examHistory.map(h => `
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <strong style="color:${h.passed ? 'var(--green)' : 'var(--red)'};">
              ${h.passed ? '✅ GEÇTİ' : '❌ KALDI'}
            </strong>
            <span style="margin-left:8px;font-weight:700;">${esc(h.mode)}</span>
            <span style="font-size:12px;color:var(--muted);margin-left:8px;">${esc(h.date)}</span>
          </div>
          <div style="font-size:13px;">
            Doğru: <b>${h.correctCount}/${h.total}</b> •
            ${h.isIHK ? `Puan: <b>${h.earnedPoints}/${h.totalPointsPossible}</b>` : `Hata Puanı: <b>${h.wrongPoints}</b> • 5P Yanlış: <b>${h.fivePtWrong}</b>`}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function exportProgressData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ehliyet_2026_ilerleme_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function triggerImportProgress() {
  document.getElementById('import-file-input')?.click();
}

function importProgressData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid root schema');
      }
      sanitizeLoadedState(parsed);
      saveProgress();
      refreshDashboard();
      renderStatsView();
      alert('İlerleme yedeğin başarıyla doğrulandı ve yüklendi!');
    } catch (err) {
      alert('Geçersiz veya bozuk yedek dosyası.');
    }
  };
  reader.readAsText(file);
}

function resetAllProgress() {
  if (!confirm('Tüm çözdüğün soru kayıtları, favorilerin ve sınav geçmişin sıfırlanacak. Emin misin?')) return;
  state.qStats = {};
  state.starred = {};
  state.examHistory = [];
  saveProgress();
  refreshDashboard();
  renderStatsView();
}

// ── Utilities & Lightbox (Fixed Bug #7: Ignore Enter on BUTTON/A) ────────
function openLightbox(src) {
  const modal = document.getElementById('lightbox-modal');
  const img = document.getElementById('lightbox-img');
  if (!modal || !img) return;
  img.src = src;
  yakinlikSifirla();
  const zatenAcik = lightboxAcikMi();
  modal.classList.add('open');
  if (!zatenAcik) gecmiseYaz({ view: aktifGorunum, tab: aktifSekme, katman: 'resim' });
}

// ── Büyük görselde yakınlaştırma (iki parmak, çift dokunma, fare tekerleği, sürükleme) ──
const yakinlik = { s: 1, x: 0, y: 0, parmaklar: new Map(), bas: null, sonDokunma: 0, hareket: null };
function yakinlikUygula() {
  const img = document.getElementById('lightbox-img');
  if (!img) return;
  img.style.transform = `translate(${yakinlik.x}px, ${yakinlik.y}px) scale(${yakinlik.s})`;
  img.style.cursor = yakinlik.s > 1 ? 'grab' : 'zoom-in';
}
function yakinlikSifirla() { yakinlik.s = 1; yakinlik.x = 0; yakinlik.y = 0; yakinlik.parmaklar.clear(); yakinlik.bas = null; yakinlikUygula(); }
// Ekrandaki p noktası sabit kalacak şekilde ölçeği yeni değere getir (p: sahne merkezine göre)
function yakinlikOlcekle(yeniS, px, py) {
  yeniS = Math.min(6, Math.max(1, yeniS));
  const f = yeniS / yakinlik.s;
  yakinlik.x = px - (px - yakinlik.x) * f;
  yakinlik.y = py - (py - yakinlik.y) * f;
  yakinlik.s = yeniS;
  if (yakinlik.s === 1) { yakinlik.x = 0; yakinlik.y = 0; }
  yakinlikUygula();
}
function sahneNoktasi(e) {
  const r = document.getElementById('lightbox-sahne').getBoundingClientRect();
  return { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
}
function yakinlikKur() {
  const img = document.getElementById('lightbox-img');
  if (!img || img.dataset.yakinlik) return;
  img.dataset.yakinlik = '1';
  img.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { img.setPointerCapture(e.pointerId); } catch (_) {}
    yakinlik.parmaklar.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...yakinlik.parmaklar.values()];
    if (p.length === 1) yakinlik.hareket = { x: e.clientX, y: e.clientY, coklu: false };
    if (p.length === 2) {
      if (yakinlik.hareket) yakinlik.hareket.coklu = true;
      yakinlik.bas = { mesafe: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), s: yakinlik.s };
    }
  });
  img.addEventListener('pointermove', e => {
    if (!yakinlik.parmaklar.has(e.pointerId)) return;
    const onceki = yakinlik.parmaklar.get(e.pointerId);
    yakinlik.parmaklar.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...yakinlik.parmaklar.values()];
    if (p.length === 2 && yakinlik.bas) {
      const m = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      const orta = sahneNoktasi({ clientX: (p[0].x + p[1].x) / 2, clientY: (p[0].y + p[1].y) / 2 });
      yakinlikOlcekle(yakinlik.bas.s * m / yakinlik.bas.mesafe, orta.x, orta.y);
    } else if (p.length === 1 && yakinlik.s > 1) {
      yakinlik.x += e.clientX - onceki.x;
      yakinlik.y += e.clientY - onceki.y;
      yakinlikUygula();
    }
  });
  const birak = e => {
    const tekti = yakinlik.parmaklar.size === 1;
    yakinlik.parmaklar.delete(e.pointerId);
    if (yakinlik.parmaklar.size < 2) yakinlik.bas = null;
    const h = yakinlik.hareket;
    const dokunma = h && !h.coklu && Math.hypot(e.clientX - h.x, e.clientY - h.y) < 12;
    if (e.type === 'pointerup' && tekti && !dokunma) yakinlik.sonDokunma = 0;
    if (e.type === 'pointerup' && tekti && dokunma) {
      const simdi = Date.now();
      if (simdi - yakinlik.sonDokunma < 300) {
        const n = sahneNoktasi(e);
        yakinlikOlcekle(yakinlik.s > 1 ? 1 : 2.5, n.x, n.y);
        yakinlik.sonDokunma = 0;
      } else yakinlik.sonDokunma = simdi;
    }
  };
  img.addEventListener('pointerup', birak);
  img.addEventListener('pointercancel', birak);
  img.addEventListener('wheel', e => {
    e.preventDefault();
    const n = sahneNoktasi(e);
    yakinlikOlcekle(yakinlik.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), n.x, n.y);
  }, { passive: false });
}
onAppReady(yakinlikKur);

function lightboxAcikMi() {
  return !!document.getElementById('lightbox-modal')?.classList.contains('open');
}

// gecmistenGeldi=true: geri tuşuyla kapanıyor (geçmişe dokunma)
function closeLightbox(gecmistenGeldi = false) {
  const modal = document.getElementById('lightbox-modal');
  const acikti = lightboxAcikMi();
  if (modal) modal.classList.remove('open');
  if (acikti && !gecmistenGeldi && history.state && history.state.katman === 'resim') {
    history.back();
  }
}

function handleKeyboardShortcuts(e) {
  if (e.key === 'Escape') {
    closeLightbox();
    closeStudyDrawer();
    return;
  }
  const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  // Enter on a focused button/link already triggers its own click; don't double-fire.
  // Arrow keys must keep working even when a button (e.g. a nav tab) has focus.
  if (e.key === 'Enter' && (tag === 'BUTTON' || tag === 'A')) return;

  if (document.getElementById('view-study').classList.contains('active')) {
    if (e.key === 'ArrowRight') { if (studyIndex < studyFiltered.length - 1) selectStudyQuestion(studyIndex + 1); }
    else if (e.key === 'ArrowLeft') { if (studyIndex > 0) selectStudyQuestion(studyIndex - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (!studyRevealed) checkStudyAnswer();
      else if (studyIndex < studyFiltered.length - 1) selectStudyQuestion(studyIndex + 1);
    }
  }
}

function sampleRandom(arr, count) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ═══════════════════════════════════════════════════════════════════════════
   CİHAZLAR ARASI SENKRON (senkron kodu)
   - Bir cihaz 12 haneli kod üretir; diğer cihazlara aynı kod girilir.
   - Koddan HKDF ile iki şey türetilir: sunucudaki kayıt adı (kimlik) ve AES-256-GCM
     anahtarı. Sunucu yalnız şifreli veri görür; kodu bilmeyen ilerlemeyi okuyamaz.
   - Her değişiklik birkaç saniye sonra gönderilir; uygulama açılınca / öne gelince çekilir.
   - Çakışmada (iki cihaz çevrimdışı çalıştıysa) soru bazında en yeni kayıt kazanır.
═══════════════════════════════════════════════════════════════════════════ */
const SENKRON_URL = (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) && (() => { try { return localStorage.getItem('SENKRON_TEST_URL'); } catch (_) { return null; } })())
  || 'https://34-134-47-203.sslip.io/ehliyet-senkron/v1/k/';
const SENKRON_KEY = 'FAHRSCHULE_SENKRON_V1';
const SENKRON_ALFABE = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 karakter: 0/1/I/O yok (karışmasın)
const SENKRON_KOD_UZUNLUK = 12; // 60 bit

let senkron = senkronOku();       // { kod, surum, kirli, son, hata }
let senkronAnahtarBellek = null;  // { kod, id, anahtar }
let senkronZamanlayici = null;
let senkronCalisiyor = false;
let senkronTekrar = false;
let senkronUyguluyor = false;     // uzaktan gelen veri yazılırken "kirli" işaretleme
let senkronDegisiklik = 0;        // gönderim sırasında yeni değişiklik oldu mu?
let senkronSonCekim = 0;
let senkronZorla = '';           // '' | 'acilis' (yalnız birleştir) | 'elle' (birleştir + gönder)
let senkronUzakSayi = null;       // son çekilen kayıttaki çözülmüş soru sayısı (tanı için)

function senkronOku() {
  try {
    const s = JSON.parse(localStorage.getItem(SENKRON_KEY) || 'null');
    if (s && typeof s.kod === 'string') return { kod: s.kod, surum: s.surum | 0, kirli: !!s.kirli, son: s.son || 0, hata: '' };
  } catch (_) {}
  return { kod: '', surum: 0, kirli: false, son: 0, hata: '' };
}
function senkronYaz() {
  try {
    if (senkron.kod) localStorage.setItem(SENKRON_KEY, JSON.stringify({ kod: senkron.kod, surum: senkron.surum, kirli: senkron.kirli, son: senkron.son }));
    else localStorage.removeItem(SENKRON_KEY);
  } catch (_) {}
}

function senkronKodBicim(kod) { return kod.replace(/(.{4})(?=.)/g, '$1-'); }
function senkronKodTemizle(girdi) { return String(girdi || '').toUpperCase().replace(/[\s-]/g, ''); }
function senkronKodGecerli(kod) {
  return kod.length === SENKRON_KOD_UZUNLUK && [...kod].every(c => SENKRON_ALFABE.includes(c));
}
function senkronKodUret() {
  const r = crypto.getRandomValues(new Uint8Array(SENKRON_KOD_UZUNLUK));
  return [...r].map(b => SENKRON_ALFABE[b & 31]).join('');
}

// ── Kripto ──────────────────────────────────────────────────────────────
async function senkronAnahtarAl() {
  if (senkronAnahtarBellek && senkronAnahtarBellek.kod === senkron.kod) return senkronAnahtarBellek;
  const te = new TextEncoder();
  const temel = await crypto.subtle.importKey('raw', te.encode(senkron.kod), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const tuz = te.encode('ehliyet-senkron-v1');
  const idBit = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: tuz, info: te.encode('kimlik') }, temel, 256);
  const anahtar = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: tuz, info: te.encode('anahtar') },
    temel, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const id = [...new Uint8Array(idBit)].map(b => b.toString(16).padStart(2, '0')).join('');
  senkronAnahtarBellek = { kod: senkron.kod, id, anahtar };
  return senkronAnahtarBellek;
}
function senkronB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function senkronB64Coz(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
async function senkronAkis(u8, akis) {
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(akis)).arrayBuffer());
}
// Biçim: base64( [12 bayt IV][şifreli: 1 bayt bayrak (1=gzip, 0=düz) + JSON] )
async function senkronSifrele(anahtar, nesne) {
  let govde = new TextEncoder().encode(JSON.stringify(nesne));
  let bayrak = 0;
  if (typeof CompressionStream === 'function') {
    try { govde = await senkronAkis(govde, new CompressionStream('gzip')); bayrak = 1; } catch (_) {}
  }
  const duz = new Uint8Array(govde.length + 1);
  duz[0] = bayrak; duz.set(govde, 1);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, anahtar, duz));
  const cikti = new Uint8Array(12 + ct.length);
  cikti.set(iv); cikti.set(ct, 12);
  return senkronB64(cikti);
}
async function senkronCoz(anahtar, b64) {
  if (!b64) return null;
  const u8 = senkronB64Coz(b64);
  const duz = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.slice(0, 12) }, anahtar, u8.slice(12)));
  let govde = duz.subarray(1);
  if (duz[0] === 1) {
    if (typeof DecompressionStream !== 'function') throw new Error('Bu tarayıcı sıkıştırılmış veriyi açamıyor; tarayıcını güncelle.');
    govde = await senkronAkis(govde, new DecompressionStream('gzip'));
  }
  return JSON.parse(new TextDecoder().decode(govde));
}

// ── Veri paketi, uygulama ve birleştirme ────────────────────────────────
function senkronPaketi() {
  return {
    v: 1,
    durum: {
      qStats: state.qStats, starred: state.starred, examHistory: state.examHistory,
      alwaysShowDE: state.alwaysShowDE, gunluk: state.gunluk || {}, gunlukCihaz: state.gunlukCihaz || {}, gunlukHedef: state.gunlukHedef
    },
    sonKonum: sonKonumOku(),
    filtreKonum: filtreKonumOku()
  };
}
function senkronFiltreKonumAl(uzak) {
  const u = uzak && uzak.filtreKonum;
  if (!u || typeof u !== 'object') return;
  const m = filtreKonumOku();
  for (const [k, v] of Object.entries(u)) {
    if (v && typeof v.code === 'string' && (!m[k] || (v.ts || 0) > (m[k].ts || 0))) m[k] = { code: v.code, ts: v.ts || 0 };
  }
  filtreKonumYaz(m);
}
function senkronSonKonumAl(uzak) {
  senkronFiltreKonumAl(uzak);
  const k = uzak && uzak.sonKonum;
  if (!k || typeof k !== 'object' || typeof k.code !== 'string') return;
  const yerel = sonKonumOku();
  if (!yerel || (k.ts || 0) > (yerel.ts || 0)) {
    try { localStorage.setItem(SON_KONUM_KEY, JSON.stringify(k)); } catch (_) {}
  }
}
// Yerelde gönderilmemiş değişiklik yoksa: uzaktaki hali olduğu gibi al (silmeler de gelsin).
function senkronUygula(uzak) {
  if (!uzak || !uzak.durum) return;
  state.qStats = {}; state.starred = {}; state.examHistory = []; state.gunluk = {}; state.gunlukCihaz = {};
  sanitizeLoadedState(uzak.durum);
  senkronSonKonumAl(uzak);
}
function senkronSinavZamani(h) {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(h && h.date || '');
  return m ? new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime() : 0;
}
// İki cihaz da çevrimdışı değişiklik yaptıysa: soru bazında en son görülen kazanır.
function senkronBirlestir(uzak) {
  if (!uzak || !uzak.durum) return;
  const u = uzak.durum;
  if (u.qStats && typeof u.qStats === 'object') {
    for (const [kod, us] of Object.entries(u.qStats)) {
      const ys = state.qStats[kod];
      if (!us || typeof us !== 'object') continue;
      if (!ys || (us.lastSeen || 0) > (ys.lastSeen || 0)) state.qStats[kod] = us;
    }
  }
  if (u.starred && typeof u.starred === 'object') {
    for (const [kod, v] of Object.entries(u.starred)) if (v) state.starred[kod] = true;
  }
  if (Array.isArray(u.examHistory)) {
    const anahtar = h => [h.date, h.mode, h.correctCount, h.total].join('|');
    const var_ = new Set(state.examHistory.map(anahtar));
    const tum = state.examHistory.concat(u.examHistory.filter(h => h && !var_.has(anahtar(h))));
    tum.sort((a, b) => senkronSinavZamani(b) - senkronSinavZamani(a));
    state.examHistory = tum.slice(0, 30);
    sanitizeLoadedState({ examHistory: state.examHistory }); // uzaktan gelen kayıtları da temizle
  }
  if (u.gunlukCihaz && typeof u.gunlukCihaz === 'object' && !Array.isArray(u.gunlukCihaz)) {
    if (!state.gunlukCihaz || typeof state.gunlukCihaz !== 'object') state.gunlukCihaz = {};
    for (const [id, g] of Object.entries(u.gunlukCihaz)) {
      if (!/^[a-z0-9]{6,32}$/.test(id) || !g || typeof g !== 'object') continue;
      const yerel = state.gunlukCihaz[id] || (state.gunlukCihaz[id] = {});
      for (const [gun, n] of Object.entries(gunlukTemizle(g))) if (n > (yerel[gun] || 0)) yerel[gun] = n;
    }
  }
  if (u.gunluk && typeof u.gunluk === 'object') {
    if (!state.gunluk || typeof state.gunluk !== 'object') state.gunluk = {};
    for (const [gun, n] of Object.entries(gunlukTemizle(u.gunluk))) {
      if (typeof n === 'number' && n > (state.gunluk[gun] || 0)) state.gunluk[gun] = n;
    }
  }
  senkronSonKonumAl(uzak);
}
function senkronYenidenCiz() {
  try { refreshDashboard(); } catch (_) {}
  try { updateGlobalDEButton(); } catch (_) {}
  try { updateDynamicCounts(); } catch (_) {}
  try { if (document.getElementById('view-stats')?.classList.contains('active')) renderStatsView(); } catch (_) {}
  try {
    // Çalış ekranı açık değilse, başka cihazdan gelen "kaldığın yer"i hemen uygula;
    // açıksa kullanıcının o anki sorusunu bozma, yalnız listeyi tazele.
    if (document.getElementById('view-study')?.classList.contains('active')) renderStudySidebarList();
    else applyStudyFilters();
  } catch (_) {}
}
function senkronDurumuKaydet() {
  senkronUyguluyor = true;
  try { saveProgress(); } finally { senkronUyguluyor = false; }
}

// saveProgress her çağrıldığında
function senkronKirlet() {
  if (!senkron.kod || senkronUyguluyor) return;
  senkronDegisiklik++;
  if (!senkron.kirli) { senkron.kirli = true; senkronYaz(); }
  clearTimeout(senkronZamanlayici);
  senkronZamanlayici = setTimeout(senkronCalistir, 2500);
  senkronArayuz();
}

// ── Ana döngü: çek → (birleştir) → gönder ───────────────────────────────
async function senkronCalistir() {
  if (!senkron.kod) return;
  if (senkronCalisiyor) { senkronTekrar = true; return; }
  senkronCalisiyor = true;
  clearTimeout(senkronZamanlayici);
  senkronArayuz('calisiyor');
  try {
    const { id, anahtar } = await senkronAnahtarAl();
    const r = await fetch(SENKRON_URL + id, { cache: 'no-store' });
    let uzak = null;
    if (r.status === 200) uzak = await r.json();
    else if (r.status !== 404) throw new Error('Sunucu yanıtı ' + r.status);
    senkronSonCekim = Date.now();
    if (!uzak && senkron.surum > 0) { senkron.surum = 0; senkron.kirli = true; } // sunucudaki kayıt kaybolduysa yeniden yükle

    // Zorla: sürüm numarası aynı görünse bile sunucudaki veriyi bu cihazdakiyle BİRLEŞTİR.
    // (Sürüm sayacı bir şekilde ilerlemiş ama veri bu cihaza işlenmemişse kendiliğinden düzelsin.)
    let zorla = senkronZorla; senkronZorla = '';
    for (let deneme = 0; deneme < 5; deneme++) {
      if (uzak && (zorla || uzak.surum !== senkron.surum)) {
        const veri = await senkronCoz(anahtar, uzak.veri);
        if (veri) {
          senkronUzakSayi = veri.durum && veri.durum.qStats ? Object.keys(veri.durum.qStats).length : 0;
          if (senkron.kirli || zorla) senkronBirlestir(veri); else senkronUygula(veri);
          if (zorla === 'elle') { senkron.kirli = true; senkronDegisiklik++; } // birleşik hali geri gönder
          senkronDurumuKaydet();
          senkronYenidenCiz();
        }
        zorla = '';
        senkron.surum = uzak.surum;
        senkronYaz();
      }
      if (!senkron.kirli) break;
      const anlik = senkronDegisiklik;
      const veri = await senkronSifrele(anahtar, senkronPaketi());
      const p = await fetch(SENKRON_URL + id, {
        method: 'PUT', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onceki: senkron.surum, veri })
      });
      if (p.status === 200) {
        senkron.surum = (await p.json()).surum;
        senkron.kirli = senkronDegisiklik !== anlik; // gönderim sırasında yeni değişiklik olduysa yine gönder
        senkronYaz();
        if (senkron.kirli) senkronTekrar = true;
        break;
      }
      if (p.status === 409) { uzak = await p.json(); continue; }
      throw new Error('Sunucu yanıtı ' + p.status);
    }
    senkron.son = Date.now();
    senkron.hata = '';
    senkronYaz();
  } catch (e) {
    senkron.hata = (e && e.name === 'OperationError')
      ? 'Kod bu kayıtla eşleşmedi.'
      : (navigator.onLine === false ? 'Çevrimdışı — internet gelince eşitlenecek.' : 'Eşitlenemedi, birazdan yeniden denenecek.');
    if (senkron.kirli) { clearTimeout(senkronZamanlayici); senkronZamanlayici = setTimeout(senkronCalistir, 30000); }
  } finally {
    senkronCalisiyor = false;
    senkronArayuz();
    if (senkronTekrar) { senkronTekrar = false; senkronCalistir(); }
  }
}

// ── Kullanıcı eylemleri ─────────────────────────────────────────────────
function senkronBaslat() {
  if (!(window.crypto && crypto.subtle)) { alert('Bu tarayıcı senkronu desteklemiyor.'); return; }
  senkron = { kod: senkronKodUret(), surum: 0, kirli: true, son: 0, hata: '' };
  senkronAnahtarBellek = null;
  senkronYaz();
  senkronArayuz();
  senkronCalistir();
}
async function senkronKodlaBaglan() {
  const kutu = document.getElementById('senkron-kod-girdi');
  const kod = senkronKodTemizle(kutu && kutu.value);
  if (!senkronKodGecerli(kod)) { senkronArayuz('', 'Kod 12 karakter olmalı (ör. ABCD-EFGH-2345).'); return; }
  const yereldeVar = Object.keys(state.qStats).length > 0 || Object.keys(state.starred).length > 0 || state.examHistory.length > 0;
  senkron = { kod, surum: 0, kirli: false, son: 0, hata: '' };
  senkronAnahtarBellek = null;
  senkronArayuz('calisiyor');
  try {
    const { id, anahtar } = await senkronAnahtarAl();
    const r = await fetch(SENKRON_URL + id, { cache: 'no-store' });
    if (r.status === 404) { senkron = senkronOku(); senkronArayuz('', 'Bu kodla kayıt bulunamadı. Kodu diğer cihazdaki gibi yazdığından emin ol.'); return; }
    if (r.status !== 200) throw new Error('Sunucu yanıtı ' + r.status);
    const uzak = await r.json();
    await senkronCoz(anahtar, uzak.veri); // kod doğru mu? (yanlışsa burada hata verir)
  } catch (e) {
    senkron = senkronOku();
    senkronArayuz('', navigator.onLine === false ? 'İnternet bağlantısı yok.' : 'Bağlanılamadı. Kodu kontrol edip tekrar dene.');
    return;
  }
  // Bu cihazda da ilerleme varsa ikisi birleştirilir; yoksa diğer cihazdaki ilerleme aynen gelir.
  senkron.kirli = yereldeVar;
  senkronYaz();
  await senkronCalistir();
}
function senkronElle() {
  if (!senkron.kod) return;
  senkronZorla = 'elle';
  senkronSonCekim = 0;
  senkronCalistir();
}
function senkronKapat() {
  if (!confirm('Bu cihazda senkron kapatılsın mı? Bu cihazdaki ilerleme kalır ama artık diğer cihazlarla eşitlenmez.')) return;
  senkron = { kod: '', surum: 0, kirli: false, son: 0, hata: '' };
  senkronAnahtarBellek = null;
  senkronYaz();
  senkronArayuz();
}
function senkronKodKopyala() {
  const metin = senkronKodBicim(senkron.kod);
  const bitti = () => senkronArayuz('', 'Kod kopyalandı.');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(metin).then(bitti, () => prompt('Kodu kopyala:', metin));
  else prompt('Kodu kopyala:', metin);
}
function senkronYeriGoster() {
  switchView('stats');
  setTimeout(() => document.getElementById('senkron-kart')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

// ── Arayüz ──────────────────────────────────────────────────────────────
function senkronSaat(ts) {
  return ts ? new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '';
}
function senkronArayuz(durum = '', mesaj = '') {
  const cip = document.getElementById('dash-senkron-cip');
  if (cip) cip.textContent = senkron.kod ? (senkron.hata ? '⚠️ Senkron bekliyor' : '☁️ Senkron açık') : '📱 Cihazları bağla';

  const kap = document.getElementById('senkron-icerik');
  if (!kap) return;
  if (!senkron.kod) {
    if (durum === 'calisiyor') { kap.innerHTML = '<p class="senkron-durum">⏳ Bağlanıyor...</p>'; return; }
    const eskiGirdi = document.getElementById('senkron-kod-girdi')?.value || '';
    kap.innerHTML = `
      <p class="senkron-aciklama">PC, telefon ve tablette aynı ilerlemeyi görmek için cihazları tek bir kodla bağla. Hesap ya da e-posta gerekmez.</p>
      <div class="senkron-secenek">
        <strong>İlk cihaz mı?</strong>
        <button class="btn btn-primary" type="button" onclick="senkronBaslat()">Senkron kodu oluştur</button>
      </div>
      <div class="senkron-secenek">
        <strong>Başka cihazda kodun var mı?</strong>
        <div class="senkron-giris">
          <input id="senkron-kod-girdi" class="senkron-girdi" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
            placeholder="ABCD-EFGH-2345" maxlength="14" value="${esc(eskiGirdi)}" onkeydown="if(event.key==='Enter')senkronKodlaBaglan()" />
          <button class="btn btn-outline" type="button" onclick="senkronKodlaBaglan()">Bağlan</button>
        </div>
      </div>
      ${mesaj ? `<p class="senkron-mesaj" role="status">${esc(mesaj)}</p>` : ''}`;
    return;
  }
  let satir;
  if (durum === 'calisiyor' || senkronCalisiyor) satir = '⏳ Eşitleniyor...';
  else if (senkron.hata) satir = '⚠️ ' + senkron.hata;
  else if (senkron.kirli) satir = '⏳ Değişiklikler gönderilecek...';
  else if (senkron.son) satir = '✅ Eşit — son eşitleme ' + senkronSaat(senkron.son);
  else satir = '⏳ Eşitleniyor...';
  kap.innerHTML = `
    <p class="senkron-aciklama">Bu kodu diğer cihazında <b>İstatistik → Cihazlar arası senkron</b> bölümüne yaz. Kodu kimseyle paylaşma: kodu bilen ilerlemeni görebilir.</p>
    <div class="senkron-kod" aria-label="Senkron kodu">${esc(senkronKodBicim(senkron.kod))}</div>
    <p class="senkron-durum" role="status">${esc(satir)}</p>
    <p class="senkron-bilgi">Bu cihazda çözülen: <b>${Object.keys(state.qStats || {}).length}</b> soru${senkronUzakSayi !== null ? ` · sunucudaki kayıtta: <b>${senkronUzakSayi}</b>` : ''} · kayıt sürümü ${senkron.surum}</p>
    <div class="senkron-dugmeler">
      <button class="btn btn-outline" type="button" onclick="senkronKodKopyala()">Kodu kopyala</button>
      <button class="btn btn-outline" type="button" onclick="senkronElle()">Şimdi eşitle</button>
      <button class="btn btn-outline" type="button" onclick="senkronKapat()">Bu cihazda kapat</button>
    </div>
    ${mesaj ? `<p class="senkron-mesaj" role="status">${esc(mesaj)}</p>` : ''}`;
}

// ── Başlangıç ───────────────────────────────────────────────────────────
onAppReady(() => {
  senkronArayuz();
  if (senkron.kod) { senkronZorla = 'acilis'; senkronCalistir(); }
  document.addEventListener('visibilitychange', () => {
    if (!senkron.kod) return;
    if (document.visibilityState === 'visible') {
      if (Date.now() - senkronSonCekim > 15000 || senkron.kirli) senkronCalistir();
    } else if (senkron.kirli) {
      senkronCalistir(); // sekme kapanmadan önce bekleyen değişiklikleri gönder
    }
  });
  window.addEventListener('online', () => { if (senkron.kod) senkronCalistir(); });
  window.addEventListener('focus', () => {
    if (senkron.kod && Date.now() - senkronSonCekim > 15000) senkronCalistir();
  });
});
