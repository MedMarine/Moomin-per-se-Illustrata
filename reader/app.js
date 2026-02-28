// ============================================================
// Moomin per se Illustrata — Reader App (v2)
// ============================================================
// Serve from the project root:
//   python -m http.server 8000
//   Open http://localhost:8000/reader/
// ============================================================

const JSON_BASE = '../pipeline_output/chapters';
const MANIFEST_URL = `${JSON_BASE}/manifest.json`;
const MAX_CHAPTER_PROBE = 99; // fallback if no manifest

// ----- Furigana Settings -----

const FURIGANA_MODES = ['AUTO', 'ON', 'OFF'];
const FURIGANA_FADE_THRESHOLD = 5; // exposures before hiding in AUTO mode

// ----- State -----

const state = {
  chapters: {},        // { 1: chapterData, 2: chapterData, ... }
  chapterList: [],     // [1, 2, 3, ...] available chapter numbers
  currentChapter: null,
  currentView: 'landing',
  furiganaMode: 'AUTO',  // 'AUTO' | 'ON' | 'OFF'
  kanjiExposures: {},    // { "見える": 3, "今日": 5 } tracks how many times user has seen each kanji word
};

// ----- Persistence -----

function loadSettings() {
  try {
    const mode = localStorage.getItem('moomin-furigana-mode');
    if (mode && FURIGANA_MODES.includes(mode)) {
      state.furiganaMode = mode;
    }
    const exposures = localStorage.getItem('moomin-kanji-exposures');
    if (exposures) {
      state.kanjiExposures = JSON.parse(exposures);
    }
  } catch (e) {
    console.warn('Could not load settings:', e);
  }
}

function saveSettings() {
  try {
    localStorage.setItem('moomin-furigana-mode', state.furiganaMode);
    localStorage.setItem('moomin-kanji-exposures', JSON.stringify(state.kanjiExposures));
  } catch (e) {
    console.warn('Could not save settings:', e);
  }
}

// ----- Data Loading -----

async function loadManifest() {
  try {
    const r = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const manifest = await r.json();
    return manifest.chapters || [];
  } catch (e) {
    console.warn('No manifest found, probing for chapters...');
    return null;
  }
}

async function loadChapter(num) {
  const padded = String(num).padStart(2, '0');
  const url = `${JSON_BASE}/ch${padded}_spec.json`;
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function loadAllChapters() {
  // Try manifest first
  let chapterNums = await loadManifest();

  if (chapterNums) {
    // Load from manifest
    const promises = chapterNums.map(num => loadChapter(num));
    const results = await Promise.all(promises);
    results.forEach((data, i) => {
      if (data) {
        state.chapters[chapterNums[i]] = data;
        state.chapterList.push(chapterNums[i]);
      }
    });
  } else {
    // Fallback: probe sequentially until we hit a gap
    for (let i = 1; i <= MAX_CHAPTER_PROBE; i++) {
      const data = await loadChapter(i);
      if (!data) break;
      state.chapters[i] = data;
      state.chapterList.push(i);
    }
  }

  state.chapterList.sort((a, b) => a - b);
}

// ----- Utility -----

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// ----- Furigana Rendering -----

function renderJapaneseWithFurigana(sentence) {
  const text = sentence.japanese;
  const readings = sentence.readings || [];

  if (!readings.length || state.furiganaMode === 'OFF') {
    return escapeHtml(text);
  }

  // Build a map of kanji surface → reading
  const readingMap = {};
  for (const r of readings) {
    readingMap[r.surface] = r.reading;
  }

  // Track kanji exposures for AUTO mode
  if (state.furiganaMode === 'AUTO') {
    for (const r of readings) {
      if (!state.kanjiExposures[r.surface]) {
        state.kanjiExposures[r.surface] = 0;
      }
    }
  }

  // Replace kanji words with ruby annotations
  let result = '';
  let pos = 0;

  // Sort readings by position in text (find each occurrence)
  const placements = [];
  for (const r of readings) {
    const idx = text.indexOf(r.surface, pos);
    if (idx >= 0) {
      placements.push({ start: idx, end: idx + r.surface.length, surface: r.surface, reading: r.reading });
    }
  }
  placements.sort((a, b) => a.start - b.start);

  for (const p of placements) {
    // Add text before this kanji
    if (p.start > pos) {
      result += escapeHtml(text.slice(pos, p.start));
    }

    // Determine if furigana should be visible
    let showFurigana = true;
    if (state.furiganaMode === 'AUTO') {
      const exposures = state.kanjiExposures[p.surface] || 0;
      showFurigana = exposures < FURIGANA_FADE_THRESHOLD;
      // Increment exposure
      state.kanjiExposures[p.surface] = exposures + 1;
    }

    const visClass = showFurigana ? '' : ' class="furigana-hidden"';
    result += `<ruby>${escapeHtml(p.surface)}<rt${visClass}>${escapeHtml(p.reading)}</rt></ruby>`;
    pos = p.end;
  }

  // Add remaining text
  if (pos < text.length) {
    result += escapeHtml(text.slice(pos));
  }

  return result;
}

// ----- Navigation -----

function showView(name) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(name);
  if (target) {
    target.classList.add('active');
    state.currentView = name;
  }
  window.scrollTo(0, 0);
}

function openChapter(num) {
  const ch = state.chapters[num];
  if (!ch) return;
  state.currentChapter = num;

  // Reset kanji exposures tracking for this chapter view
  // (AUTO mode counts per reading session, not cumulative)
  renderReader(ch);
  showView('reader');
  history.pushState({ chapter: num }, '', `#ch${num}`);
  saveSettings();
}

function goBack() {
  state.currentChapter = null;
  showView('landing');
  history.pushState(null, '', window.location.pathname);
  saveSettings();
}

window.addEventListener('popstate', (e) => {
  if (e.state && e.state.chapter) {
    openChapter(e.state.chapter);
  } else {
    state.currentChapter = null;
    showView('landing');
  }
});

// ----- Rendering: Landing Page -----

function renderLanding() {
  const grid = document.getElementById('chapter-grid');
  grid.innerHTML = '';

  for (const num of state.chapterList) {
    const ch = state.chapters[num];
    if (!ch) continue;

    const card = document.createElement('div');
    card.className = 'chapter-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.addEventListener('click', () => openChapter(num));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openChapter(num);
      }
    });

    card.innerHTML = `
      <span class="chapter-num">Chapter ${num}</span>
      <h3 class="chapter-title">${escapeHtml(ch.title)}</h3>
      <span class="grammar-label">GS${ch.grammarStep}: ${escapeHtml(ch.grammarName)}</span>
      <div class="card-meta">
        <span>${ch.sentences.length} sentences</span>
        <span>${ch.newLemmas.length} new words</span>
      </div>
      <div class="card-characters">${ch.scene.characters.map(escapeHtml).join(' \u30FB ')}</div>
    `;

    grid.appendChild(card);
  }
}

// ----- Rendering: Reader -----

function renderReader(chapter) {
  // Header
  document.getElementById('reader-chapter-num').textContent = `Chapter ${chapter.chapter}`;
  document.getElementById('reader-chapter-title').textContent = chapter.title;
  document.getElementById('reader-grammar-badge').textContent =
    `GS${chapter.grammarStep}: ${chapter.grammarName}`;

  // Update furigana toggle label
  updateFuriganaLabel();

  // Vocab panel
  const vocabList = document.getElementById('vocab-list');
  vocabList.innerHTML = '';
  chapter.newLemmas.forEach(lemma => {
    const li = document.createElement('li');
    li.className = 'vocab-item';
    li.textContent = lemma;
    vocabList.appendChild(li);
  });

  // Scene
  document.getElementById('scene-location').textContent = chapter.scene.location;
  document.getElementById('scene-characters').textContent =
    chapter.scene.characters.join('\u3001');

  // Collapse vocab panel on mobile after rendering
  const panel = document.getElementById('vocab-panel');
  panel.classList.remove('expanded');

  // Sentences
  const container = document.getElementById('sentence-scroll');
  container.innerHTML = '';

  chapter.sentences.forEach((s) => {
    const card = document.createElement('article');
    card.className = 'sentence-card';
    card.dataset.sentenceId = s.id;

    // Render Japanese with furigana
    const japaneseHtml = renderJapaneseWithFurigana(s);

    // Check if a real image exists
    if (s.image) {
      card.innerHTML = `
        <img class="sentence-image"
             src="${escapeHtml(s.image)}"
             alt="${escapeHtml(s.imagePrompt)}"
             loading="lazy">
        <p class="sentence-japanese">${japaneseHtml}</p>
        <span class="sentence-id">${escapeHtml(s.id)}</span>
      `;
    } else {
      card.innerHTML = `
        <div class="image-placeholder">
          <div class="placeholder-icon">\uD83D\uDDBC\uFE0F</div>
          <p class="placeholder-caption">${escapeHtml(s.imagePrompt)}</p>
        </div>
        <p class="sentence-japanese">${japaneseHtml}</p>
        <span class="sentence-id">${escapeHtml(s.id)}</span>
      `;
    }

    container.appendChild(card);
  });

  // Reset progress
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-text').textContent =
    `0 / ${chapter.sentences.length}`;
}

// ----- Furigana Toggle -----

function updateFuriganaLabel() {
  const label = document.getElementById('furigana-mode-label');
  if (label) {
    label.textContent = state.furiganaMode;
  }
}

function cycleFuriganaMode() {
  const idx = FURIGANA_MODES.indexOf(state.furiganaMode);
  state.furiganaMode = FURIGANA_MODES[(idx + 1) % FURIGANA_MODES.length];
  updateFuriganaLabel();
  saveSettings();

  // Re-render current chapter if viewing
  if (state.currentView === 'reader' && state.currentChapter) {
    const ch = state.chapters[state.currentChapter];
    if (ch) renderReader(ch);
  }
}

function setupFuriganaToggle() {
  const btn = document.getElementById('furigana-toggle');
  if (btn) {
    btn.addEventListener('click', cycleFuriganaMode);
  }
}

// ----- Scroll Progress -----

function setupScrollProgress() {
  window.addEventListener('scroll', () => {
    if (state.currentView !== 'reader' || !state.currentChapter) return;

    const ch = state.chapters[state.currentChapter];
    if (!ch) return;

    const cards = document.querySelectorAll('.sentence-card');
    if (!cards.length) return;

    // Calculate which sentence is visible
    let visibleIndex = 0;
    const threshold = window.innerHeight * 0.5;
    cards.forEach((card, i) => {
      const rect = card.getBoundingClientRect();
      if (rect.top < threshold) visibleIndex = i + 1;
    });

    // Update progress bar
    const progress = cards.length > 0 ? visibleIndex / cards.length : 0;
    document.getElementById('progress-fill').style.width =
      `${Math.min(progress * 100, 100)}%`;
    document.getElementById('progress-text').textContent =
      `${visibleIndex} / ${ch.sentences.length}`;
  }, { passive: true });
}

// ----- Mobile Vocab Toggle -----

function setupVocabToggle() {
  const toggle = document.getElementById('vocab-toggle');
  const panel = document.getElementById('vocab-panel');

  toggle.addEventListener('click', (e) => {
    // Only toggle on mobile
    if (window.innerWidth <= 768) {
      panel.classList.toggle('expanded');
    }
  });

  // Close panel when clicking a sentence card on mobile
  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 768 &&
        !panel.contains(e.target) &&
        panel.classList.contains('expanded')) {
      panel.classList.remove('expanded');
    }
  });
}

// ----- Keyboard Navigation -----

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (state.currentView === 'reader') {
      if (e.key === 'Escape') {
        goBack();
      }
      // F key toggles furigana
      if (e.key === 'f' || e.key === 'F') {
        cycleFuriganaMode();
      }
    }
  });
}

// ----- Init -----

async function init() {
  loadSettings();
  await loadAllChapters();
  renderLanding();
  setupScrollProgress();
  setupVocabToggle();
  setupFuriganaToggle();
  setupKeyboard();

  // Back button
  document.getElementById('back-btn').addEventListener('click', (e) => {
    e.preventDefault();
    goBack();
  });

  // Handle initial hash
  const hash = location.hash;
  const match = hash.match(/^#ch(\d+)$/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (state.chapters[num]) {
      openChapter(num);
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
