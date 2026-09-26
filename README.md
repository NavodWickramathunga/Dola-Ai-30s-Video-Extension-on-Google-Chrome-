# Dola AI 30s Video Maker (Chrome extension)

Paste your prompt into [Dola AI](https://www.dola.com/chat/) the way you normally do. With this extension you end up with **one 30-second video file** in `Downloads/DolaAI/`.

**Why it joins clips:** Seedance 2.5 on Dola makes at most **15 seconds per clip**. That limit is on Dola's servers and no browser extension can change it. So the extension:

1. **Asks Dola for 30 seconds.** When you press send, it adds an instruction to the end of your message, as visible text just like you typed it: 30 seconds in total, made as consecutive 15-second clips where each clip starts on the last frame of the one before, generated straight away without asking you to confirm the plan. Short replies such as "confirm A" are left unchanged.
2. **Collects the clips** as Dola finishes them.
3. **Joins them into one 30-second MP4** once they add up to 30 seconds. A tab opens for about 30 seconds while the clips are joined, then closes by itself.
4. If Dola ever makes a full 30-second clip on its own, that single file is saved as it is.

## Install

1. Download this repository: **Code → Download ZIP**, then unzip it.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode** (top-right).
3. Click **Load unpacked** and pick the unzipped folder (the one that contains `manifest.json`).
4. Pin the extension (puzzle-piece icon → pin **Dola 30s Video**).
5. **Reload any dola.com tab you already have open**, so the extension can start working in it.

## Use

1. Open https://www.dola.com/chat/ and paste your full prompt.
2. Press **Enter** or click Dola's send button.
3. Wait for Dola to finish all clips. A "Joining your clips" tab opens for about 30 seconds, then your video is saved as `Downloads/DolaAI/dola_<date>_30s_joined.mp4` and you get a notification.

The extension popup shows:
- **Status**: whether it is active on the Dola tab and whether it is waiting for your video.
- A **✓ Set to 30s** line with what was changed in the last prompt you sent, e.g. `duration: 10 → 30` and `added 30s instruction`.
- **Downloaded videos**, with each video's real length. If a video is shorter than 30s, it's marked in orange. That means Dola/Seedance capped the length.
- **Clips received**: how many clips have arrived and how many seconds they add up to.
- **Join clips now**: joins whatever has arrived so far, if you don't want to wait. On its own, the extension joins as soon as the clips reach 30 seconds, or 5 minutes after the last clip arrived.
- **Download latest video now**: saves the newest video on the page if the automatic download missed it.

### Settings

| Setting | Default |
|---|---|
| Final video length | 30 seconds |
| Add the "single 30s Seedance 2.5 video" instruction to my prompt (the wording can be edited) | on |
| Auto-download the finished video | on |
| Join Dola's clips into one video | on |
| Also save the separate clips | off |
| Download folder / file name prefix | `DolaAI` / `dola` |
| Keep watching for (min): how long after you send to wait for the video | 20 |
| Ignore videos shorter than (s): skips small loading or preview animations | 2 |

## 🛡️ Safe mode (lower risk for your Dola account)

Version 3 works **only through normal, visible actions**:

- It **never changes Dola's own code or network requests**, never hides errors or logouts, and never changes limits or settings behind the scenes.
- It never sends prompts for you. You still press send yourself.
- It uses a single account only: no cookies, no account switching, and no attempts to get around daily limits or safety filters.
- What it does: adds visible text to your message, watches the page for finished videos, downloads them, and joins them on your own computer.

No tool can promise that Dola will never restrict an account, because that is Dola's decision under its terms. But this is the same as what you could do by hand, which keeps the risk as low as possible.

## Good to know

- Because Dola generates the clips separately, there can be a small visible change where clip 1 ends and clip 2 starts. The added instruction asks Dola to start each clip on the last frame of the previous one to keep that change as small as possible.
- The joined video is recorded again at high quality (12 Mbps). On Chrome 126 or newer it is saved as MP4, and on older Chrome as WebM. YouTube accepts both.
- The extension needs permission to download from any website, because Dola's videos are stored on a separate video server.

## How it works

| File | Role |
|---|---|
| `src/content.js` | Notices when you send a prompt (Enter or the send button), tells the page hook which prompt it was, then watches for the new video and downloads it. Videos that were already on the page, such as old chats, are never downloaded. |
| `src/background.js` | Saves files with `chrome.downloads`, opens the joiner and shows notifications. |
| `src/join.html/js` | Plays the clips back to back into a canvas plus an audio mix and records one continuous video with `MediaRecorder`. Everything happens in your browser, so nothing is uploaded. |
| `src/popup.*` | Settings, status and download history. |

## Troubleshooting

- **The popup says "sent without the 30s change"**: reload the Dola tab (the extension only starts working after a reload). If it still happens, Dola may send prompts in a way the extension can't see. Please open an issue.
- **Nothing downloaded**: click **Download latest video now** in the popup, or raise **Keep watching for (min)**.
- **A preview or placeholder clip got downloaded**: raise **Ignore videos shorter than (s)**.
- **Watermarks**: the extension saves exactly the file Dola serves.

Use it for your own content, and follow Dola's Terms of Service. Every prompt you send still uses one generation from your Dola account.
