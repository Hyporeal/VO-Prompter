# VO Prompter

A tablet web app for reading a voice-over script. It follows your voice word by word, shows what you've read and what's next, marks skipped words, and plays the reference video paced to your read.

Open it at **https://hyporeal.github.io/VO-Prompter/** in Chrome on the tablet, then use **Add to Home screen** (or **Install app**) so it opens full screen and works offline.

## Modes

- **Read**: tap **Start** and read. Words you've read are highlighted, and the next word (or phrase) is underlined or filled. The line you're on stays near the top with the previous line above it. Tap any word to move there; the video jumps with you.
- **Listen**: tap a sentence (or paragraph, in Settings) to hear it read aloud by the tablet's voice. Tap it again to stop. The video follows the voice.
- **Edit**: tap a paragraph to change it. Edited paragraphs get a small dot. **Files → Export** saves the edited script as .docx or .txt. The original file isn't changed.

## Video

- **Files → Add video** stores the video on the tablet with the script.
- **Follow** (on by default): the video tracks your reading position. Its speed eases up and down to stay with you, and it pauses when you pause. The small ×2.4 label shows how fast it's running.
- **Play**, **−5s**, **+5s**: play or move the video yourself. This turns Follow off; tap **Follow** to go back to your reading spot.
- **Sound on** turns the mic off so you can listen to the reference. **Sound off** turns the mic back on if it was on.
- While Follow is off, a bar in the left margin shows which paragraph the video is at.
- Drag the bar above the video to resize it.

## Script format

- `[anything in brackets]` is shown dimmed and not read, e.g. `[SLIDE: Agenda]`.
- A time at the start of a line, like `00:01:30` or `1:30`, is the video time for the words that follow. Times between two timestamps are spread across the words by syllables. Text before the first timestamp holds on that frame. Tap a timestamp to jump the video there.
- Headings (Word heading styles or `# Heading`), `// notes`, lines starting `[SKIP]`, and everything after `[END]` aren't read.
- All-caps lines with a number or SESSION/PART/TAKE/PICKUP/BREAK (e.g. `START SESSION 3`) are markers and aren't read.
- Strikethrough and hidden text in Word are dropped.
- Numbers are matched as spoken (`1.0` = "one point zero" or "one point oh"). Acronyms and numbers are never marked as skipped.

Without timestamps, the video is spread evenly across the whole script.

## Speech engines (Settings)

- **On tablet** (default): [Vosk](https://alphacephei.com/vosk/) running in the browser. Your voice never leaves the tablet. The first start downloads a 41 MB model once; after that it works offline.
- **Google**: Chrome's built-in recognition. Sends audio to Google and needs internet.

The **Tablet mic** setting keeps Bluetooth earbuds out of phone-call mode.

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

**Settings → Remove app data** deletes every script, video, setting and the speech model from the tablet. Then long-press the VO Prompter icon and choose **Uninstall** (or **App info → Uninstall**).

## Credits

- [vosk-browser](https://github.com/ccoreilly/vosk-browser) 0.0.8 (Apache-2.0) in `vendor/`
- Vosk model `vosk-model-small-en-us-0.15` by Alpha Cephei (Apache-2.0) in `models/`
- Atkinson Hyperlegible and JetBrains Mono fonts (SIL Open Font License) in `fonts/`
