# Dola AI 30s Video Maker (Chrome extension)

Type **one prompt**, click **Generate & download**, and the extension:

1. Opens your [Dola](https://www.dola.com/chat/) chat (or reuses the one you have open).
2. Writes Seedance prompts for you and sends them to Dola. By default that is **3 × 10-second parts** that together make one 30-second story with the same characters, location and style.
3. Waits for each video to finish generating.
4. **Downloads every part automatically** to `Downloads/DolaAI/`.
5. **Stitches the parts into one 30-second video** (`…_FULL.mp4`, or `.webm` on older Chrome versions), ready to upload to YouTube Shorts.

It also has a **Watch mode** that auto-downloads *every* new video that shows up in Dola, including ones you generate by hand.

## Install (takes 1 minute)

1. Download this repository: **Code → Download ZIP**, then unzip it. You can also use `git clone`.
2. Open `chrome://extensions` in Google Chrome.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and pick the unzipped folder (the one that contains `manifest.json`).
5. Pin the extension (puzzle-piece icon → pin **Dola 30s Video**).
6. Log in at https://www.dola.com/chat/ in the same Chrome profile.

## Use

1. Click the extension icon.
2. Write your prompt, for example:
   ```
   A tiny robot chef cooks ramen in a neon Tokyo alley at night
   1. The robot flips noodles high into the air, steam everywhere
   2. Close-up of the robot adding a perfect soft-boiled egg
   3. A cat customer takes a bite and its eyes light up, camera pulls back to the neon street
   ```
   The numbered lines are optional. If you use them, each numbered line becomes one 10s part. If you don't, the extension splits your prompt into an opening, a middle and an ending.
3. Choose the aspect ratio: **9:16** for Shorts, **16:9** for normal YouTube videos.
4. (Optional) Click **Preview prompts** to see exactly what will be sent to Dola.
5. Click **Generate & download**. Keep the Dola tab open. Progress shows in the popup, and you get a desktop notification when the video is ready.
6. When stitching starts, a tab opens. Keep it open and visible for about 30 seconds while it records the full video.

### Modes

| Mode | What it does |
|---|---|
| **30s = chained clips** (default) | Sends N prompts (total length ÷ seconds per clip), then downloads and stitches them. Use this mode because Seedance makes short clips (about 5–15s) per generation. |
| **One request for full length** | Sends a single prompt asking for the full length. Try it if your Dola plan or skill can make 30s in one go. |

### Settings (bottom of the popup)

- **Skill / model instruction**: the text that starts every prompt (default `Use Seedance 2.5 to`). If you set up a Seedance skill at https://www.dola.com/chat/skills?view=manage&tab=skill, put the way you call that skill here, e.g. `@Seedance`.
- **Prompt templates**: full control over the text sent. Placeholders: `{skill} {prompt} {seconds} {totalSeconds} {ratio} {resolution} {style} {part} {total} {beat}`.
- **Download folder / file name prefix**: files are saved as `Downloads/<folder>/<prefix>_<date>_<prompt>_part1of3.mp4`.
- **Timeout per clip**: how long to wait for each video (default 12 min).
- **Prompt box / Send button CSS selector**: only needed if Dola changes its page and auto-detect stops working (see Troubleshooting).

## How it works

| File | Role |
|---|---|
| `src/content.js` | Runs on dola.com. Finds the chat box, types and sends each prompt, then watches for the new `<video>` / `.mp4` link and hands it off for download. |
| `src/page-hook.js` | Runs in the page and watches Dola's network responses (fetch / XHR / streaming) for video URLs, so the finished video is found even before it shows on screen. |
| `src/background.js` | Starts jobs, finds or opens the Dola tab, saves files with `chrome.downloads`, and sends notifications. |
| `src/merge.html/js` | Plays the parts back to back into a canvas + audio mix and records one continuous video with `MediaRecorder`. Everything stays in your browser, so nothing is uploaded anywhere. |
| `src/shared.js` | Settings defaults and the prompt builder that turns one prompt into per-clip prompts. |

## Troubleshooting

- **"Could not find the Dola chat box"**: open a chat page on dola.com first. If it still fails, right-click the chat box → **Inspect**, copy a selector for it (e.g. `textarea`), and paste it into **Prompt box CSS selector**.
- **Prompt is typed but not sent**: do the same for the send button → **Send button CSS selector**.
- **Timed out waiting for the video**: Dola may have asked a question instead of generating. Answer it in the chat, or make the skill prefix more explicit. You can also raise **Timeout per clip**.
- **A preview or placeholder video got downloaded**: raise **Ignore videos shorter than (s)**.
- **Downloads have a watermark**: the extension saves the file Dola serves. Watermark rules depend on your Dola plan.
- The Dola tab can stay in the background, but don't close or reload it while a job is running.

## Notes

- Use this for your own content, and follow Dola's Terms of Service and usage limits. Every part uses one generation from your Dola account.
- The `https://*/*` host permission is only used to download the finished video files from Dola's video CDN so they can be stitched locally.
