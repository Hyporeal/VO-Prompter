# VO Prompter: notes for Claude

A static web app (GitHub Pages) that follows a voice actor's read through a script: on-device speech recognition
(Vosk), a guide over the words being read, scrolling, video paced to the read, text-to-speech Listen mode, projects,
contents, highlights and bookmarks. No build step: plain ES modules in js/, styles in index.html.

## Rules (from the owner)
- Never put client material in the repo: no scripts, script text, audio, video, recordings or client names, not even
  in comments, tests or commit messages. Test with made-up text. Keep real files outside the repo.
- Before every push, check that no script text slipped in (search the diff for phrases from any real script used).
- The debug log and diagnostics must never contain script words, file names or account details.
- Keep the uninstaller working (Settings → Remove app data wipes IndexedDB, caches and localStorage).
- Versions: small patch bumps, format X.X.XX (VERSION in js/app.js). End commit messages with the usual attribution.
- Experimental changes go to the beta first (beta/, built with tools/make_beta.py from a dev checkout). The main app
  changes only when the owner says so.
- Don't change the IndexedDB version (main and beta share the database). Add data inside project records.
- Before changing code, say what you'll change, why, and the expected effect, then wait for the owner's OK. Small
  fixes inside an approved plan don't need asking again. After each change, report what changed and the before/after
  measurement. Show the diff when asked.
- Replies to the owner: direct, concise, bulleted; em-dashes without spaces, sparingly; no placating language.

## Layout
- js/app.js: UI, painting, scrolling, projects, contents, settings. The page draws only paragraphs near the screen
  (placeholders elsewhere); use tokEl(t) to get a word's element.
- js/follow.js: the follower (alignment of recognized words to the script, pickups and retakes, pace in syllables/s).
- js/parse.js: file readers (docx, PDF via vendor/pdfjs, EPUB, ODT, RTF, HTML, SRT/VTT, FDX, Fountain, text) and the
  script model (tokens, units, sentences, timestamps).
- js/engines.js (speech engines), js/tts.js and js/piper.js (voices), js/vo.js (your own voice-over), js/store.js.
- sw.js: network-first service worker. beta/: generated, don't edit by hand.

## Known next steps
- Phone layout polish and Android-standard UI.
- Highlighting can lag for fast readers.
- Possible APK (Capacitor) later; Zoom-style videos with 30 s keyframes freeze when jumping in Chrome-based browsers
  on Pixel phones.
- Test on real devices (adb / Chrome remote debugging) rather than throttled desktop runs where possible.
