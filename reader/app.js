// ============================================================
// Moomin per se Illustrata — Reader App (v3)
// ============================================================
// Serve from the project root:
//   python -m http.server 8000
//   Open http://localhost:8000/reader/
// ============================================================

const JSON_BASE = '../pipeline_output/chapters';
const IMAGE_BASE = '../pipeline_output/images_gemini';
const AUDIO_BASE = '../pipeline_output/audio';
const APPENDIX_BASE = 'appendices';
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
  currentAudio: null,    // currently playing Audio element
  currentPlayBtn: null,  // currently active play button element
  completedChapters: new Set(),  // chapters the user has finished
  lastChapter: null,             // last chapter the user was reading
  appendixCache: {},             // { 1: appendixData, ... }
  appendixOpen: false,
};

// ----- Persistence -----

function loadSettings() {
  try {
    const mode = localStorage.getItem('moomin-furigana-mode');
    if (mode && FURIGANA_MODES.includes(mode)) {
      state.furiganaMode = mode;
    }
    // kanjiExposures are now computed deterministically from chapter data
    // (see computePriorExposures). Clean up any stale persisted data.
    localStorage.removeItem('moomin-kanji-exposures');

    // Load reading progress
    const completed = localStorage.getItem('moomin-completed-chapters');
    if (completed) {
      JSON.parse(completed).forEach(n => state.completedChapters.add(n));
    }
    const last = localStorage.getItem('moomin-last-chapter');
    if (last) state.lastChapter = parseInt(last, 10);
  } catch (e) {
    console.warn('Could not load settings:', e);
  }
}

function saveSettings() {
  try {
    localStorage.setItem('moomin-furigana-mode', state.furiganaMode);
    localStorage.setItem('moomin-completed-chapters',
      JSON.stringify([...state.completedChapters]));
    if (state.lastChapter) {
      localStorage.setItem('moomin-last-chapter', String(state.lastChapter));
    }
  } catch (e) {
    console.warn('Could not save settings:', e);
  }
}

function markChapterComplete(num) {
  if (!state.completedChapters.has(num)) {
    state.completedChapters.add(num);
    saveSettings();
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

async function loadAppendix(num) {
  if (state.appendixCache[num]) return state.appendixCache[num];
  const padded = String(num).padStart(2, '0');
  const url = `${APPENDIX_BASE}/ch${padded}_appendix.json`;
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    const data = await r.json();
    state.appendixCache[num] = data;
    return data;
  } catch (e) {
    return null;
  }
}

// ----- Utility -----

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// ----- Furigana Rendering -----

const KANA_RE  = /[\u3040-\u309f\u30a0-\u30ff]/;
const KANJI_RE = /[\u4e00-\u9fff]/;

/**
 * Split a surface + reading into kanji stem, stem reading, and okurigana.
 *
 *   splitOkurigana("待つ", "まつ")  → { stem: "待", reading: "ま", oku: "つ" }
 *   splitOkurigana("少し", "すこし") → { stem: "少", reading: "すこ", oku: "し" }
 *   splitOkurigana("帽子", "ぼうし") → { stem: "帽子", reading: "ぼうし", oku: "" }
 *
 * Trailing kana in the surface that match the trailing kana of the reading
 * are stripped off as okurigana — they already appear in the base text and
 * don't need furigana.
 */
function splitOkurigana(surface, reading) {
  // Count trailing kana in the surface
  let trailing = 0;
  for (let i = surface.length - 1; i >= 0; i--) {
    if (KANA_RE.test(surface[i])) trailing++;
    else break;
  }

  // No trailing kana, or surface is ALL kana → full ruby
  if (trailing === 0 || trailing === surface.length) {
    return { stem: surface, reading, oku: '' };
  }

  const oku = surface.slice(surface.length - trailing);

  // Verify the reading ends with the same kana (guards against sound changes)
  if (reading.endsWith(oku)) {
    return {
      stem: surface.slice(0, surface.length - trailing),
      reading: reading.slice(0, reading.length - trailing),
      oku,
    };
  }

  // Can't split cleanly — fall back to full ruby
  return { stem: surface, reading, oku: '' };
}

/**
 * For AUTO mode: count how many times each kanji surface appeared in
 * all chapters *before* the given chapter number.  This makes the count
 * deterministic and independent of browsing order — going back to ch 1
 * always shows full furigana because there are zero prior chapters.
 */
function computePriorExposures(chapterNum) {
  const exposures = {};
  for (const num of state.chapterList) {
    if (num >= chapterNum) break;          // only earlier chapters
    const ch = state.chapters[num];
    if (!ch) continue;
    for (const s of ch.sentences) {
      for (const r of (s.readings || [])) {
        exposures[r.surface] = (exposures[r.surface] || 0) + 1;
      }
    }
  }
  return exposures;
}

function renderJapaneseWithFurigana(sentence) {
  const text = sentence.japanese;
  const readings = sentence.readings || [];

  if (!readings.length || state.furiganaMode === 'OFF') {
    return escapeHtml(text);
  }

  // --- Build placements: advance searchPos so duplicate surfaces
  //     (e.g. 木 appearing twice in "木、木。") each match their own
  //     occurrence in the source text.
  const placements = [];
  let searchPos = 0;
  for (const r of readings) {
    const idx = text.indexOf(r.surface, searchPos);
    if (idx >= 0) {
      placements.push({
        start: idx,
        end: idx + r.surface.length,
        surface: r.surface,
        reading: r.reading,
      });
      searchPos = idx + r.surface.length;
    }
  }
  placements.sort((a, b) => a.start - b.start);

  // --- Render
  let result = '';
  let pos = 0;

  for (const p of placements) {
    // Text before this token
    if (p.start > pos) {
      result += escapeHtml(text.slice(pos, p.start));
    }

    // AUTO visibility
    let showFurigana = true;
    if (state.furiganaMode === 'AUTO') {
      const exposures = state.kanjiExposures[p.surface] || 0;
      showFurigana = exposures < FURIGANA_FADE_THRESHOLD;
      state.kanjiExposures[p.surface] = exposures + 1;
    }

    const visClass = showFurigana ? '' : ' class="furigana-hidden"';

    // Split okurigana so furigana only sits above the kanji stem
    const { stem, reading, oku } = splitOkurigana(p.surface, p.reading);
    result += `<ruby>${escapeHtml(stem)}<rt${visClass}>${escapeHtml(reading)}</rt></ruby>${escapeHtml(oku)}`;

    pos = p.end;
  }

  // Remaining text after last token
  if (pos < text.length) {
    result += escapeHtml(text.slice(pos));
  }

  return result;
}

// ----- Audio Playback -----

/**
 * Toggle play/pause for a sentence audio clip.
 * Only one clip plays at a time — starting a new one stops the previous.
 * If the audio file doesn't exist, the error handler hides the button.
 */
function toggleAudio(btn, audioSrc) {
  // If clicking the currently playing button → pause
  if (state.currentAudio && state.currentPlayBtn === btn) {
    if (state.currentAudio.paused) {
      state.currentAudio.play();
      btn.classList.add('playing');
      btn.innerHTML = '&#9646;&#9646;'; // ⏸
    } else {
      state.currentAudio.pause();
      btn.classList.remove('playing');
      btn.innerHTML = '&#9654;'; // ▶
    }
    return;
  }

  // Stop any currently playing audio
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio.currentTime = 0;
    if (state.currentPlayBtn) {
      state.currentPlayBtn.classList.remove('playing');
      state.currentPlayBtn.innerHTML = '&#9654;';
    }
  }

  // Create new audio
  const audio = new Audio(audioSrc);
  state.currentAudio = audio;
  state.currentPlayBtn = btn;

  audio.addEventListener('ended', () => {
    btn.classList.remove('playing');
    btn.innerHTML = '&#9654;';
    state.currentAudio = null;
    state.currentPlayBtn = null;
  });

  audio.addEventListener('error', () => {
    // Audio file doesn't exist — hide the button
    btn.style.display = 'none';
    state.currentAudio = null;
    state.currentPlayBtn = null;
  }, { once: true });

  audio.play().then(() => {
    btn.classList.add('playing');
    btn.innerHTML = '&#9646;&#9646;';
  }).catch(() => {
    // Autoplay blocked or file missing
    btn.style.display = 'none';
  });
}

/**
 * Find the most visible sentence card and play its audio.
 * Used for the Space keyboard shortcut.
 */
function playVisibleSentenceAudio() {
  const cards = document.querySelectorAll('.sentence-card');
  if (!cards.length) return;

  const threshold = window.innerHeight * 0.5;
  let bestCard = cards[0];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.top < threshold && rect.bottom > 0) {
      bestCard = card;
    }
  }

  const playBtn = bestCard.querySelector('.play-btn');
  if (playBtn && playBtn.style.display !== 'none') {
    playBtn.click();
  }
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
  state.lastChapter = num;

  renderReader(ch);
  showView('reader');
  updateChapterNavButtons();
  history.pushState({ chapter: num }, '', `#ch${num}`);
  saveSettings();
}

function openPrevChapter() {
  if (!state.currentChapter) return;
  const idx = state.chapterList.indexOf(state.currentChapter);
  if (idx > 0) {
    stopAudio();
    openChapter(state.chapterList[idx - 1]);
  }
}

function openNextChapter() {
  if (!state.currentChapter) return;
  const idx = state.chapterList.indexOf(state.currentChapter);
  if (idx < state.chapterList.length - 1) {
    stopAudio();
    openChapter(state.chapterList[idx + 1]);
  }
}

function updateChapterNavButtons() {
  const prevBtn = document.getElementById('prev-chapter-btn');
  const nextBtn = document.getElementById('next-chapter-btn');
  if (!state.currentChapter) return;

  const idx = state.chapterList.indexOf(state.currentChapter);
  prevBtn.disabled = (idx <= 0);
  nextBtn.disabled = (idx >= state.chapterList.length - 1);
}

function stopAudio() {
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio = null;
    state.currentPlayBtn = null;
  }
}

function goBack() {
  stopAudio();
  state.currentChapter = null;
  renderLanding(); // re-render to update checkmarks
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

  // Continue banner
  const banner = document.getElementById('continue-banner');
  const continueBtn = document.getElementById('continue-btn');
  const continueLabel = document.getElementById('continue-chapter-label');

  // Find the next unread chapter, or fall back to lastChapter
  let continueNum = null;
  if (state.lastChapter && state.chapters[state.lastChapter]) {
    continueNum = state.lastChapter;
  }
  // If last chapter is completed, advance to next incomplete
  if (continueNum && state.completedChapters.has(continueNum)) {
    const idx = state.chapterList.indexOf(continueNum);
    for (let i = idx + 1; i < state.chapterList.length; i++) {
      if (!state.completedChapters.has(state.chapterList[i])) {
        continueNum = state.chapterList[i];
        break;
      }
    }
  }

  if (continueNum && state.chapters[continueNum]) {
    const ch = state.chapters[continueNum];
    continueLabel.textContent = `Chapter ${continueNum} — ${ch.title}`;
    banner.style.display = '';
    continueBtn.onclick = () => openChapter(continueNum);
  } else {
    banner.style.display = 'none';
  }

  // Chapter cards
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

    const completedMark = state.completedChapters.has(num)
      ? '<span class="chapter-check" title="Completed">&#10003;</span>'
      : '';

    card.innerHTML = `
      <span class="chapter-num">Chapter ${num} ${completedMark}</span>
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
  // For AUTO mode, seed exposure counts from all *earlier* chapters.
  // This makes the count deterministic: ch 1 always shows full furigana
  // (no prior chapters), and later chapters fade out well-known kanji.
  // Within-chapter exposure increments still happen during rendering.
  if (state.furiganaMode === 'AUTO') {
    state.kanjiExposures = computePriorExposures(chapter.chapter);
  }

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

  // Appendix — try to load, show section if available
  state.appendixOpen = false;
  const appendixSection = document.getElementById('appendix-section');
  const appendixContent = document.getElementById('appendix-content');
  const appendixArrow = appendixSection.querySelector('.appendix-arrow');
  appendixSection.style.display = 'none';
  appendixContent.innerHTML = '';
  if (appendixArrow) appendixArrow.textContent = '▶';

  loadAppendix(chapter.chapter).then(data => {
    if (data) {
      appendixSection.style.display = '';
      renderAppendixContent(data, appendixContent);
    }
  });

  // Sentences
  const container = document.getElementById('sentence-scroll');
  container.innerHTML = '';

  chapter.sentences.forEach((s) => {
    const card = document.createElement('article');
    card.className = 'sentence-card';
    card.dataset.sentenceId = s.id;

    // Render Japanese with furigana
    const japaneseHtml = renderJapaneseWithFurigana(s);

    // Image: use explicit s.image if set, otherwise auto-detect from
    // IMAGE_BASE/{id}.png. On load failure, swap to the placeholder.
    // Images appear instantly when generated — just refresh the page.
    const imgSrc = s.image || `${IMAGE_BASE}/${s.id}.png`;
    const promptText = s.imagePrompt || '';

    const wrapper = document.createElement('div');
    wrapper.className = 'image-wrapper';

    const img = document.createElement('img');
    img.className = 'sentence-image';
    img.alt = promptText;
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      wrapper.innerHTML = '';
      const ph = document.createElement('div');
      ph.className = 'image-placeholder';
      ph.innerHTML = `<div class="placeholder-icon">\uD83D\uDDBC\uFE0F</div>`;
      const cap = document.createElement('p');
      cap.className = 'placeholder-caption';
      cap.textContent = promptText;
      ph.appendChild(cap);
      wrapper.appendChild(ph);
    }, { once: true });
    img.src = imgSrc;
    wrapper.appendChild(img);

    card.appendChild(wrapper);

    // Audio play button — auto-hides if .ogg file doesn't exist
    const audioSrc = `${AUDIO_BASE}/${s.id}.ogg`;
    const audioRow = document.createElement('div');
    audioRow.className = 'audio-row';
    const playBtn = document.createElement('button');
    playBtn.className = 'play-btn';
    playBtn.innerHTML = '&#9654;'; // ▶
    playBtn.title = 'Play audio';
    playBtn.addEventListener('click', () => toggleAudio(playBtn, audioSrc));
    audioRow.appendChild(playBtn);
    card.appendChild(audioRow);

    const jp = document.createElement('p');
    jp.className = 'sentence-japanese';
    jp.innerHTML = japaneseHtml;
    card.appendChild(jp);

    const idSpan = document.createElement('span');
    idSpan.className = 'sentence-id';
    idSpan.textContent = s.id;
    card.appendChild(idSpan);

    container.appendChild(card);
  });

  // Reset progress
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-text').textContent =
    `0 / ${chapter.sentences.length}`;
}

// ----- Appendix Rendering -----

function renderAppendixContent(data, container) {
  let html = '';

  // Grammar note
  if (data.grammarNote) {
    html += `<div class="appendix-grammar">`;
    html += `<h5>${escapeHtml(data.grammarNote.title)}</h5>`;
    html += `<p>${escapeHtml(data.grammarNote.explanation)}</p>`;
    if (data.grammarNote.examples && data.grammarNote.examples.length) {
      html += `<div class="appendix-examples">`;
      for (const ex of data.grammarNote.examples) {
        html += `<div class="appendix-example">`;
        html += `<span class="ex-jp">${escapeHtml(ex.japanese)}</span>`;
        if (ex.gloss) html += `<span class="ex-gloss">${escapeHtml(ex.gloss)}</span>`;
        if (ex.english) html += `<span class="ex-en">${escapeHtml(ex.english)}</span>`;
        html += `</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  // Vocabulary
  if (data.vocabulary && data.vocabulary.length) {
    html += `<div class="appendix-vocab">`;
    html += `<h5>New Vocabulary</h5>`;
    html += `<dl class="appendix-vocab-list">`;
    for (const v of data.vocabulary) {
      const kanjiPart = v.kanji ? ` (${escapeHtml(v.kanji)})` : '';
      html += `<dt>${escapeHtml(v.word)}${kanjiPart}</dt>`;
      html += `<dd>${escapeHtml(v.meaning)}`;
      if (v.example) html += ` <span class="vocab-ex">${escapeHtml(v.example)}</span>`;
      html += `</dd>`;
    }
    html += `</dl>`;
    html += `</div>`;
  }

  // Story note
  if (data.storyNote) {
    html += `<div class="appendix-story">`;
    html += `<h5>Story Context</h5>`;
    html += `<p>${escapeHtml(data.storyNote)}</p>`;
    html += `</div>`;
  }

  container.innerHTML = html;
}

function toggleAppendix() {
  state.appendixOpen = !state.appendixOpen;
  const content = document.getElementById('appendix-content');
  const arrow = document.querySelector('.appendix-arrow');
  if (state.appendixOpen) {
    content.classList.add('open');
    if (arrow) arrow.textContent = '▼';
  } else {
    content.classList.remove('open');
    if (arrow) arrow.textContent = '▶';
  }
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

    // Mark chapter complete when last sentence is visible
    if (visibleIndex >= ch.sentences.length) {
      markChapterComplete(state.currentChapter);
    }
  }, { passive: true });
}

// ----- Sentence Scrolling (J/K navigation) -----

function scrollToSentence(direction) {
  const cards = document.querySelectorAll('.sentence-card');
  if (!cards.length) return;

  const threshold = window.innerHeight * 0.4;
  let currentIdx = 0;
  cards.forEach((card, i) => {
    if (card.getBoundingClientRect().top < threshold) currentIdx = i;
  });

  const targetIdx = direction === 'next'
    ? Math.min(currentIdx + 1, cards.length - 1)
    : Math.max(currentIdx - 1, 0);

  cards[targetIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    // Ignore if user is typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (state.currentView === 'reader') {
      if (e.key === 'Escape') {
        goBack();
        return;
      }
      // F key toggles furigana
      if (e.key === 'f' || e.key === 'F') {
        cycleFuriganaMode();
        return;
      }
      // ← / → for chapter navigation
      if (e.key === 'ArrowLeft') {
        openPrevChapter();
        return;
      }
      if (e.key === 'ArrowRight') {
        openNextChapter();
        return;
      }
      // J / K for sentence scrolling
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        scrollToSentence('next');
        return;
      }
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        scrollToSentence('prev');
        return;
      }
      // Space to play visible sentence audio
      if (e.key === ' ') {
        e.preventDefault();
        playVisibleSentenceAudio();
        return;
      }
      // G to toggle study guide
      if (e.key === 'g' || e.key === 'G') {
        const section = document.getElementById('appendix-section');
        if (section && section.style.display !== 'none') {
          toggleAppendix();
        }
        return;
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

  // Chapter navigation buttons
  document.getElementById('prev-chapter-btn').addEventListener('click', openPrevChapter);
  document.getElementById('next-chapter-btn').addEventListener('click', openNextChapter);

  // Appendix toggle
  document.getElementById('appendix-toggle').addEventListener('click', toggleAppendix);

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
