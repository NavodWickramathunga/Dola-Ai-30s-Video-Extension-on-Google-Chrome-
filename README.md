# Dola AI 30s Video Maker (Chrome extension)

Paste your prompt into [Dola AI](https://www.dola.com/chat/) the way you normally do. With this extension installed:

1. **Your video is made as one single 30-second Seedance 2.5 video.** When you press send, the extension changes that request so the video length is set to 30 seconds. It also adds this line to your prompt:
   > Use Seedance 2.5. Video length: exactly 30 seconds as ONE single continuous 30-second video (do not split it into shorter clips).
2. **The finished video downloads automatically** to `Downloads/DolaAI/`.

You don't type anything into the extension, and it doesn't split videos into parts or stitch them together.

## Install

1. Download this repository: **Code → Download ZIP**, then unzip it.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode** (top-right).
3. Click **Load unpacked** and pick the unzipped folder (the one that contains `manifest.json`).
4. Pin the extension (puzzle-piece icon → pin **Dola 30s Video**).
5. **Reload any dola.com tab you already have open**, so the extension can start working in it.

## Use

1. Open https://www.dola.com/chat/ and paste your full prompt.
2. Press **Enter** or click Dola's send button.
3. Wait for Dola to finish. The video saves itself to `Downloads/DolaAI/dola_30s_<date>.mp4` and you get a notification.

The extension popup shows:
- **Status**: whether it is active on the Dola tab and whether it is waiting for your video.
- A **✓ Set to 30s** line with what was changed in the last prompt you sent, e.g. `duration: 10 → 30` and `added 30s instruction`.
- **Downloaded videos**, with each video's real length. If a video is shorter than 30s, it's marked in orange. That means Dola/Seedance capped the length.
- **Download latest video now**: saves the newest video on the page if the automatic download missed it.

### Settings

| Setting | Default |
|---|---|
| Make every Dola video __ seconds long | on, 30 |
| Add the "single 30s Seedance 2.5 video" instruction to my prompt (the wording can be edited) | on |
| Auto-download the finished video | on |
| Download folder / file name prefix | `DolaAI` / `dola` |
| Keep watching for (min): how long after you send to wait for the video | 20 |
| Ignore videos shorter than (s): skips small loading or preview animations | 2 |

## Important: the 30s limit is set by Dola, not the extension

The extension asks Dola for a single 30-second video in two ways: it sets the length in the request and it states the length in your prompt. **Whether you actually get 30 seconds depends on what Dola allows for Seedance 2.5 on your account.** If Dola only allows shorter videos, the server will still return a shorter one, and no browser extension can get around that. The "Downloaded videos" list shows each file's real length, so you can see right away whether you got the full 30 seconds.

## How it works

| File | Role |
|---|---|
| `src/content.js` | Notices when you send a prompt (Enter or the send button), tells the page hook which prompt it was, then watches for the new video and downloads it. Videos that were already on the page, such as old chats, are never downloaded. |
| `src/page-hook.js` | Runs inside the Dola page. Finds the one network request that carries your prompt, sets any duration field (`duration`, `video_duration`, `duration_ms`, …) to 30s and adds the instruction to your prompt. It also spots video links in Dola's responses. |
| `src/background.js` | Saves the file with `chrome.downloads` and shows a notification. |
| `src/popup.*` | Settings, status and download history. |

## Troubleshooting

- **The popup says "sent without the 30s change"**: reload the Dola tab (the extension only starts working after a reload). If it still happens, Dola may send prompts in a way the extension can't see. Please open an issue.
- **Nothing downloaded**: click **Download latest video now** in the popup, or raise **Keep watching for (min)**.
- **A preview or placeholder clip got downloaded**: raise **Ignore videos shorter than (s)**.
- **Watermarks**: the extension saves exactly the file Dola serves.

Use it for your own content, and follow Dola's Terms of Service. Every prompt you send still uses one generation from your Dola account.
