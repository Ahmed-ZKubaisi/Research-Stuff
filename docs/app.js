const DATA_ROOT = 'questions';
const TOPICS = {
  general: 'General Research',
  biostatistics: 'Biostatistics',
  general_extra: 'Extra general research'
};
const TOPIC_FOLDERS = {
  general: 'general',
  biostatistics: 'biostatistics',
  general_extra: 'general_extra'
};

const FALLBACK_QUESTIONS = {
  general: [
    {
      question: 'Which cell type is primarily responsible for phagocytosis in acute inflammation?',
      correct_answer: 'Neutrophils',
      wrong_answers: ['Lymphocytes', 'Eosinophils', 'Basophils']
    },
    {
      question: 'What is the hallmark feature of coagulative necrosis?',
      correct_answer: 'Preserved tissue architecture with loss of nuclei',
      wrong_answers: ['Liquefied tissue with pus formation', 'Fat saponification', 'Caseous cheese-like debris']
    }
  ],
  biostatistics: [
    {
      question: 'Which receptor is the primary target of beta-blockers?',
      correct_answer: 'Beta-1 adrenergic receptor',
      wrong_answers: ['Alpha-1 adrenergic receptor', 'Muscarinic receptor', 'Dopamine receptor']
    },
    {
      question: 'What is the mechanism of action of ACE inhibitors?',
      correct_answer: 'Block conversion of angiotensin I to angiotensin II',
      wrong_answers: ['Block aldosterone receptors', 'Stimulate renin release', 'Inhibit beta-adrenergic receptors']
    }
  ]
};

const STORAGE_KEY = 'medquiz_excluded';
const LANGUAGE_KEY = 'medquiz_language';

const translations = {
  en: {
    badge: 'Medical review',
    title: 'MedQuiz',
    subtitle: 'Research questions',
    start: 'Start quiz',
    language: 'Language',
    included: 'Select topics',
    options: 'Session options',
    randomize: 'Randomize questions',
    limit: 'Limit',
    hint: 'Mark a question as known and it will be skipped in future sessions.',
    menu: 'Menu',
    question: 'Question',
    of: 'of',
    skip: 'Skip this question next time',
    sessionComplete: 'Session complete!',
    total: 'Total',
    correct: 'Correct',
    wrong: 'Wrong',
    review: 'Review wrong answers now?',
    noBanks: 'Please select at least one topic to start a session.',
    noQuestions: 'No questions were available for the selected topics.',
    noSelection: 'If external bank files are missing, built-in fallback questions are used.',
    next: 'Next question',
    keyboardHint: 'Tip: press 1-9 to answer, Enter to continue'
  }
};

const state = {
  randomize: true,
  limit: 0,
  selectedTopics: Object.keys(TOPICS),
  pool: [],
  idx: 0,
  current: null,
  wrong: [],
  correctCount: 0,
  markExcl: false,
  answered: false,
  excluded: new Set(),
  currentView: 'menu',
  language: 'en'
};

function t(key) {
  return (translations[state.language] && translations[state.language][key]) || translations.en[key] || key;
}

function hashQuestion(q) {
  const seed = `${q.question || q.q || ''}|${q.correct_answer || q.a || ''}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function normalizeQuestion(question) {
  if (!question) return null;
  const q = question.question || question.q;
  const a = question.correct_answer || question.a;
  const wrong = question.wrong_answers || question.wrong || [];
  if (!q || !a) return null;
  return { question: q, correct_answer: a, wrong_answers: Array.isArray(wrong) ? wrong.filter(Boolean) : [] };
}

function loadExcluded() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveExcluded() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.excluded]));
}

function loadLanguage() {
  try {
    const raw = localStorage.getItem(LANGUAGE_KEY);
    return raw === 'ar' ? 'ar' : 'en';
  } catch {
    return 'en';
  }
}

function saveLanguage() {
  localStorage.setItem(LANGUAGE_KEY, state.language);
}

function applyLanguage() {
  document.documentElement.lang = state.language;
  document.title = state.language === 'ar' ? 'اختبار طب' : 'MedQuiz';
}

/**
 * Discover every .json file inside a folder.
 * Tries, in order:
 *   1. A `manifest.json` file inside the folder listing filenames (works on any static host).
 *   2. Parsing a server-generated directory listing page (works with servers that have
 *      autoindex enabled, e.g. `python -m http.server`, Apache/nginx with Indexes on).
 * Returns an array of full file paths.
 */
async function discoverJsonFiles(folder) {
  // 1) Manifest-based discovery (most reliable, works everywhere)
  try {
    const res = await fetch(`${folder}/manifest.json`);
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length) {
        return list
          .filter((name) => typeof name === 'string' && name.toLowerCase().endsWith('.json'))
          .map((name) => `${folder}/${name}`);
      }
    }
  } catch {
    // ignore and fall through to next strategy
  }

  // 2) Directory-listing based discovery (only works if the server exposes one)
  try {
    const res = await fetch(`${folder}/`);
    if (res.ok) {
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const hrefs = [...doc.querySelectorAll('a[href$=".json"]')]
        .map((a) => a.getAttribute('href'))
        .filter(Boolean);
      if (hrefs.length) {
        return hrefs.map((href) => {
          if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')) {
            return href;
          }
          return `${folder}/${decodeURIComponent(href)}`;
        });
      }
    }
  } catch {
    // ignore, no listing available
  }

  return [];
}

async function loadQuestions(topic) {
  const folder = `${DATA_ROOT}/${TOPIC_FOLDERS[topic]}`;
  const files = await discoverJsonFiles(folder);

  if (!files.length) {
    return FALLBACK_QUESTIONS[topic] || [];
  }

  const questionSets = await Promise.all(files.map(async (file) => {
    try {
      const res = await fetch(file);
      if (!res.ok) return [];
      const data = await res.json();
      const bank = Array.isArray(data.questions) ? data.questions : Array.isArray(data) ? data : [];
      return bank.map(normalizeQuestion).filter(Boolean);
    } catch {
      return [];
    }
  }));

  const loaded = questionSets.flat();
  return loaded.length ? loaded : FALLBACK_QUESTIONS[topic] || [];
}

function renderApp() {
  const app = document.getElementById('app');
  applyLanguage();

  if (state.currentView === 'menu') {
    app.innerHTML = `
      <div class="card hero-card">
        <header class="hero-header">
          <div>
            <div class="badge">${t('badge')}</div>
            <h1>${t('title')}</h1>
            <p class="subtitle">${t('subtitle')}</p>
          </div>
          <div class="hero-actions">
            <button class="btn-secondary" id="startBtn">${t('start')}</button>
          </div>
        </header>

        <div class="info-grid">
          <div class="info-card">
            <h3>${t('included')}</h3>
            <div class="chip-row">
              ${Object.entries(TOPICS).map(([key, label]) => `
                <button type="button" class="chip ${state.selectedTopics.includes(key) ? 'active' : ''}" data-topic="${key}">${label}</button>
              `).join('')}
            </div>
            <p class="small">${t('noSelection')}</p>
          </div>

          <div class="info-card">
            <h3>${t('options')}</h3>
            <label class="toggle-item">
              <input type="checkbox" id="randomize" ${state.randomize ? 'checked' : ''} />
              <span>${t('randomize')}</span>
            </label>
            <label class="toggle-item">
              <span>${t('limit')}</span>
              <input type="number" id="limit" min="0" value="${state.limit}" />
            </label>
          </div>
        </div>

        <p class="small">${t('hint')}</p>
        <div class="footer-credit">Web version of your quiz</div>
      </div>
    `;

    document.querySelectorAll('[data-topic]').forEach((button) => {
      button.onclick = () => {
        const topic = button.getAttribute('data-topic');
        if (state.selectedTopics.includes(topic)) {
          state.selectedTopics = state.selectedTopics.filter((item) => item !== topic);
        } else {
          state.selectedTopics = [...state.selectedTopics, topic];
        }
        renderApp();
      };
    });

    document.getElementById('startBtn').onclick = startSession;
    document.getElementById('randomize').onchange = (e) => { state.randomize = e.target.checked; };
    document.getElementById('limit').onchange = (e) => { state.limit = Number(e.target.value || 0); };
    return;
  }

  if (state.currentView === 'quiz') {
    app.innerHTML = `
      <div class="card question-card">
        <header class="quiz-header">
          <div>
            <div class="badge">MCQ</div>
            <h2>${t('question')} ${state.idx}/${state.pool.length}</h2>
          </div>
          <div class="header-right">
            <div class="live-score" id="liveScore">✓ ${state.correctCount} · ✗ ${state.wrong.length}</div>
            <button class="btn-danger" id="menuBtn">${t('menu')}</button>
          </div>
        </header>

        <div class="progress-bar" aria-hidden="true">
          <div class="progress-fill" style="width:${(state.idx / Math.max(state.pool.length, 1)) * 100}%"></div>
        </div>

        <div class="question-text">${state.current.question}</div>
        <div id="options"></div>
        <div id="nextControls" class="next-controls"></div>
        <div class="row" style="margin-top:12px">
          <label class="checkbox-item"><input type="checkbox" id="skipBox" ${state.markExcl ? 'checked' : ''} /> <span>${t('skip')}</span></label>
        </div>
        <p class="small kbd-hint">${t('keyboardHint')}</p>
      </div>
    `;

    document.getElementById('menuBtn').onclick = () => {
      state.currentView = 'menu';
      renderApp();
    };

    const skipBox = document.getElementById('skipBox');
    if (skipBox) {
      skipBox.onchange = (e) => { state.markExcl = e.target.checked; };
    }

    renderMCQ();
  }
}

function renderMCQ() {
  const optionsEl = document.getElementById('options');
  if (!optionsEl) return;
  const correct = state.current.correct_answer;
  const wrong = (state.current.wrong_answers || []).slice(0, 3);
  const options = [correct, ...wrong].sort(() => Math.random() - 0.5);
  optionsEl.innerHTML = options.map((opt) => `
    <button class="option-btn" data-option="${opt}">${opt}</button>
  `).join('');
  optionsEl.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => answerMCQ(btn, btn.getAttribute('data-option'));
  });
}

function updateLiveScore() {
  const el = document.getElementById('liveScore');
  if (el) el.textContent = `✓ ${state.correctCount} · ✗ ${state.wrong.length}`;
}

function answerMCQ(btn, chosen) {
  if (state.answered) return;
  state.answered = true;
  const correct = state.current.correct_answer;
  const buttons = document.querySelectorAll('.option-btn');
  buttons.forEach((b) => {
    const opt = b.getAttribute('data-option');
    if (opt === correct) {
      b.classList.add('correct');
    } else if (opt === chosen) {
      b.classList.add('wrong');
    }
    b.disabled = true;
  });

  if (chosen === correct) {
    state.correctCount += 1;
    updateLiveScore();
    // Correct answers keep the pace up and auto-advance shortly.
    window.setTimeout(nextQuestion, 700);
  } else {
    state.wrong.push(state.current);
    updateLiveScore();
    // Wrong answers wait for a deliberate second input before moving on,
    // so there's time to actually register the correct answer.
    const nextControls = document.getElementById('nextControls');
    if (nextControls) {
      nextControls.innerHTML = `<button class="btn-primary" id="nextBtn">${t('next')} →</button>`;
      const nextBtn = document.getElementById('nextBtn');
      nextBtn.onclick = nextQuestion;
      nextBtn.focus();
    }
  }
}

function nextQuestion() {
  if (state.markExcl && state.current) {
    state.excluded.add(hashQuestion(state.current));
    saveExcluded();
  }
  state.markExcl = false;
  state.answered = false;

  if (state.idx >= state.pool.length) {
    finishSession();
    return;
  }

  state.current = state.pool[state.idx];
  state.idx += 1;
  renderApp();
}

async function startSession() {
  if (!state.selectedTopics.length) {
    alert(t('noBanks'));
    return;
  }

  const pool = [];
  const seen = new Set();
  for (const topic of state.selectedTopics) {
    const questions = await loadQuestions(topic);
    for (const q of questions) {
      const h = hashQuestion(q);
      if (!state.excluded.has(h) && !seen.has(h)) {
        seen.add(h);
        pool.push(q);
      }
    }
  }

  if (!pool.length) {
    alert(t('noQuestions'));
    return;
  }

  if (state.randomize) pool.sort(() => Math.random() - 0.5);
  if (state.limit > 0 && state.limit < pool.length) pool.splice(state.limit);

  state.pool = pool;
  state.idx = 0;
  state.wrong = [];
  state.correctCount = 0;
  state.current = null;
  state.currentView = 'quiz';
  nextQuestion();
}

function finishSession() {
  const total = state.pool.length;
  const wrong = state.wrong.length;
  const right = total - wrong;
  const summary = `${t('sessionComplete')}\n\n${t('total')}: ${total}\n${t('correct')}: ${right}\n${t('wrong')}: ${wrong}`;
  const review = confirm(`${summary}\n\n${t('review')}`);
  if (review && state.wrong.length) {
    state.pool = [...state.wrong, ...state.pool.filter((q) => !state.wrong.includes(q))];
    state.wrong = [];
    state.correctCount = 0;
    state.idx = 0;
    state.currentView = 'quiz';
    nextQuestion();
  } else {
    state.currentView = 'menu';
    renderApp();
  }
}

function handleKeydown(e) {
  if (state.currentView !== 'quiz') return;

  if (!state.answered) {
    const num = Number(e.key);
    if (num >= 1 && num <= 9) {
      const buttons = document.querySelectorAll('.option-btn');
      const btn = buttons[num - 1];
      if (btn) {
        e.preventDefault();
        btn.click();
      }
    }
    return;
  }

  if (e.key === 'Enter' || e.key === ' ') {
    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) {
      e.preventDefault();
      nextBtn.click();
    }
  }
}

function init() {
  state.language = loadLanguage();
  state.excluded = loadExcluded();
  renderApp();
  document.addEventListener('keydown', handleKeydown);
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(console.error);
    });
  }
}

init();
