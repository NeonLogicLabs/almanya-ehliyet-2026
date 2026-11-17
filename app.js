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
function onAppReady(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
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
      if (hadController && !refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  document.addEventListener('keydown', handleKeyboardShortcuts);
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
    state.examHistory = parsed.examHistory;
  }
  if (typeof parsed.alwaysShowDE === 'boolean') {
    state.alwaysShowDE = parsed.alwaysShowDE;
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

  return `<span class="leitner-dots" title="Leitner 3 Aşamalı Öğrenme Sistemi">${dots} <span>${label}</span></span>`;
}

// ── Navigation & View Switching (Pauses Exam Timer When Leaving Exam) ────
function switchView(viewName, highlightTabName = null) {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();

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
  if (viewName === 'stats') renderStatsView();
  if (viewName === 'cheatsheet') {
    updateFormulaCalc();
    renderSignFlashcards();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

  const text = useDE && q.question_de ? q.question_de : q.question_tr;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = useDE ? 'de-DE' : 'tr-TR';
  utter.rate = 0.96;
  window.speechSynthesis.speak(utter);
}

// ── Dashboard Logic ──────────────────────────────────────────────────────
function refreshDashboard() {
  const total = DB.length;
  let learned = 0;
  let learning = 0;
  let wrong = 0;

  DB.forEach(q => {
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
  document.getElementById('study-status-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = 'ALL';
  applyStudyFilters();
  switchView('study');
}

function openFilteredStudy(statusType) {
  document.getElementById('study-class-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = 'ALL';
  document.getElementById('study-status-filter').value = statusType;
  applyStudyFilters();
  switchView('study', statusType === 'wrong' ? 'mistakes' : 'study');
}

function filterCriticalFivePoints() {
  document.getElementById('study-class-filter').value = 'ALL';
  document.getElementById('study-status-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = '5';
  applyStudyFilters();
  switchView('study');
}

function filterTrapQuestions() {
  document.getElementById('study-class-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = 'ALL';
  document.getElementById('study-status-filter').value = 'trap';
  applyStudyFilters();
  switchView('study');
}

function openMistakesAndFavorites() {
  const wrongCount = DB.filter(q => getLeitnerBox(q.code) === 'wrong').length;
  document.getElementById('study-class-filter').value = 'ALL';
  document.getElementById('study-points-filter').value = 'ALL';
  document.getElementById('study-status-filter').value = wrongCount > 0 ? 'wrong' : 'starred';
  applyStudyFilters();
  // Highlight the 'mistakes' tab in the topbar!
  switchView('study', 'mistakes');
}

// ── Study Mode Logic ─────────────────────────────────────────────────────
function isKod95Question(q) {
  return Array.isArray(q.classes) && q.classes.includes('Kod 95');
}

// Counts shown in labels are computed from the data so they never drift out of sync.
function updateDynamicCounts() {
  const fmt = n => n.toLocaleString('tr-TR');
  const countClass = cls => DB.filter(q => questionBelongsToClass(q, cls)).length;

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
    if (statusVal === 'trap' && !q.is_trap) return false;
    if (statusVal === 'unseen' && box !== 'unseen') return false;
    if (statusVal === 'wrong' && box !== 'wrong') return false;
    if (statusVal === 'learning' && box !== 'learning') return false;
    // Fixed Bug #3: Box 3 ('learned') strictly filters 3/3 mastered questions only!
    if (statusVal === 'learned' && box !== 'learned') return false;
    if (statusVal === 'starred' && !state.starred[q.code]) return false;

    if (searchVal) {
      const hay = `${q.code} ${q.question_tr} ${q.question_de}`.toLowerCase();
      if (!hay.includes(searchVal)) return false;
    }
    return true;
  });

  document.getElementById('study-filter-count').textContent = `${studyFiltered.length} soru`;
  studyIndex = 0;
  renderStudySidebarList();
  selectStudyQuestion(0);
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
  studyLocalShowDE = false;
  studyShuffledOptions = curQ && Array.isArray(curQ.answers_tr)
    ? sampleRandom(curQ.answers_tr, curQ.answers_tr.length)
    : [];

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

    <div class="q-title-tr">${esc(q.question_tr)}</div>
    ${showDE && q.question_de ? `<div class="q-title-de">🇩🇪 ${esc(q.question_de)}</div>` : ''}
    ${q.pretext_tr ? `<div class="q-pretext">${esc(q.pretext_tr)}</div>` : ''}
    ${buildKaynakNotuHtml(q)}

    ${buildMediaHtml(q)}
    ${buildStudyAnswerAreaHtml(q)}

    ${studyRevealed && q.explanation_tr ? `
      <div class="tr-explanation-box">
        <b>🇹🇷 Çözüm & Kural Açıklaması:</b><br/>
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
  if (studyRevealed) {
    const numCount = (Array.isArray(q.number_inputs) && q.number_inputs.length) ? q.number_inputs.length : 1;
    studyRevealed = false;
    studySelectedChoices.clear();
    studyNumberValues = Array(numCount).fill('');
    renderStudyQuestion();
    return;
  }
  studySelectedChoices.clear();
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
  document.getElementById('study-sidebar-drawer')?.classList.add('drawer-open');
  document.getElementById('drawer-backdrop')?.classList.add('open');
}

function closeStudyDrawer() {
  document.getElementById('study-sidebar-drawer')?.classList.remove('drawer-open');
  document.getElementById('drawer-backdrop')?.classList.remove('open');
}

function toggleStar(code) {
  state.starred[code] = !state.starred[code];
  if (!state.starred[code]) delete state.starred[code];
  saveProgress();
  renderStudyQuestion();
  renderStudySidebarList();
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
        <video controls preload="metadata" ${posterAttr}>
          <source src="media/${esc(v)}" type="video/mp4" />
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
        ? `<div style="margin-top:12px;padding:10px 14px;border-radius:9px;background:var(--green-soft);border:1px solid var(--green);color:#86efac;font-weight:700;">
             ✅ Doğru Cevap! (${esc(q.correct_answer_text)})
           </div>`
        : `<div style="margin-top:12px;padding:10px 14px;border-radius:9px;background:var(--red-soft);border:1px solid var(--red);color:#fca5a5;font-weight:700;">
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
            oninput="studyActiveNumIdx = ${idx}; studyNumberValues[${idx}] = this.value" />
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
  let html = '<div class="options-list">';
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
          <div class="option-tr">${esc(a.text)}</div>
          ${badgeHtml}
        </div>
      </div>
    `;
  });
  html += '</div>';
  return html;
}

// Kod 95: sorunun resmi DIHK havuzuyla karşılaştırma sonucu + "cevap resmi değil" uyarısı.
function buildKaynakNotuHtml(q) {
  if (!q.kaynak) return '';
  const k = q.kaynak;
  const iyi = k.durum === 'birebir';
  const orta = k.durum === 'metin_farkli';
  const ikon = iyi ? '✅' : (orta ? '🟡' : '⚠️');
  const renk = iyi ? 'var(--green)' : (orta ? 'var(--gold)' : 'var(--red)');
  const kaynak = k.pdf_no ? ` <span style="opacity:.8;">(DIHK ${k.baski}, Bölüm ${esc(k.pdf_no.replace('.', ' • Soru '))})</span>` : '';
  const puan = k.resmi_puan ? ` Resmi puan: ${k.resmi_puan}.` : '';
  return `
    <div style="margin:10px 0;padding:9px 12px;border-radius:9px;border:1px solid ${renk};background:rgba(148,163,184,0.06);font-size:12.5px;line-height:1.5;">
      <div style="color:${renk};font-weight:700;">${ikon} ${esc(k.not)}${esc(puan)}${kaynak}</div>
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
              <b>${esc(o.letter)}:</b> ${esc(o.text)}
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

  let isCorrect = false;
  if (q.type === 'number') {
    isCorrect = evaluateNumberQuestion(q, studyNumberValues);
  } else {
    isCorrect = evaluateChoiceQuestion(q, studySelectedChoices);
  }

  studyRevealed = true;
  recordQuestionAttempt(q.code, isCorrect);
  renderStudyQuestion();
  renderStudySidebarList();
}

function recordQuestionAttempt(code, isCorrect) {
  const prev = state.qStats[code] || { status: 'unseen', correctStreak: 0, wrongCount: 0 };
  if (isCorrect) {
    prev.correctStreak = Math.min(3, (prev.correctStreak || 0) + 1);
    prev.status = prev.correctStreak >= 3 ? 'learned' : 'learning';
  } else {
    prev.correctStreak = 0;
    prev.wrongCount = (prev.wrongCount || 0) + 1;
    prev.status = 'wrong';
  }
  prev.lastSeen = Date.now();
  state.qStats[code] = prev;
  saveProgress();
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
  switchView('exam');
  selectExamMode(mode);
  startSelectedExam(false);
}

function startSelectedExam(smartWeighted = false) {
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
    startMistakesExam();
  } else {
    startSelectedExam(examSmartWeightedActive);
  }
}

function sampleSmartWeighted(pool, count) {
  const buckets = { wrong: [], unseen: [], learning: [], learned: [] };
  pool.forEach(q => {
    const b = getLeitnerBox(q.code);
    buckets[b].push(q);
  });
  const ordered = [
    ...sampleRandom(buckets.wrong, buckets.wrong.length),
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
      examOptionOrder.set(q.code, sampleRandom(q.answers_tr, q.answers_tr.length));
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
function startMistakesExam() {
  const wrongPool = DB.filter(q => getLeitnerBox(q.code) === 'wrong');
  const starredPool = DB.filter(q => state.starred[q.code] && getLeitnerBox(q.code) !== 'wrong');
  // Trap filler questions must match the track the user is studying:
  // Kod 95 (IHK) traps only when the Kod 95 exam is selected, otherwise only TÜV (B/C/CE) traps.
  const wantKod95 = selectedExamMode === 'KOD95';
  const trapPool = DB.filter(q =>
    q.is_trap &&
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
      examOptionOrder.set(q.code, sampleRandom(q.answers_tr, q.answers_tr.length));
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
  updateExamTimerDisplay();
  examTimerInterval = setInterval(() => {
    if (examPaused) return;
    examSecondsLeft--;
    updateExamTimerDisplay();
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
  if (el) el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

function unlockExamVideoOptions(code) {
  const vState = examVideoState.get(code) || { plays: 1, unlockedOptions: false };
  vState.unlockedOptions = true;
  examVideoState.set(code, vState);
  renderExamQuestion();
}

function renderExamQuestion() {
  const q = examQuestions[examIdx];
  if (!q) return;

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

        <video id="tuv-exam-video-el" preload="metadata" ${posterFile ? `poster="media/${esc(posterFile)}"` : ''}
          style="width:100%;max-width:680px;max-height:360px;border-radius:10px;background:#000;">
          <source src="media/${esc(vidFile)}" type="video/mp4" />
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
      answerHtml = '<div class="options-list">';
      answers.forEach((a, displayIdx) => {
        const key = String(a.num != null ? a.num : displayIdx + 1);
        const displayLabel = String.fromCharCode(65 + displayIdx);
        const isSel = savedAns.selected && savedAns.selected.has(key);
        answerHtml += `
          <div class="option-row ${isSel ? 'selected' : ''}" onclick="toggleExamChoice('${esc(q.code)}', '${key}')">
            <div class="option-check">${isSel ? '✓' : displayLabel}</div>
            <div class="option-content">
              <div class="option-tr">${esc(a.text)}</div>
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
           <div style="width:100%;padding:8px 12px;border-radius:8px;background:rgba(14,165,233,0.1);border:1px solid var(--border);font-size:12px;color:#bae6fd;text-align:center;">
             🎬 Video izlendi (${vState.plays}/5) ve son kare (_ende) sabitlendi.
           </div>
         </div>`
      : buildMediaHtml(q);

    mediaAndAnswerHtml = `
      <div class="q-title-tr">${esc(q.question_tr)}</div>
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

    recordQuestionAttempt(q.code, ok);
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

  const isIHK = !!(EXAM_CONFIG[activeExamClass] && EXAM_CONFIG[activeExamClass].isIHK);
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

    <div class="card">
      <h3 style="font-size:18px;font-weight:800;margin-bottom:12px;">
        ${res.wrongDetails.length ? `❌ Yanlış Yaptığın Sorular (${res.wrongDetails.length} Adet — Türkçe Açıklamalı)` : '🎉 Hiç yanlışın yok, kusursuz performans!'}
      </h3>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${res.wrongDetails.map(({ idx, q }) => {
          const corrList = (q.answers_tr || []).filter(a => a.is_correct).map(a => a.text).join(' | ') || q.correct_answer_text;
          return `
            <div style="background:var(--panel);border:1px solid var(--border-light);border-radius:11px;padding:14px;">
              <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;">
                <span><b>Soru #${idx}</b> • Kod: ${esc(q.code)} (${esc(q.category)})</span>
                <span style="color:#fca5a5;font-weight:800;">${q.points} Puan</span>
              </div>
              <div style="font-weight:700;font-size:15px;margin-bottom:6px;">${esc(q.question_tr)}</div>
              ${q.question_de ? `<div style="font-size:13px;color:#fde68a;margin-bottom:6px;">🇩🇪 ${esc(q.question_de)}</div>` : ''}
              <div style="font-size:13px;color:#86efac;margin-bottom:6px;"><b>✓ Doğru Cevap:</b> ${esc(corrList)}</div>
              ${q.explanation_tr ? `<div style="font-size:12.5px;color:#cbd5e1;border-top:1px solid var(--border);padding-top:6px;">${esc(q.explanation_tr)}</div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function returnToExamSetup() {
  document.getElementById('exam-result-view').style.display = 'none';
  document.getElementById('exam-active-view').style.display = 'none';
  document.getElementById('exam-setup-view').style.display = 'block';
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
    <span>🏃 Reaksiyon: <b style="color:#38bdf8;">${reaktion.toFixed(1).replace('.0','')} m</b></span>
    <span>🛑 Normal Fren: <b style="color:#fde68a;">${brems.toFixed(1).replace('.0','')} m</b></span>
    <span>⚠️ Tehlike Freni: <b style="color:#fca5a5;">${gefahr.toFixed(1).replace('.0','')} m</b></span>
    <span>🏁 Toplam Duruş: <b style="color:#4ade80;">${anhalte.toFixed(1).replace('.0','')} m</b></span>
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
      <div style="background:#000;border-radius:8px;padding:8px;text-align:center;">
        <img src="media/${esc(c.img)}" alt="${esc(c.code)}" loading="lazy" style="max-height:130px;max-width:100%;object-fit:contain;" />
      </div>
      <div style="font-size:13.5px;font-weight:700;color:#fff;">${esc(c.q_tr)}</div>
      <div style="font-size:11.5px;color:#fde68a;">🇩🇪 ${esc(c.q_de)}</div>
      <div class="fc-ans" style="display:none;margin-top:6px;padding-top:8px;border-top:1px dashed var(--border-light);font-size:12.5px;">
        <div style="color:#4ade80;font-weight:700;">✓ TR: ${esc(c.a_tr)}</div>
        ${c.a_de ? `<div style="color:#94a3b8;margin-top:3px;">✓ DE: ${esc(c.a_de)}</div>` : ''}
        <button class="btn btn-outline" style="margin-top:8px;padding:5px 10px;font-size:11px;width:100%;" onclick="event.stopPropagation(); jumpToQuestionByCode('${esc(c.code)}')">
          📚 Soruya Git →
        </button>
      </div>
      <div style="font-size:11px;color:#38bdf8;text-align:center;margin-top:auto;">👆 Cevabı Görmek İçin Dokun</div>
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
    const pool = DB.filter(q => q.classes.includes(cat));
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
  modal.classList.add('open');
}

function closeLightbox() {
  const modal = document.getElementById('lightbox-modal');
  if (modal) modal.classList.remove('open');
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
    if (e.key === 'ArrowRight') selectStudyQuestion(studyIndex + 1);
    else if (e.key === 'ArrowLeft') selectStudyQuestion(studyIndex - 1);
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
