# Assistant

A liquid-glass screen assistant for Windows, inspired by [coucou](https://github.com/Louis-CFM/coucou). It hides above the top edge of your screen. Push the mouse to the top (or press the Copilot key) and it slides down. Ask about whatever is on screen, or record your screen and ask about the recording.

## Install

Unzip **Assistant-Setup.zip** and run **Assistant-Setup.exe**. It installs for your Windows account only (no admin prompt) and adds a Start menu entry. It isn't code-signed, so SmartScreen warns you the first time: click **More info → Run anyway**. If you used the old portable Assistant.exe, delete it; your settings and keys carry over.

## Updates

New versions are published as releases on the private repo `granny-6112/Assistant`, and the app updates itself from there. Because the repo is private, the app needs a read-only token once:

1. Open [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) (a fine-grained token).
2. Repository access: **Only select repositories → Assistant**. Permissions: **Contents → Read-only**. Nothing else.
3. Paste it into **Settings → Updates** in Assistant and press Save.

Assistant then checks 30 seconds after it starts and every 6 hours, downloads a new version in the background, and installs it the next time it restarts (or press **Restart now** in Settings, or **Restart to update** in the tray menu). The token is stored encrypted with your Windows account.

## Build and release (from source)

Needs [Node.js 20+](https://nodejs.org). `npm install`, then `npm start` to run it. `npm run dist` builds the installer into `dist\`. To publish an update: bump `version` in package.json, then `set GH_TOKEN=<token with Contents: Read and write>` and `npm run release`. That uploads the installer, its `.blockmap` and `latest.yml` to a new GitHub release, which is what installed copies look for.

## Models: the slider

Click the model chip in the bar (it shows *Smart* by default) and drag the slider:

| Stop | Model | Needs |
|---|---|---|
| Offline | Gemma 4 on your PC (size picked for your RAM: E4B on 16 GB) | Nothing. Downloads ~5.5 GB once, then works without internet |
| Fast | Gemini 3.5 Flash-Lite | Free Google AI Studio key |
| Balanced | Gemini 3.6 Flash | Free Google AI Studio key |
| Smart (default) | Gemini 3.8 Flash | Free Google AI Studio key |
| Max | Gemini 4 Argon | Google key **with billing on** (not on the free tier) |
| Claude | Claude Opus 5.5 | Paid Anthropic key |

Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and paste it into Settings. Keys are stored encrypted with your Windows account. You can switch models in the middle of a conversation.

**Privacy note:** on Google's free tier, Google may use what you send (your screenshots, too) to improve its products. Use Offline or a paid key for anything sensitive.

**Offline model:** it runs through [llama.cpp](https://github.com/ggml-org/llama.cpp) on your graphics chip (Vulkan; the Radeon 660M works). Expect a few words per second and noticeably weaker answers than Gemini. It loads when you first ask and unloads after 5 idle minutes to give back the RAM. You can change its size under Settings → Offline model size.

## Using it

| Action | How |
|---|---|
| Show the bar | Mouse to the top edge, the **Copilot key**, or **Alt+Shift+C** |
| Ask about your screen | Type and press **Enter**. A screenshot is attached automatically (the monitor icon toggles this) |
| Instant "what's on my screen?" | **Alt+Shift+S** |
| Record the screen | **○** button or **Alt+Shift+R**. Saved to `Videos\Assistant` with system audio |
| Ask about a recording | After stopping, click **Ask about last recording**, then ask |
| Keep open / hide / stop an answer | Pin button / **Esc** or move away / **Esc** while answering |

### Copilot key

The Copilot key sends Win+Shift+F23, and Assistant listens for it. Windows will *also* open Copilot unless you change **Settings → Personalization → Text input → Customize Copilot key on keyboard** to **Search** (or uninstall the Copilot app).

## Energy use

Assistant is built to sit in the background:

- While hidden it does no rendering and no screen capture. Its page is throttled by Windows/Chromium, except during a recording.
- Edge detection is a cheap cursor check. It runs 25 times a second only when the cursor is near the top, about 6 times a second elsewhere, once a second when the PC is idle, and not at all while locked or asleep.
- The live glass only runs while the bar is open, and redraws only when something behind it changes.
- The offline model only uses RAM and GPU while you're using it.

## Limits

- Needs Windows 10 version 2004 or later, so the bar can hide itself from screen capture.
- The bar never appears in screenshots or recordings, including ones from other tools.
- Built and tested on Linux with mocked screens. Gemini, Claude and the UI were exercised; the offline model download and llama.cpp run have not been run on a real Windows PC yet.
