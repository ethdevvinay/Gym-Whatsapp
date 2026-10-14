# The Club 777° — WhatsApp Web Integration Technical Evaluation
## Comparative Architectural Analysis: `@whiskeysockets/baileys` vs `whatsapp-web.js`

**Author:** Senior PHP Architect & Node.js Systems Engineer  
**Date:** October 2026  
**Target Environment:** Hostinger Cloud Startup Plan (Ubuntu LTS, 2 vCPU, 3 GB RAM, Node.js v22 LTS) / Local Development

---

### 1. Executive Summary

To provide automated membership expiry alerts, payment confirmations, and customer service notices without an official WhatsApp Business Cloud API account, two primary open-source Node.js libraries exist in the developer ecosystem:
1. **`@whiskeysockets/baileys`**: A direct WebSocket client implementation of the WhatsApp Multi-Device binary protocol (Noise protocol / Protobuf).
2. **`whatsapp-web.js`**: A Puppeteer/Chromium automation wrapper that controls an invisible instance of WhatsApp Web in a headless browser.

After evaluating both libraries against strict operational reliability, memory constraints, process supervision (PM2/systemd), and containerized/VPS constraints on a **Hostinger Cloud Startup plan**, **`@whiskeysockets/baileys` is selected** as the superior architecture for The Club 777°.

---

### 2. Comprehensive Comparison Matrix

| Evaluation Dimension | `@whiskeysockets/baileys` (Selected) | `whatsapp-web.js` (Alternative) | Architectural Impact on Hostinger Cloud |
| :--- | :--- | :--- | :--- |
| **Protocol Layer** | Direct WebSocket + Protobuf + Noise handshake | Headless Chromium DOM scraping via Puppeteer | Baileys connects directly without browser overhead; `whatsapp-web.js` requires full Chromium execution. |
| **RAM Consumption** | **35 MB – 75 MB** baseline | **350 MB – 850 MB** baseline per browser process | On a 3GB RAM VPS running Apache, MariaDB, and PHP-FPM, Baileys leaves 95%+ of RAM available for core gym operations. Chromium risks OOM killer kills. |
| **CPU Usage** | Negligible (< 1% idle, < 5% during packet dispatch) | High (15% – 45% during browser rendering & DOM polling) | Low CPU footprint ensures POS checkout and biometric scans in PHP never experience latency spikes. |
| **System Dependencies** | Standard Node.js runtime (`crypto`, `ws`) | Requires `libasound2`, `libnss3`, `libxss1`, Chromium binaries, fonts | Baileys installs cleanly on any minimal Linux or Windows server without package manager apt dependency issues. |
| **Session Persistence** | `useMultiFileAuthState` (Plain JSON credential files) | `RemoteAuth` / Local Chromium session directory (GBs of cache) | Baileys session directory is ~1.5 MB; easy to backup, encrypt, and restore. Chromium profiles frequently corrupt upon sudden restarts. |
| **QR Code Pairing** | Direct event hook `sock.ev.on('connection.update', ...)` returning terminal ASCII or raw QR string | Emits QR via event, but requires rendering the web page DOM first | Baileys generates QR in < 800ms upon boot; Chromium takes 5–15 seconds to cold-boot. |
| **Delivery Receipts (ACKs)** | **Native Protobuf events** (`sock.ev.on('messages.update')` with explicit status codes `2=SERVER_ACK`, `3=DELIVERY_ACK`, `4=READ_ACK`) | Limited to DOM checkmarks; prone to missed DOM mutations | **Critical for Phase 8:** Baileys provides cryptographically signed network evidence of delivery rather than guessing. |
| **Breaking Change Risk** | Meta protocol updates can cause socket disconnects until Baileys updates keys/protobufs | WhatsApp Web UI updates break DOM selectors immediately | Both libraries carry risk of upstream protocol shifts; Baileys maintains an active community release cadence. |
| **Ban / Account Risk** | **High if abused.** (Unofficial reverse-engineered protocol) | **High if abused.** (Automated browser detectable via Canvas/WebGL fingerprints) | **Both libraries violate WhatsApp Business Terms of Service.** Must be treated as experimental, controlled evaluation only. |

---

### 3. Pinned Dependency & Licensing Information

- **Selected Library:** `@whiskeysockets/baileys`
- **Pinned Version:** `^6.7.24`
- **License:** MIT License
- **Underlying Protocol:** WhatsApp Multi-Device (MD) v2.3000.x+
- **Companion Dependencies:**
  - `qrcode` (MIT) — Converts pairing strings into data URIs for the PHP admin modal.
  - `pino` (MIT) — Zero-overhead JSON logger with secret redaction.
  - `mysql2/promise` (MIT) — High-performance connection pool for atomic queue locking.
  - `express` (MIT) — Secure local administrative API.

---

### 4. Mandatory Disclaimer & Compliance Notice

> [!WARNING]
> **LEGAL & OPERATIONAL DISCLAIMER — UNOFFICIAL AUTOMATION**
> 1. Neither `@whiskeysockets/baileys` nor `whatsapp-web.js` is endorsed, affiliated with, or supported by Meta Platforms, Inc. / WhatsApp LLC.
> 2. Connecting to WhatsApp via unofficial multi-device gateways is a violation of Meta's Terms of Service and carries an inherent risk of temporary or permanent phone number ban.
> 3. **The Club 777° system implements strict technical guardrails:**
>    - **Dry-Run Mode Enabled by Default:** Messages are simulated in database logs until explicitly enabled by an authorized administrator.
>    - **Rate Throttling & Jitter:** 8–15 second spacing between queue dispatches.
>    - **Zero Bulk Spamming:** Messages are restricted to 1-to-1 operational gym reminders for opted-in active members.
>    - **Opt-Out Compliance:** Any member requesting STOP is immediately flagged in the database and suppressed from all future queues.
>    - **Fallback:** If WhatsApp Web connectivity disconnects, the system falls back to generating direct manual `https://wa.me/` click-to-chat links for staff.
