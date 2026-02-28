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
- **Chapters 1–45**: All 45 chapters generated and validated (~1,019 sentences). Covers grammar steps 0–19 (labeling through nominalizers). Two pre-rendering audits performed: naturalness (added ね particles to ~200 sentences) and image prompt renderability (~52 prompts rewritten for Gemini Pro compatibility).
- **Reader**: Functional at `reader/index.html`. Sentence-by-sentence display with paired illustrations, furigana toggle (AUTO/ON/OFF with deterministic exposure tracking), and per-sentence audio play buttons.
- **Images**: Chapters 1–3 generated via Gemini Batch API (58 images), reviewed, 8 flagged for regeneration. Remaining chapters 4–45 in progress.
- **Audio**: Voicevox TTS pipeline complete. Speaker assigned to all 1,019 sentences (manually reviewed, 128 corrections applied). 15 character voices mapped. Chapters 1–2 generated (26 .ogg files).

## Repository structure

```
├── moomin-llpsi-design-plan.md    # Design methodology (reusable template)
├── voicevox_speakers.json         # Character → Voicevox voice ID mapping
├── image_review.json              # Image review state (keep/regenerate tags)
├── regeneration_manifest.json     # Exported redo list for batch_gemini.py
├── pipeline_output/
│   ├── staircase.json             # 45-chapter vocabulary/grammar plan
│   ├── speaker_map.json           # 1,019 sentence → speaker assignments
│   ├── chapters/
│   │   ├── manifest.json          # Available chapter listing
│   │   └── ch01_spec.json … ch45  # Chapter specs (all 45 complete)
│   ├── images_gemini/             # Generated illustrations (ch01–03 so far)
│   └── audio/                     # Generated TTS audio (.ogg per sentence)
├── reader/
│   ├── index.html                 # Web reader
│   ├── app.js                     # Chapter loader, furigana, audio, navigation
│   └── style.css                  # Reader styles
├── reference_images/              # Curated reference images for generation
└── review_refs/                   # Custom pinned refs from image review
```

Python pipeline scripts (gitignored): `build_staircase.py`, `generate_chapter_specs.py`, `validate_chapter.py`, `tokenize_corpus.py`, `generate_gemini.py`, `batch_gemini.py`, `generate_speakers.py`, `generate_audio.py`, `review_app.py`.

## Toolchain

- Python 3.14
- [fugashi](https://github.com/polm/fugashi) + UniDic (full, frozen 2026-02-22) for tokenization
- [Stanza](https://stanfordnlp.github.io/stanza/) for dependency parsing
- MeCab for tokenization and validation
- [Voicevox](https://voicevox.hiroshiba.jp/) for TTS audio generation (local engine on port 50021)
- FFmpeg for audio format conversion (WAV → OGG)
- Google Gemini Pro API for image generation

```bash
# Serve reader locally
python -m http.server 8000
# Open http://localhost:8000/reader/

# Generate images (batch API — cheaper, faster)
python batch_gemini.py submit --chapters 4 5 6 7 8
python batch_gemini.py status
python batch_gemini.py download

# Regenerate flagged images
python batch_gemini.py submit --regenerate regeneration_manifest.json
python batch_gemini.py download

# Review images
python review_app.py

# Generate audio (requires Voicevox running)
python generate_audio.py --chapters 1        # test single chapter
python generate_audio.py                     # all chapters
python generate_audio.py --resume            # skip existing files
python generate_audio.py --dry-run           # preview without generating
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
