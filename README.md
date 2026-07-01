# Context Video Translator

**Context Video Translator** is a Chrome/Edge MV3 extension for contextual bilingual subtitles on video platforms. It captures official caption tracks, translates upcoming subtitle cues with surrounding context, and renders a stable custom overlay designed for watching, learning, and reviewing video content.

It currently supports **YouTube** and **Udemy**, with **Netflix support coming soon**.

## Why this is different

Most subtitle translators treat every subtitle line as an isolated sentence. That often breaks pronouns, technical terms, speaker intent, and continuity across a scene.

Context Video Translator translates subtitle batches with neighboring cues, so the model can understand what came before and what comes next. This gives more natural, consistent translations for lectures, tutorials, anime, interviews, and long-form educational videos.

## Highlights

- **Context-aware subtitle translation** — translates with nearby subtitle cues instead of isolated lines.
- **Realtime bilingual overlay** — shows the original subtitle and translated subtitle directly over the video.
- **Ahead-of-time translation** — pre-translates upcoming cues to reduce waiting during playback.
- **OpenAI-compatible provider** — works with local or cloud endpoints exposing `/v1/chat/completions`.
- **YouTube support** — captures official YouTube timedtext captions, including segment timing when available.
- **Udemy support** — uses Udemy lecture captions API and official WebVTT subtitle files.
- **Karaoke progress** — lightweight progress highlight to follow where the speaker is in the current line.
- **Stable timing engine** — handles cue gaps, seek, pause, and platform-specific player quirks.
- **Manual layout editor** — move and resize subtitle regions directly on the video.
- **Dynamic compact height** — subtitle box grows only when needed and avoids wasting screen space.
- **Hard-sub mask** — optional overlay mask for covering burned-in subtitles.
- **Japanese Study Mode** — optional furigana, local Japanese analysis, component coloring, and hover metadata.
- **IndexedDB translation cache** — avoids retranslating the same cues repeatedly.

## Supported platforms

| Platform | Status | Notes |
|---|---:|---|
| YouTube | Supported | Captures `api/timedtext`, supports json3/XML captions, segment timing, native caption hiding. |
| Udemy | Supported | Uses official lecture API `asset.captions[].url`, signed WebVTT files, and a Udemy-specific stable render state. |
| Netflix | Coming soon | Planned as a separate platform adapter. |

## Feature overview

### YouTube

- MAIN-world fetch/XHR interception for `https://www.youtube.com/api/timedtext`.
- Parses YouTube `json3` and legacy XML timedtext.
- Preserves `segs[].tOffsetMs` when present for smoother karaoke timing.
- Optional hiding of native YouTube captions.
- Per-video and global layout presets.

### Udemy

- Detects `courseId` and `lectureId` on lecture pages.
- Calls Udemy's lecture API to extract `asset.captions[].url`.
- Fetches signed WebVTT caption files and parses cue timestamps.
- Falls back to network-captured VTT, `video.textTracks`, or `<track>` elements when needed.
- Uses a Udemy-specific render state machine to reduce flicker caused by player/HLS re-renders.

### Japanese Study Mode

Optional tools for Japanese-learning videos:

- Kuromoji-backed furigana engine.
- Smart okurigana split where safe.
- Furigana display modes: all Kanji, current speaking chunk only, or tooltip-only.
- Optional component boxes for nouns, verbs, particles, adjectives, auxiliaries, adverbs, and other tokens.
- Clean karaoke mode for normal watching, with component boxes available for pause-and-study.

## Keyboard shortcuts

On supported video pages:

```text
Alt+E        Toggle layout editor
Alt+H        Toggle hard-sub cover mask
Alt+S        Save current layout
Esc          Cancel/exit editor
Tab          Switch selected region in editor
Arrow keys   Move selected region
Shift+Arrow  Resize selected region
```

## Default provider

The current default OpenAI-compatible endpoint is:

```text
Base URL: http://localhost:20128/v1
Model: cx/gpt-5.4-mini
Target language: Vietnamese
```

You can change this in the extension Options page.

## Install for development

```bash
git clone https://github.com/ptd150101/context-video-translator.git
cd context-video-translator
npm install
npm run build
```

The build output is written to `dist/`.

## Load in Chrome or Edge

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Run `npm install && npm run build`.
4. Click **Load unpacked**.
5. Select the `dist/` folder.
6. Open the extension Options page and configure your provider if needed.

## Repository hygiene

This repository intentionally does **not** commit:

```text
node_modules/
dist/
.env
src/vendor/kuromoji/
```

Kuromoji runtime and dictionary files are copied from `node_modules/kuromoji` during `npm run build`.

## Project structure

```text
src/
  manifest.json        Chrome MV3 manifest source
  background.js        settings, translation, cache, provider calls
  youtube-main.js      MAIN-world YouTube timedtext interceptor
  udemy-main.js        MAIN-world Udemy network/page bridge
  youtube-content.js   shared platform logic, parsers, renderer, scheduler
  options.*            extension Options UI
scripts/
  build.mjs            copies src into dist and prepares runtime files
```

## Limitations

- Requires the video platform to expose captions or transcripts; it does not perform OCR or ASR.
- Translation quality and latency depend on the configured model/provider.
- Platform DOM/API changes may require adapter updates.
- Netflix support is planned but not implemented yet.

## Roadmap

- Netflix adapter.
- Better saved phrase / saved sentence workflow.
- Export study cards for language learning.
- More platform adapters for online courses and local subtitle files.
