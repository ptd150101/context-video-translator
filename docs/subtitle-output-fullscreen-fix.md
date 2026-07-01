# Subtitle output + fullscreen fix

Implemented in the local source ZIP for this release.

## Runtime changes

- Removed the separate hard-sub cover layer from runtime behavior.
- Subtitle output now owns the black background directly.
- Added configurable subtitle background opacity.
- Added normal-mode drag for subtitle output.
- Kept editor mode for resizing and keyboard nudging.
- Added fullscreen remount manager for YouTube and Udemy.
- Added Udemy MAIN-world fullscreen redirect: if Udemy requests fullscreen on the video element, the extension redirects it to a visible player wrapper when possible so the overlay can remain visible.
- Preserved atomic bilingual rendering: a source cue is not rendered alone while translation is still pending.

## Important behavior

The renderer treats subtitle output as one atomic bilingual block. When the next cue is available but its translation is not ready, the last bilingual cue is held briefly instead of showing only the source subtitle.

## Files changed in source ZIP

- `src/youtube-content.js`
- `src/udemy-main.js`
- `src/background.js`
- `src/options.html`
- `src/options.js`
- `README.md`

`node_modules/`, `dist/`, and `src/vendor/kuromoji/` are not committed.
