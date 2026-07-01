# Context Video Translator

A Chrome/Edge MV3 extension for contextual bilingual subtitles on video-learning platforms. It captures official caption tracks, translates upcoming subtitle cues through an OpenAI-compatible API, and renders a stable custom overlay with timing, layout, and study tools.

## Highlights

- **Context-aware subtitle translation**: translates subtitle batches with neighboring cues so the output is more consistent across a scene or explanation, not just isolated line-by-line translation.
- **Realtime bilingual overlay**: original subtitle + translated subtitle rendered directly over the video.
- **Ahead-of-time translation**: translates upcoming cues before they appear to reduce waiting during playback.
- **OpenAI-compatible provider**: works with local or cloud endpoints that expose `/v1/chat/completions`.
- **Smart timing**: uses detailed YouTube segment timing when available, falls back to cue-level timing elsewhere.
- **Karaoke progress**: lightweight left-to-right progress effect for tracking the current spoken line.
- **Manual layout editor**: move and resize the subtitle overlay and hard-sub cover region directly on the video.
- **Dynamic compact height**: subtitle box grows only as much as needed, avoiding clipping while saving screen space.
- **Hard-sub mask**: optional region mask to cover burned-in subtitles before rendering your own overlay.
- **Japanese study mode**: optional furigana, local Japanese analysis, component coloring, and hover information.
- **Translation cache**: IndexedDB cache to avoid retranslating the same cues repeatedly.

## Supported platforms

| Platform | Status | Notes |
|---|---:|---|
| YouTube | Supported | Captures `api/timedtext`, supports json3/XML captions, segment timing, native caption hiding. |
| Udemy | Supported | Uses the official lecture captions API, `asset.captions[].url`, WebVTT parsing, and a Udemy-specific stable render state. |
| Netflix | Coming soon | Planned as a separate platform adapter. |

## Key features by platform

### YouTube

- MAIN-world fetch/XHR interception for `https://www.youtube.com/api/timedtext`.
- Parses YouTube json3 and legacy XML timedtext.
- Preserves `segs[].tOffsetMs` when present for smoother karaoke timing.
- Optional hiding of native YouTube captions.
- Per-video and global layout presets.

### Udemy

- Detects `courseId` and `lectureId` on lecture pages.
- Calls Udemy's lecture API to extract `asset.captions[].url`.
- Fetches signed WebVTT caption files and parses timestamps.
- Falls back to network-captured VTT, `video.textTracks`, or `<track>` elements when needed.
- Uses a Udemy-specific render state machine to avoid flicker caused by player/HLS re-renders.

## Japanese Study Mode

Optional tools for Japanese-learning videos:

- Kuromoji-backed furigana engine with lightweight fallback.
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

## Build

```bash
npm install
npm run build
```

The build output is written to `dist/`.

## Load in Chrome or Edge

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Run `npm run build` if `dist/` does not exist.
4. Click **Load unpacked**.
5. Select the `dist/` folder.
6. Open the extension Options page and configure your provider if needed.

## Repository hygiene

This repository intentionally does **not** commit:

```text
node_modules/
dist/
.env
```

Use `npm install` and `npm run build` locally to regenerate dependencies and build output.

## Project structure

```text
src/
  manifest.json        Chrome MV3 manifest source
  background.js        settings, translation, cache, provider calls
  youtube-main.js      MAIN-world YouTube timedtext interceptor
  udemy-main.js        MAIN-world Udemy network/page bridge
  youtube-content.js   shared platform logic, parsers, renderer, scheduler
  options.*            extension Options UI
  vendor/kuromoji/     browser Kuromoji runtime + dictionary used by Study Mode
scripts/
  build.mjs            copies src into dist and prepares runtime files
```

## Limitations

- Requires the video platform to expose captions or transcripts; it does not perform OCR or ASR.
- Translation quality and latency depend on the configured model/provider.
- Platform DOM/API changes may require adapter updates.
- Netflix support is planned but not implemented yet.
