# Moomin per se Illustrata

A Japanese graded reader that bootstraps learners to comprehend the 1990 *楽しいムーミン一家* anime — no textbook, no translation, no subtitles.

Modeled on [Lingua Latina per se Illustrata](https://en.wikipedia.org/wiki/Lingua_Latina_per_se_Illustrata) (LLPSI), which teaches Latin entirely through Latin. Every sentence is comprehensible input: known material plus exactly one new element, with illustration replacing translation.

## How it works

1. **Corpus ingestion** — 10 episodes tokenized and annotated via MeCab + UniDic (morphology) and Stanza (dependency parsing). 2,548 lines, 21,536 tokens, 1,529 unique lemmas.
2. **Staircase solver** — builds a 45-chapter vocabulary/grammar progression optimized for anime coverage. 8 new words per chapter, 20 grammar steps, ~90% running token coverage. Learner clusters keep semantically related words together (demonstratives, motion verbs, size adjectives).
3. **Chapter generation** — each chapter is a short illustrated story using only previously taught material plus its 8 new words. Every sentence is validated by MeCab tokenization against a strict morpheme whitelist.
4. **Web reader** — static HTML/JS reader that serves chapters with furigana support and a progressive reading experience.

## Current status

- **Staircase**: Complete (45 chapters, 366 lemmas, 20 grammar steps, ~90% avg coverage).
- **Chapters 1–20**: Generated and validated. Covers grammar steps 0–14 (labeling through giving/receiving). Includes は vs が progression, い-adjective introduction, て-form, ている, たい, and あげる/もらう/くれる.
- **Chapters 21–45**: Staircase complete, chapter specs not yet generated.
- **Reader**: Functional at `reader/index.html`. Chapters load dynamically from manifest, with togglable furigana (ON / AUTO / OFF).
- **Images**: Generated via Gemini Pro API with reference images for character consistency. Fixed resolution per batch for layout uniformity. Review and targeted regeneration of problematic images.
- **Audio**: Not yet generated.

## Repository structure

```
├── moomin-llpsi-design-plan.md    # Design methodology (reusable template)
├── build_staircase.py             # Staircase constraint solver
├── generate_chapter_specs.py      # Chapter spec generator (sentences, scenes)
├── validate_chapter.py            # MeCab-based constraint validator
├── tokenize_corpus.py             # Corpus tokenization pipeline
├── enhance_prompts.py             # Character trigger word injection for prompts
├── generate_gemini.py             # Gemini Pro API image generation (primary)
├── batch_gemini.py                # Gemini Batch API submission/download
├── generate_chapter_images.py     # Legacy local image generation (unused)
├── review_app.py                  # Local HTTP image review tool
├── extract_prop_refs.py           # CLIP prop/setting reference finder
├── ep01/ … ep10/                  # Episode data (lines, meta, vocab)
├── pipeline_output/
│   ├── staircase.json             # 45-chapter vocabulary/grammar plan
│   ├── lemma_registry.json        # 1,529 lemmas with frequency/speaker data
│   ├── learner_lemma_map.json     # UniDic → learner form mappings
│   └── chapters/
│       ├── manifest.json          # Available chapter listing
│       ├── ch01_spec.json         # Chapter specs (20 complete)
│       └── …
├── reader/
│   ├── index.html                 # Web reader
│   ├── app.js                     # Chapter loader, furigana, navigation
│   └── style.css                  # Reader styles
├── training_images/               # Curated character reference images
└── reference_images/              # Prop/setting reference images for generation
```

## Toolchain

- Python 3.14
- [fugashi](https://github.com/polm/fugashi) + UniDic (full, frozen 2026-02-22) for tokenization
- [Stanza](https://stanfordnlp.github.io/stanza/) for dependency parsing
- MeCab for tokenization and validation

```bash
# Generate staircase
PYTHONIOENCODING=utf-8 python build_staircase.py

# Generate chapter specs (writes JSON + manifest)
PYTHONIOENCODING=utf-8 python generate_chapter_specs.py

# Validate a single chapter
PYTHONIOENCODING=utf-8 python validate_chapter.py pipeline_output/chapters/ch01_spec.json

# Validate staircase constraints (clusters, grammar monotonicity)
PYTHONIOENCODING=utf-8 python validate_chapter.py --staircase pipeline_output/staircase.json

# Serve reader locally
python -m http.server 8000
# Open http://localhost:8000/reader/
```

## Grammar sequence

The 20-step grammar progression covers:

| Step | Name | Key unlocks |
|------|------|-------------|
| 0 | Foundation | Names and pointing |
| 1 | Existence | いる / ある, が |
| 2 | Topic + Copula | は / だ (plain form only, no です) |
| 3 | Past | た / だった |
| 4 | は vs が contrast | Explicit new-info vs. topic pairs |
| 5 | Motion | いく / くる, へ |
| 6 | Transitive action | を + みる / たべる / のむ |
| 7 | Sentence particles | ね / よ |
| 8 | Conjunctions | でも / だから |
| 9 | い-adjectives | Predicate and prenominal |
| 10 | Negation | ない / じゃない |
| 11 | て-form | Sequential and requests |
| 12 | ている | Ongoing state |
| 13 | Desire | たい |
| 14 | Giving/receiving | あげる / もらう / くれる |
| 15 | Quotation | という / とおもう |
| 16 | Conditional | たら |
| 17 | Relative clauses | Prenominal verb + noun |
| 18 | Polite forms | ます / です (register contrast) |
| 19 | Nominalizers | の / こと |

Register zoning: plain form backbone (だ/た) for the first ~25 chapters. ます/です introduced at step 18 as a character contrast, not a grammar topic.

## Design document

See `moomin-llpsi-design-plan.md` for the full methodology — grammar sequencing, constraint system, learner clusters, scene-first chapter design, and validation rules. Written as a reusable template for targeting other media or languages.

## Why Moomin?

The 1990 anime has clear diction, limited cast, recurring locations, and a gentle narrative pace — ideal properties for a graded reader corpus. Characters have distinct speech registers (plain vs. polite, masculine vs. feminine), providing natural grammar contrasts. The show is beloved enough that learners have intrinsic motivation to understand it.
