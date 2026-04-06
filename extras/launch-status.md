# ExoClaw Launch Status

Date: 2026-04-06

---

## Hacker News

**Status: FAILED — manual submission required**

**Reason:** Browser automation is unavailable in this environment. The agent-browser tool requires Chrome/Chromium, which is not installed and cannot be installed without root access. No HN credentials were available to attempt an alternative approach.

**Action required:** Submit manually at https://news.ycombinator.com/submit

- Title: `ExoClaw: self-hosted Claude Code gateway with Slack, Discord, Telegram, and web UI (open source)`
- URL: `https://github.com/exoclaw-labs/exoclaw`
- Body: see `extras/launch-copy.md` § "Hacker News Launch Post"

---

## Reddit r/selfhosted

**Status: FAILED — manual submission required**

**Reason:** Same as above — browser automation unavailable (no Chromium, no root access to install it). No Reddit credentials available.

**Action required:** Submit manually at https://www.reddit.com/r/selfhosted/submit

- Title: `ExoClaw — self-hosted Claude Code gateway that puts your AI in Slack, Discord, Telegram, WhatsApp, and a web dashboard. One Docker container.`
- Body: see `extras/launch-copy.md` § "Reddit Post (r/selfhosted + r/LocalLLaMA)"

---

## Reddit r/LocalLLaMA

**Status: FAILED — manual submission required**

**Reason:** Same as above.

**Action required:** Submit manually at https://www.reddit.com/r/LocalLLaMA/submit

- Title: `ExoClaw — self-hosted Claude Code gateway that puts your AI in Slack, Discord, Telegram, WhatsApp, and a web dashboard. One Docker container.`
- Body: see `extras/launch-copy.md` § "Reddit Post (r/selfhosted + r/LocalLLaMA)"

---

## Root Cause

`agent-browser install` confirmed: Chrome for Testing does not provide Linux ARM64 builds. System Chromium is unavailable. `apt-get` requires root. No workaround available without a browser binary.
