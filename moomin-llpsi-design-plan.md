# Media-Targeted Graded Reader — Design Plan

## Project Summary

Build a graded reader modeled on *Lingua Latina per se Illustrata* (LLPSI) that bootstraps learners to ≥90% running token comprehension of a target media source — in this case, the 1990 *楽しいムーミン一家* anime. The reader enforces monolingual immersion (zero L1), inductive grammar acquisition through illustrated narrative, and a strict lexical–grammatical staircase derived from actual target scripts.

The core thesis: if every sentence is comprehensible input built from known material plus exactly one new element, and if that material reflects the frequency distribution of the target media, then a learner who completes the reader will understand the source without subtitles.

The pipeline is generalizable. Different target media (anime, drama, news, manga) require only a new corpus ingestion and staircase derivation. The chapter spec format, validation engine, and web reader are reusable. The reference implementation targets Japanese with Moomin scripts, but the architecture applies to any language with a morphological analyzer.

---

## Why LLPSI Works and Where Japanese Diverges

LLPSI succeeds because Latin shares an alphabet with its learners, has regular morphology that maps to visible case endings, and presents a single orthographic system. Japanese breaks all three assumptions: three scripts (hiragana, katakana, kanji), agglutinative verb morphology, a particle system with no Latin analogue, and SOV word order that delays the verb to sentence-final position.

The LLPSI *method* transfers but the *sequencing logic* does not:

**Orthographic load is a first-class design variable.** In LLPSI, the reader never struggles to *read* a word — only to *understand* it. In Japanese, reading itself is a skill that must be staircased alongside grammar and vocabulary. The plan tracks three independent progressions: script familiarity, lexical knowledge, and grammatical competence.

**Particles replace case endings as the primary contrast vehicle.** LLPSI teaches nominative vs. accusative via case endings (Marcus → Marcum). Japanese teaches the same contrast via は/が/を particles — phonologically minimal, visually identical in running text. Illustration-based minimal pairs become essential: the image *is* the gloss.

**Verb-final order changes recycling dynamics.** In LLPSI, the verb appears early, anchoring meaning. In Japanese, the learner must hold an incomplete parse until the sentence-final predicate. Early chapters must use very short sentences (2–4 bunsetsu) to keep working memory load manageable, then gradually extend.

**Register is not optional.** Anime uses specific blends of polite and plain forms tied to character voice. Unlike Latin, where register is mostly a vocabulary problem, Japanese register alters verb morphology. The staircase commits to a backbone register early (plain, matching the protagonist's speech) and introduces polite forms as a *character contrast* rather than a grammar topic.

---

## Architecture Overview

The system has three layers:

1. **Corpus layer** — ingested episode scripts, tokenized and annotated with lemma, POS, particle frames, character IDs, and depictability scores.
2. **Staircase engine** — a constraint solver that selects chapter deltas (new lemmas, new grammar contrast) under hard budgets, optimizing for frequency × depictability.
3. **Chapter renderer** — takes a chapter spec and produces: narrative text, image prompts (schema-locked), exercises, and web reader JSON.

A human reviews only validator failures and edge cases. Everything else is automated or semi-automated.

---

## Phase 1: Corpus Ingestion

**Goal**: Transform raw scripts into a structured, queryable dataset that drives all downstream decisions.

### 1.1 Script acquisition and cleaning

Obtain scripts for the target episodes. Prefer full scripts over subtitle files — subtitles compress grammar, drop particles, and paraphrase. If only subtitles are available, flag compressed lines for manual review.

Normalize text: strip timing codes, extract speaker labels into structured fields, collapse full-width punctuation, and segment into utterance units.

### 1.2 Tokenization and lemmatization

Use a morphological analyzer with consistent lemma normalization. For Japanese: MeCab with UniDic (not IPAdic — UniDic's lemma normalization is more consistent for frequency counting). **Freeze the dictionary version at project start**; switching analyzers mid-project produces lemma drift that breaks coverage calculations.

For each token, extract: surface form, lemma, POS, conjugation type, conjugation form, reading.

**Critical: UniDic→learner lemma mapping.** UniDic normalizes to etymological forms (為る for する, 居る for いる, 其れ for それ). The staircase needs a mapping table (`UNIDIC_TO_LEARNER`) so that learners see いる, not 居る. The Moomin corpus required 168+ mappings covering common verbs (行く→いく, 来る→くる, 食べる→たべる), demonstratives (此の→この, 其処→そこ), and pronouns. SudachiPy was evaluated as an alternative normalizer but is not viable on Python 3.14 (requires Rust compiler, no pre-built wheels). The manual mapping table, while labor-intensive to build initially, provides full control over pedagogical form choices.

### 1.3 Particle frame extraction

Beyond POS tagging, identify particle frames — the particle + its syntactic role in context:

- が-subject (animate/inanimate), が-object (of potential/desiderative)
- を-patient, を-path
- に-location, に-goal, に-time, に-indirect object
- で-location (of action), で-instrument, で-cause
- は-topic (subject), は-contrastive
- と-quotative, と-comitative, と-conditional

Frame assignment requires dependency parsing (Stanza, which provides Japanese UD models) plus manual correction for the first pass. GiNZA was evaluated but requires SudachiPy (not viable on Python 3.14). Stanza's dependency parsing integrates with the MeCab+UniDic tokenization pipeline via a hybrid architecture where MeCab handles morphology and Stanza handles syntax.

### 1.4 Depictability scoring

For each lemma, assign a depictability score (1–5):

| Score | Criterion | Examples |
|-------|-----------|----------|
| 5 | Concrete, visually unambiguous | りんご, いえ, ムーミン |
| 4 | Concrete but requires context | たべる, あるく, あける |
| 3 | Depictable via contrast or minimal pair | おおきい vs ちいさい |
| 2 | Abstract but illustrable via scene | たのしい, さびしい |
| 1 | Abstract, requires linguistic gloss | こと, よう, わけ |

For the top 300 lemmas by frequency, score manually. For the long tail, use a heuristic (concrete nouns and motion verbs default to 4; grammatical words default to 1) and correct on review.

### 1.5 Frequency analysis

Compute token frequency (raw surface count), lemma frequency (collapsed per lemma), and type families (group inflected forms under their lemma). Produce a ranked lemma list with: rank, lemma, POS, token count, type family members attested, depictability score, earliest episode, speaker distribution.

### Phase 1 deliverables

- Tokenized, annotated episode JSONs with fields: utterance_id, speaker, text, tokens (each with lemma, POS, reading, particle_frame)
- Lemma registry: lemma → frequency, depictability, family members, particle frames, speaker distribution
- Coverage baseline: what percentage of episode 1 tokens does a learner with zero Japanese understand?

---

## Phase 2: Staircase Derivation

**Goal**: Produce a chapter-by-chapter plan specifying which lemmas and grammar contrasts each chapter introduces, under hard constraints.

### 2.1 Hard budget constraints

| Constraint | Value | Rationale |
|------------|-------|-----------|
| New lemmas per chapter | ≤ 8 | LLPSI averages 6–10; Japanese orthographic load argues for the lower end |
| New grammar contrasts | = 1 | One-dimension-at-a-time rule |
| Max new lemmas per sentence | ≤ 2 | Maintains ~90% known-token density within chapter text |
| Sentence length (early) | ≤ 6 bunsetsu | Keeps working memory load manageable |
| Sentence length (mid+) | ≤ 10 bunsetsu | Gradual extension as parser skill develops |
| Recycling density | ≥ 3 uses per new lemma, ≥ 2 syntactic frames | Prevents single-exposure vocabulary |

### 2.2 Grammar sequencing

Follow a perceptual-contrast order, not textbook order. Each step introduces one morphosyntactic dimension against a stable lexical background:

| Step | Contrast | Illustrability |
|------|----------|----------------|
| 0 | No grammar (labeling) | High — pointing, naming |
| 1 | Existence: が + いる / ある | High — point at characters/objects |
| 2 | Topic + Copula: は / に / だ (NO です) | Medium — paired images, XはYだ |
| 3 | Past: た / だった | Medium — before/after panels |
| 4 | は vs が contrast (supercharged by past) | Medium — minimal-pair illustrations |
| 5 | Motion: いく / くる with に/へ | High — arrow overlays |
| 6 | Transitive action: を with verbs | High — agent-patient depiction |
| 7 | Sentence particles: ね / よ | Medium — dialogue tone shift |
| 8 | Conjunctions: でも / だから | Medium — cause/contrast panels |
| 9 | Adjectives + single-verb noun modification | High — size contrasts; V+N parallels adj+N |
| 10 | Negation: ない (verb), じゃない (copula) | High — absent-object images |
| 11 | て-form: sequential actions | Medium — numbered action panels |
| 12 | ている: ongoing state | High — snapshot vs. progressive contrast |
| 13 | Desire: たい | Medium — thought-bubble illustration |
| 14 | Giving/receiving: あげる / もらう / くれる | High — directional arrows |
| 15 | Quotation: と いう / と おもう | Medium — speech/thought bubbles |
| 16 | Conditional: たら | Medium — if/then panels |
| 17 | Relative clauses: V+N | Low-medium — highlight modified noun |
| 18 | Polite forms: ます / です (via character voice) | High — same scene, different speaker |
| 19 | Nominalizers: の / こと | Low-medium — abstract pattern |

#### Sequencing principles

The order above is not arbitrary — it reflects structural dependencies that compound across the reader. These principles generalize to any language and target media.

**Keystone grammar belongs early.** Some grammar items unlock a disproportionate range of natural expression. Past tense is the prototypical keystone: it enables discovery expressions (あった！ いた！) that are fundamental to any visual-discovery method, powers before/after scene contrasts, and gives the copula a second form (だった) for richer descriptions. Every chapter after the keystone benefits, so early placement multiplies its return across the entire reader. When sequencing, ask: "How many future chapters does this grammar item make *more natural*?" Items with high answers are keystones. Move them forward even if they feel structurally complex — the complexity buys expressiveness that compounds.

**Register zoning, not register mixing.** Languages with morphological register distinctions (Japanese plain/polite, Korean 해체/해요체, Spanish tú/usted) face a sequencing trap: if polite forms appear early, every subsequent chapter must manage two parallel conjugation paradigms, doubling cognitive load without advancing comprehension. The fix is register zoning — commit to one register backbone for the first half of the reader, then introduce the alternative as a deliberate milestone near the end. This produces internally consistent text, lets the polite/formal register arrive as a *character-voice contrast* rather than a second way to say the same thing, and matches how children acquire register (plain first, polite as a social overlay). For Japanese, this means だ-only until step 18, then ます/です as a character-driven reveal.

**Humanizer morphemes deserve dedicated steps.** Sentence-final particles (ね, よ) and basic conjunctions (でも, だから) are zero-conjugation in Japanese — they don't require new verb morphology. But their absence makes text sound robotic. These are pragmatic, not syntactic, teaching points: ね teaches "shared knowledge" signaling, よ teaches "new information" assertion, でも teaches concession, だから teaches causation. Give each cluster its own grammar step. The sentences practically write themselves (the chapter's vocabulary just gains conversational glue), and every subsequent chapter benefits from the expanded expressiveness. The same principle applies in any language — identify the morphemes that are structurally trivial but pragmatically essential and stage them as early humanizer steps.

**Contrast steps compound with earlier keystones.** The は vs が contrast is a dedicated step because the distinction is pedagogically critical — it's not something to absorb by osmosis. But its placement relative to other steps matters enormously. With only present tense, は vs が is limited to "X is here / X exists" sentences. With past tense already available, the same contrast step gains discovery sentences (が: 帽子 が あった！), topic shifts (は: 帽子 は ここ に あった), and narrative framing. General principle: when scheduling a contrast step, audit which earlier keystones it can leverage, and sequence accordingly.

**The natural-form test gates vocabulary.** High corpus frequency does not mean early placement. Some words derive their frequency from a specific construction — placing them before that construction's grammar step forces opaque, unnatural sentences. Apply the test: "Can I write three natural sentences with this word using only the grammar available at this step?" If not, add a solver filter blocking the word until its dependent step. After generating any staircase, audit every word in the first 20 chapters with this test. Common traps: quotative-dependent verbs (いう, 思う), negation-dependent adjectives (知る → 知らない), and register-bound expressions.

#### Noun modification ladder

The original design blocked all verb+noun adjacency until relative clauses. This was wrong — it imported a Western grammatical category that doesn't map onto Japanese syntax. In Japanese, single-verb noun modification (出る スニフ = "exiting Sniff") is structurally identical to adjective modification (おおきい いえ = "big house"). Blocking it forced robotic SOV-only sentences.

The fix is a three-tier system:

- **Steps 0–8**: Block all verb+noun adjacency (prenominal modification concept not yet introduced). い-adjectives as predicates are also blocked (except ない for negation and いい as a high-frequency early-taught word).
- **Steps 9–16**: Allow single-verb modification (V + N), block complex relative clauses where the verb has its own argument (X が/を V + N)
- **Step 17+**: Allow all noun modification including complex relative clauses

Step 9 teaches the general "modifier + noun" slot via い-adjectives (おおきい/ちいさい as predicate and prenominal), and single-verb modifiers follow by analogy.

**Grammar leakage prevention**: When a grammar step introduces a new structural pattern (e.g., polite ます/です at step 18), that pattern must not appear in earlier chapters — even if the individual morphemes are on the whitelist. A sentence like ムーミン は 食べます uses ます, which is step 18 grammar. In a step 17 chapter, it must remain ムーミン は 食べる — plain form. Similarly, nominalizer patterns (食べる の が 好き) belong at step 17 and must not appear in step 16 chapters. Always ask: "Does this sentence use grammar from a later step?"

#### Grammar-vocabulary dependency filters

Some high-frequency words are unusable before the grammar they depend on. Their frequency derives from a specific construction — placing them early forces opaque sentences that violate the LLPSI principle.

| Word | Natural construction | Required step | Problem if placed early |
|------|---------------------|---------------|------------------------|
| いう | X と いう (quotative) | Step 15 | All corpus uses are と いう |
| 思う | X と おもう (quotative) | Step 15 | Same — needs quotation frame |
| 知る | 知らない / 知ってる | Step 10/12 | Plain 知る barely appears in natural speech |
| おおきい / ちいさい | Adjective modifier | Step 9 | Grammar-exemplar words should teach the い-adjective pattern, not land as early predicates |

**Implementation**: Add solver filters that block these words until their required grammar step. After generating the staircase, audit every word in the first 20 chapters by asking: "Can I write 3 natural sentences using only the grammar available at this step?" If not, add a filter.

**Fixed grammatical expressions**: Some words appear in the staircase because they're part of a fixed expression, not because they function independently. Example: 知れる appears only in かもしれない (might be). Teaching 知れる as standalone vocabulary misleads learners. **Solution**: Add such words to the functional/grammar freebie list and treat the expression as a grammar pattern, not vocabulary.

#### Register ladder

Japanese register changes verb morphology, not just vocabulary. The staircase commits to a **plain-form backbone** matching the protagonist's speech. Register variety enters through character voice contrasts.

| Phase | Grammar steps | Register approach |
|-------|--------------|-------------------|
| Labeling | GS 0–1 | No verb conjugation. Register invisible. |
| Plain backbone | GS 2–8 | Plain forms only (だ/だった). All characters speak plain. ね/よ add conversational warmth without morphological change. |
| Personality via word choice | GS 9–17 | Characters differ by vocabulary, interjections, and sentence particles — not morphology. |
| Polite contrast | GS 18 | ます/です introduced through specific characters. Same scene twice — protagonist says plain, polite character says polite. ~25 chapters of plain-only text before this point. |
| Mixed register | GS 19+ | Polite forms available but not required. Characters code-switch based on context. |

**Character register awareness**: Each character's speech style (pronoun choice, sentence-final particles, politeness level) must be consistent. Register-marked expressions (e.g., ちょうだい = feminine/childish request) should only be attributed to characters whose register profile matches.

#### Naturalization progression

| Phase | Chapters | Feature |
|-------|----------|---------|
| Explicit | Early | Full subjects, all particles, complete sentences |
| Light pro-drop | Mid | Recoverable subjects omitted, particles kept |
| Particle drop | Late-mid | Casual particle omission (を, は in topic) |
| Anime-natural | Late | Sentence fragments, contracted forms |

Pro-drop and particle-drop must never obscure the grammar contrast being taught. Naturalization applies to recycled/known material, not to sentences introducing new structures.

### 2.3 Solver logic

The staircase solver operates as a greedy optimizer with hard constraint checking:

```
for each chapter:
    candidates = lemmas not yet introduced, sorted by (frequency × depictability) descending
    select top candidates that:
        - fit within new_lemma budget
        - belong to the current or next grammar step
        - pass grammar-vocabulary dependency filters
        - do not require unseen particle frames beyond the current grammar step
    compute cumulative coverage against target episodes
    log coverage delta for this chapter
```

If coverage plateaus (<0.5% gain per chapter), shift to targeting specific grammar patterns that block comprehension rather than chasing raw token coverage.

**ESSENTIAL_ANCHORS**: High-depictability world-building words (characters, locations, key objects) receive a score bonus (+500) to ensure they land in early chapters even if their raw frequency is moderate. This prevents the frequency trap where abstract high-frequency words outrank concrete anchors.

#### Learner clusters

Some vocabulary groups must land close together for pedagogical coherence. The solver enforces **learner clusters** — sets of semantically related words with a maximum chapter spread:

| Cluster | Members | Max spread | Gate |
|---------|---------|------------|------|
| demo-ko | この, これ, ここ | 3 chapters | — |
| demo-so | その, それ, そこ | 3 chapters | — |
| demo-a | あの, あれ, あそこ | 3 chapters | — |
| demo-places | ここ, そこ, あそこ | 3 chapters | — |
| motion-directional | いく, くる | 2 chapters | GS5 |
| motion-entry-exit | はいる, でる | 3 chapters | — |
| size-adj | おおきい, ちいさい | 2 chapters | GS9 |
| family-core | ママ, パパ | 2 chapters | — |
| question-who-where | だれ, どこ | 2 chapters | GS2 |

Each cluster specifies a `max_spread` (maximum chapter gap between first and last member) and an optional `grammar_gate` (all members must appear at or after this grammar step). The anchor member (first in the list) is placed first; remaining members must follow within the spread window.

#### Grammar freebies

Some morphemes are unlocked automatically when a grammar step is reached, without consuming a vocabulary slot. These are defined at module level (`GRAMMAR_FREEBIES`) and include particles and verbs that the grammar step's constructions require:

- GS1: いる, ある, が (existence requires these)
- GS2: は, に, だ (topic/copula)
- GS3: た (past tense)
- GS5: いく, くる, へ (motion)
- GS6: を, たべる, のむ, みる (transitive actions)

Grammar freebies are distinct from the `FUNCTIONAL_ALWAYS` whitelist set. FUNCTIONAL_ALWAYS controls what the validator accepts as legal morphemes; grammar freebies control what the staircase solver treats as automatically available (so they don't waste vocabulary slots).

### 2.4 Script orthography progression

Parallel to the lexical/grammar staircase, track script introduction:

- **Early chapters**: Hiragana dominant. Katakana for character names and loanwords (visually iconic).
- **Mid chapters**: Kanji introduction. A kanji replaces its hiragana spelling only after the word has appeared ≥10 times in hiragana. First appearance shows kanji with furigana; after 3+ more exposures, furigana drops.
- **Late chapters**: Kanji-dominant for mastered words, matching the orthographic density of the target media.

### Phase 2 deliverables

- Chapter staircase: chapter → new lemmas, grammar step, cumulative coverage
- Grammar sequence with illustration requirements per step
- Script progression plan for kanji introductions
- Coverage projection graph

---

## Phase 3: Chapter Spec Generation

**Goal**: For each chapter, produce a validated specification — narrative text, image prompts, exercises.

### 3.1 Chapter design workflow

Chapter writing follows a four-step process that treats the staircase as a living document:

**Step 1 — Scene-first analysis.** Before writing any sentences, examine the next batch of chapters (typically 5) and their assigned vocabulary. For each chapter, ask: "Do these 8 words cluster into a coherent scene?" Sketch rough narrative ideas.

**Step 2 — Identify friction.** Flag words that don't fit any natural scene grouping. Common friction patterns:
- Episode-specific proper nouns mixed with general vocabulary
- Niche concrete nouns (stamps, ants) alongside abstract words
- Words that only make sense together but are split across chapters

**Step 3 — Targeted staircase swaps.** When friction is identified, make surgical vocabulary swaps between chapters *within the same grammar step tier*. This is almost always valid — same grammar constraints apply, and coverage impact is negligible. Use `--lock N` to freeze all chapters through the last completed one.

Swap criteria:
- Both chapters must share the same grammar step (or at least allow the word grammatically)
- The receiving chapter's scene should benefit from the incoming word
- Coverage across episodes should not degrade significantly

**Step 4 — Write sentences.** With vocabulary that clusters naturally into scenes, the constraint puzzle (≥3 uses, ≥2 frames, ≤2 new per sentence) becomes tractable. The narrative emerges from the vocabulary, not the other way around.

**Key insight**: There are virtually infinite valid staircases within a grammar tier. The solver optimizes globally for coverage, but scene-level coherence requires local adjustments. Treating the staircase as frozen after Phase 2 leads to vocabulary whack-a-mole — chapters where 8 unrelated words must coexist. A few targeted swaps per batch of 5 chapters eliminates this.

### 3.2 Chapter spec format

Each chapter spec is a JSON document:

```json
{
  "chapter": 7,
  "title": "帽子 を 探す",
  "grammarStep": 4,
  "grammarName": "Transitive を",
  "scene": {
    "location": "ムーミンやしきのにわ",
    "characters": ["ムーミン", "スニフ"],
    "props": ["ぼうし"]
  },
  "newLemmas": ["きみ", "みつける", "おく", "うん", "ええ", "出る", "探す", "聞く"],
  "whitelist": ["<all learner-form lemmas through this chapter>"],
  "sentences": [
    {
      "id": "ch07-01",
      "japanese": "ぼうし が ない。探す。",
      "imagePrompt": "The hat is gone! Moomintroll searches the garden path, peering under bushes."
    }
  ]
}
```

### 3.3 Validation constraints

Every sentence is tokenized by the morphological analyzer and checked:

1. **Morpheme whitelist**: Every token must be a known learner-form lemma or a grammar freebie. Any out-of-set token causes rejection.
2. **Unseen cap**: ≤2 unique new lemmas per sentence (counts all chapter-new lemmas, not just first appearances).
3. **Recycling minimum**: Each new lemma ≥3 uses, ≥2 syntactic frames (frame = preceding POS + target POS + following POS).
4. **Sentence length**: Enforced per chapter tier (≤6 bunsetsu early, ≤10 mid+).
5. **Blocked constructions**: Premature noun modification (V+N before step 6, complex relative clauses before step 16), number + bare countable noun, grammar patterns from later steps.
6. **Grammar scope**: Only the current and previously introduced grammar contrasts may appear. No "helpful" additions of grammar not yet staged.
7. **Register lock**: Backbone register unless the chapter explicitly introduces polite as a contrast.

#### MeCab disambiguation rules (Japanese-specific)

MeCab's context sensitivity creates validation pitfalls:

- **Hiragana ambiguity**: Many words must use kanji in sentences to prevent misparse (いえ→言う, かえる→変える, やま→splits). The rendering layer adds furigana.
- **Sentence-initial interjections**: Keep interjections (ほら, よし) sentence-initial — mid-sentence, MeCab reparses them as verbs.
- **Negation-sensitive words**: Some words split when sentence-initial (無くなる → 無い + 成る). Place after a particle for correct parsing.
- **Character names**: Multi-mora names may split (ニンニ→仁+二). Pre-tokenization substitution handles this.

**Rule**: Always test every sentence through the analyzer before committing. Sentences that look correct to a human may tokenize incorrectly.

### 3.4 Image generation

Images are generated via **Google Gemini Pro API** with character reference images for visual consistency. The generation pipeline:

1. **Prompt structure**: Each image prompt is a self-contained natural language description (35-55 words) with 5 components: setting, characters + action, object focus, composition, and lighting/mood. Prompts are content-only — style instructions and reference images are injected at generation time.
2. **Reference images**: Curated character frames from the 1990 anime provide visual consistency. The generator matches character names in prompts to reference image sets.
3. **Resolution standardization**: All images within a generation batch must use the **same aspect ratio and resolution** to maintain reader layout consistency. The aspect ratio is fixed in `generate_gemini.py` (`ASPECT_RATIO` constant). When regenerating individual images, use the same settings as the original batch — inconsistent dimensions break the reader grid.
4. **Review and regeneration**: After initial batch generation, review images for character accuracy, scene fidelity, and prompt alignment. Regenerate problematic images with adjusted prompts, maintaining the same resolution.

### 3.5 Image prompts and scene schemas

Image prompts are schema-locked to prevent stylistic drift:

```
Schema: kitchen-table
- Camera: eye-level, slightly above table
- Layout: table center-frame, chairs around, window background
- Character positions: seat-1 (left), seat-2 (center), seat-3 (right)
- Style: soft watercolor, rounded forms, warm palette
```

**Kosoado (demonstrative) chapters** require strict spatial protocol: speaker at position A, listener at position B, object at varying distances. これ = arm's reach, それ = near listener, あれ = far from both. AI image generators won't produce these contrasts from text alone — needs fixed composition templates.

### 3.6 Marginalia and interactive annotations

Two annotation layers enrich the reading experience:

**Marginalia** — modeled on LLPSI's margin glosses. Short equations that clarify morphological or semantic relationships, always in the target language:
- Counter equations: 一 ＝ 一つ
- Kanji readings (first encounter): 山（やま）
- Grammar pattern labels: が ← new info
- Contrastive pairs: が ≠ は

**Tap-target highlights** — tapping a word highlights its visual referent in the illustration. Morphological variants map to the same referent (一 and 一つ both highlight the same object), creating experiential understanding without translation.

### 3.7 Exercise generation

All exercises draw only from known morphemes:

- **Picture-sentence matching**: 4 images, 4 sentences. Distractors differ by one element to test the chapter's grammar contrast.
- **Cloze**: Sentence with blank. Options are syntactically plausible but only one is semantically correct given the illustration.
- **Morpheme reorder**: Scrambled sentence reassembled into correct order. Validates against all acceptable orderings.
- **Episode montage** (every 5 chapters): Sentences from prior chapters in rapid-fire dialogue approximating anime cadence.

### Phase 3 deliverables

- Chapter spec JSONs (one per chapter), all passing validation
- Image prompt library keyed by schema
- Exercise bank per chapter

---

## Phase 4: Rendering and Web Reader

**Goal**: Transform validated chapter specs into a functional web-based reader.

### 4.1 Reader features

- **Sentence-by-sentence display** with paired illustration
- **Tap-to-highlight**: tapping a word highlights its referent in the illustration (replaces translation)
- **Furigana**: shown by default for new kanji, hidden after N exposures, hover to reveal
- **Audio**: per-sentence with character-consistent voices, speed control
- **Adaptive recycling**: track per-learner exercise accuracy, resurface weak lemmas
- **Progress dashboard**: chapter completion, per-episode coverage meters, "ready to watch" indicator

### 4.2 Technical stack

Static-first web app: pre-rendered JSON/HTML per chapter, client-side interactivity (vanilla JS or lightweight framework), local learner state (IndexedDB), pre-generated images and audio as static assets.

### 4.3 Supplementary SRS

Export chapter vocabulary as Anki decks: word, reading, illustration from chapter, example sentence, audio. Provides supplementary spaced repetition without replacing the reader's built-in recycling.

---

## Phase 5: Validation and Coverage Gating

**Goal**: Ensure the system achieves its stated comprehension goal.

### 5.1 Coverage checker

Automated tool: given lemmas/grammar introduced through chapter N and a tokenized episode transcript, output token coverage percentage, uncovered tokens with frequency, and unseen grammar patterns. Run after each chapter is finalized.

### 5.2 Comprehension probes

At milestone chapters, extract 10 utterances from raw episodes that should be fully comprehensible. Present audio (no subtitles). Learner selects from paraphrases written in controlled target language. Threshold: ≥90% correct before the episode is marked "unlocked."

### 5.3 Gap analysis

If coverage stalls or probes reveal failures: identify blocking items, check if they fit in upcoming chapters, evaluate whether grammar steps can be reordered, regenerate and re-validate.

---

## Phase 6: Scale and Iterate

### 6.1 Episode expansion

After the initial episode set reaches coverage, extend to additional episodes. The staircase solver continues from the existing chapter set. Expect diminishing returns — shared vocabulary means fewer new chapters per episode.

### 6.2 Learner feedback

Instrument the reader to collect: time-per-sentence, tap-to-highlight frequency, exercise accuracy, drop-off points. Use this data to identify overloaded chapters and redistribute.

### 6.3 Generalization

The pipeline is target-agnostic. Different media require only new corpus ingestion and staircase derivation. The spec format, validation engine, and reader are reusable. Potential targets: manga, drama, news broadcasts, children's shows in any language with a morphological analyzer.

---

## Risk Registry

| Risk | Severity | Mitigation |
|------|----------|------------|
| Grammar-vocabulary mismatch: solver places words before the grammar they need | High | Grammar-dependency filters in solver; audit each word in first 20 chapters for "Can I write 3 natural sentences with current grammar?" |
| Grammar leakage: sentences use structures from a later grammar step | High | Review every sentence against current step's allowed patterns; nominalizers, relative clauses, and conditionals are common leak points |
| LLM drift: generator adds plausible but premature vocabulary or grammar | High | Hard morpheme whitelist validator; reject any chapter with out-of-set tokens |
| Image ambiguity: illustrations don't encode grammar contrasts | High | Schema-locked prompt templates with fixed composition; human review of minimal-pair images |
| Vocabulary whack-a-mole: chapter words don't cluster into a coherent scene | Medium | Scene-first workflow (§3.1); targeted staircase swaps within same grammar tier |
| Register mismatch: character says something inconsistent with their speech style | Medium | Maintain character register profiles; review dialogue attribution |
| Tokenization inconsistency: analyzer produces different lemmas across runs | Medium | Freeze analyzer + dictionary version at project start; never update mid-project |
| Analyzer context sensitivity: same text parses differently by position | Medium | Test every sentence through the analyzer; maintain disambiguation rules |
| Staircase cascade: changing one word triggers full chapter rewrite | Medium | Expect scene-level rewrites when vocabulary shifts; patching individual sentences causes narrative incoherence |
| Pro-drop trap: recycling constraints push toward explicit subjects in every sentence | Low | Phase 4 LLM polish applies pro-drop as post-processing on recycled material |
| Learner attrition: chapters feel dry or mechanical | Medium | Narrative must carry the source material's tone; review each chapter for "would I keep reading?" |

---

## Pipeline Summary

```
┌─────────────────────────────────────────────────────────┐
│  1. INGEST                                              │
│  scripts → tokenize → lemmatize → annotate              │
├─────────────────────────────────────────────────────────┤
│  2. DERIVE STAIRCASE                                    │
│  frequency × depictability → constraint solver →        │
│  chapter deltas → coverage projection                   │
├─────────────────────────────────────────────────────────┤
│  3. GENERATE CHAPTER SPECS                              │
│  scene-first design → staircase swaps → write           │
│  sentences → validate → iterate                         │
├─────────────────────────────────────────────────────────┤
│  4. RENDER                                              │
│  generate images → generate audio → build reader        │
├─────────────────────────────────────────────────────────┤
│  5. VALIDATE                                            │
│  coverage checker → comprehension probes →              │
│  gap analysis → adjust staircase                        │
├─────────────────────────────────────────────────────────┤
│  6. ITERATE                                             │
│  expand episode set → collect learner data →            │
│  refine → generalize pipeline                           │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Status (February 2026)

### Phase 1: Corpus Ingestion — COMPLETE

- 10 episodes (ep01–ep10) tokenized with MeCab + UniDic (frozen version)
- 1,529 lemmas in `pipeline_output/lemma_registry.json`
- 168+ UniDic→learner lemma mappings in `UNIDIC_TO_LEARNER`
- Particle frame extraction via Stanza hybrid architecture
- Depictability scores assigned for top-frequency lemmas
- 4,759 anime frames extracted to `reference_images/frames/`

### Phase 2: Staircase Derivation — COMPLETE

- 45 chapters across 20 grammar steps (GS0–GS19)
- 366 total new lemmas introduced, ≤8 per chapter
- Learner clusters, grammar freebies, and dependency filters all implemented
- Staircase output: `pipeline_output/staircase.json`
- Coverage projection computed against target episodes

### Phase 3: Chapter Spec Generation — COMPLETE

All 45 chapters written and validated. Key artifacts:

- **`generate_chapter_specs.py`** — master file containing all 45 chapters, ~1,019 sentences with image prompts. Runs MeCab validation on every sentence.
- **`pipeline_output/chapters/`** — per-chapter JSON specs exported by the generator
- **`pipeline_output/chapters/manifest.json`** — chapter index

#### Phase 3 polish passes (pre-rendering quality gates):

Two systematic audits were performed on all 45 chapters / ~1,019 sentences before any image or audio generation. These passes are essential for any LLPSI-style project — generated text that satisfies constraint validation can still sound robotic or produce unrenderable image prompts.

**Audit 1: Pedagogy vs. Naturalness** — The constraint solver produces grammatically valid sentences that hit recycling minimums, but the resulting text often sounds mechanical — every subject stated, every particle present, no conversational warmth. This audit reviewed all ~1,019 sentences and made targeted naturalness improvements:

- Added ね particles to ~200 sentences across all 45 chapters. ね signals shared understanding and transforms flat declaratives ("いい船だ") into natural conversation ("いい船だね"). Only recycled/known material was touched — sentences introducing new grammar were left explicit to avoid masking the teaching point.
- Applied light pro-drop where context made subjects recoverable, especially in later chapters where this pattern is natural in the target anime.
- Adjusted interjection placement and sentence-final particle combinations to better match character voice profiles.

**Key insight**: Naturalness passes should happen *after* validation passes, not during initial writing. Attempting to write natural text while satisfying all constraints simultaneously leads to constraint violations that require full rewrites. Write correct text first, then humanize.

**Audit 2: Image Prompt Renderability** — AI image generators (Gemini Pro) have systematic failure modes that text-only review misses. This audit systematically reviewed all ~1,019 prompts against six anti-pattern criteria derived from early test generations:

- R1 (characters facing away): ~10 rewrites. Prompts describing departing characters ("walks away", "retreating figure") consistently produce backs-of-heads with no recognizable features. Fix: departing characters now face the viewer or look over their shoulder.
- R3 (extreme darkness): ~12 rewrites. Night/cave/storm scenes with no specified light source produce near-black images. Fix: all dark scenes now have explicit light sources (lanterns, moonlight, firelight, colored light).
- R4 (dynamic mid-action): ~3 rewrites. Action-peak moments ("diving into water", "running at full speed") produce motion blur or anatomically impossible poses. Fix: describe the moment just before or just after the peak action.
- R5 (non-standard camera angles): ~25 rewrites. "Low angle", "top-down", "upward angle" prompts produce disorienting compositions or break character recognition. Fix: all changed to eye-level.
- R1+R3 combos: ~2 rewrites. Back-facing characters in darkness are doubly unrecognizable.
- Total: ~52 prompts rewritten. Zero "low angle", "walks away", "silhouette moves", or "retreating" patterns remain in the final corpus.

**Key insight**: These anti-patterns are model-specific but the audit methodology generalizes. Before committing to a 1,000+ image generation run, generate a test batch of 20–30 images spanning different scene types, catalog the failure modes, then audit all prompts against those patterns. The cost of 52 prompt rewrites is negligible compared to regenerating hundreds of bad images.

3. **Prompt length audit** — All 1,019 prompts verified within tolerance. Min 26 words, max 60 words, median 38 words. 80% fall within the 35–55 word design target. Only 8 prompts (0.8%) exceed 55 words, all by ≤5 words.

4. **Reference image mapping audit** — Found and fixed critical gaps in `KEYWORD_TO_REFS` (both `generate_gemini.py` and `batch_gemini.py`):
   - Added "papa" → moominpappa, "mama" → moominmamma (covered 236 previously unmapped prompts)
   - Added "snorkmaiden" (no space) → snork_maiden (38 prompts using one-word spelling)
   - Added "florenne" → snork_maiden (6 prompts)
   - Added "alicia" → alicia (8 prompts, new reference folder)
   - Wired up existing but unmapped reference folders: boat, beach_ocean, forest, interior_kitchen, campfire, moomin_house, valley_wide

### Phase 4: Rendering and Web Reader — IN PROGRESS

#### Complete:
- **Web reader** — `reader/index.html` + `app.js` + `style.css`. Sentence-by-sentence display with paired illustrations, furigana toggle (AUTO/ON/OFF), chapter navigation, audio play buttons.
- **Furigana system** — Three-mode toggle with deterministic exposure tracking. AUTO mode computes prior exposures from all earlier chapters (not browsing order). Okurigana splitting ensures furigana sits above kanji stems only, not trailing kana.
- **Image generation pipeline** — `generate_gemini.py` (interactive, per-chapter) and `batch_gemini.py` (batch API, all chapters). Both support reference images, resume mode, configurable aspect ratio (3:2), and regeneration from review manifests.
- **Review app** — `review_app.py` for keep/regenerate tagging of generated images, with notes and custom pinned reference images.
- **Reference images** — 25 curated folders covering all named characters + environments + props.
- **Scene schemas** — 30 scene definitions in `SCENES` dict providing location, character, and prop context per chapter.
- **Speaker assignment** — `generate_speakers.py` assigns a character speaker to each of 1,019 sentences via layered heuristics (explicit quotation, imagePrompt extraction, pronoun signals, protagonist fallback). All assignments manually reviewed and 128 corrections applied. Speaker field patched into all 45 chapter spec JSONs.
- **Audio generation pipeline** — `generate_audio.py` calls local Voicevox TTS engine with character-appropriate voices. Two-step API (audio_query → synthesis), WAV→OGG conversion via FFmpeg. Strips pedagogical spaces and extracts quoted dialogue for natural TTS input.

#### In progress:
- **Image generation** — Chapters 1–3 generated (58 images), reviewed via review_app, 8 flagged for regeneration. Remaining chapters 4–45 pending.
- **Audio generation** — Pipeline complete and tested. Chapters 1–2 generated (26 .ogg files). Remaining chapters pending (requires Voicevox running locally).

#### Not yet started:
- **Exercises** — picture-sentence matching, cloze, morpheme reorder (§3.7). Not yet implemented.
- **Marginalia** — margin glosses for morphological/semantic relationships (§3.6). Not yet implemented.
- **Tap-to-highlight** — interactive word-to-illustration referent mapping (§3.6). Not yet implemented.
- **Anki deck export** — supplementary SRS (§4.3). Not yet implemented.

### Phase 5: Validation and Coverage Gating — NOT STARTED

### Phase 6: Scale and Iterate — NOT STARTED

### Recommended next step

Complete image generation for remaining chapters (4–45) via batch_gemini.py, review each batch via review_app.py, regenerate flagged images, then run full audio generation.
