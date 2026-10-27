# VO Prompter

A tablet web app for reading a voice-over script. It follows your voice word by word, shows what you've read and what's next, marks skipped words, and plays the reference video paced to your read.

Open it at **https://hyporeal.github.io/VO-Prompter/** in Chrome on the tablet, then use **Add to Home screen** (or **Install app**) so it opens full screen and works offline.

## Modes

- **Read**: tap **Start** and read. Words you've read are highlighted, and a guide shows what's next. The line you're on stays near the top with the previous line above it. Tap any word to move there; the video jumps with you.
- **Listen**: tap a sentence (or paragraph, in Settings) to hear it read aloud. Tap it again to stop. The video follows the voice.
- **Edit**: tap a paragraph to change it. Edited paragraphs get a small dot. **Files → Export** saves the edited script as .docx or .txt. The original file isn't changed.

## Video

- **Files → Add video** stores the video on the tablet with the script.
- **Follow** (on by default): the video tracks your reading position. Its speed eases up and down to stay with you, and it pauses when you pause. The small ×2.4 label shows how fast it's running.
- **Play**, **−5s**, **+5s**: play or move the video yourself. This turns Follow off; tap **Follow** to go back to your reading spot.
- **Sound on** turns the mic off so you can listen to the reference. **Sound off** turns the mic back on if it was on.
- While Follow is off, a bar in the left margin shows which paragraph the video is at.
- **Portrait**: drag the bar above the video to move it up or down. The script area shrinks to fit above it, so text is never behind or under the video.
- **Landscape**: the video sits on the right; drag the bar to change its width.
- Double-tap the bar to reset.

## Script format

- `[anything in brackets]` is shown dimmed and not read, e.g. `[SLIDE: Agenda]`.
- A time at the start of a line, like `00:01:30` or `1:30`, is the video time for the words that follow. Times between two timestamps are spread across the words by syllables. Text before the first timestamp holds on that frame. Tap a timestamp to jump the video there.
- Headings (Word heading styles or `# Heading`), `// notes`, lines starting `[SKIP]`, and everything after `[END]` aren't read.
- All-caps lines with a number or SESSION/PART/TAKE/PICKUP/BREAK (e.g. `START SESSION 3`) are markers and aren't read.
- Strikethrough and hidden text in Word are dropped.
- Numbers are matched as spoken (`1.0` = "one point zero" or "one point oh"). Acronyms and numbers are never marked as skipped.

Without timestamps, the video is spread evenly across the whole script.

## Settings

- **Text size**: 10 to 56 px.
- **Guide style**: underline or fill the letters.
- **Guide covers**: off, next word, next phrase, whole line (the line on screen), whole sentence, or whole paragraph. While you read, the guide runs slightly ahead of the last recognized word to make up for the recognizer's delay.

## Speech engines

- **On tablet** (default): [Vosk](https://alphacephei.com/vosk/) running in the browser. Your voice never leaves the tablet. The first start downloads a 41 MB model once; after that it works offline.
- **Android speech (Google)**: Chrome's speech recognition, which is Google's. More accurate, but it sends audio to Google and usually needs internet.

The **Tablet mic** setting keeps Bluetooth earbuds out of phone-call mode.

The mic pauses while Settings or Files is open, when the app loses focus, or when the screen goes off, and turns back on when you return if it was on.

## Listen-mode voices

- **Android voice**: the tablet's text-to-speech. Chrome on Android lists languages rather than voices; the voice used is the one picked in Android Settings (search "Text-to-speech", choose Speech Services by Google, then Install voice data → English (United States)).
- **Natural voices**: [Piper](https://github.com/rhasspy/piper) neural voices running on the tablet. Each downloads once (about 60 MB) from the Piper voice library, then works offline. Each sentence takes a moment to prepare.

## Mistake marks

- **Skipped words** get a red wavy underline.
- **Possible misreads** (optional) get a dotted underline. These are often the recognizer mishearing, not you.
- If you go off script, an **Off script** tag shows until you're back on a line from the script. It finds you again if you jump back or ahead.
- **Files → Clear read marks** resets everything.

## Keyboard / page-turner

Space starts and stops listening. Up and down arrows (or Page Up/Down) move by sentence. Escape stops Listen mode.

## Privacy

Scripts, edits and videos are stored only in the tablet's browser storage. This repository holds generic code only; no scripts or client material.

## Uninstall

**Settings → Remove app data** deletes every script, video, setting, the speech model and downloaded voices from the tablet. Then long-press the VO Prompter icon and choose **Uninstall** (or **App info → Uninstall**).

## Credits

- [vosk-browser](https://github.com/ccoreilly/vosk-browser) 0.0.8 (Apache-2.0) in `vendor/`
- Vosk model `vosk-model-small-en-us-0.15` by Alpha Cephei (Apache-2.0) in `models/`
- [onnxruntime-web](https://github.com/microsoft/onnxruntime) 1.18.0 (MIT) in `vendor/ort/`
- piper_phonemize WebAssembly build of [piper-phonemize](https://github.com/rhasspy/piper-phonemize) (MIT) and [espeak-ng](https://github.com/espeak-ng/espeak-ng) (GPL-3.0) in `vendor/piper/`
- Piper voices are downloaded on demand from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices); each voice's license is in its model card
- Atkinson Hyperlegible and JetBrains Mono fonts (SIL Open Font License) in `fonts/`
