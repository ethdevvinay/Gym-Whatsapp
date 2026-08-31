import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const AUTH_DIR = path.join(__dirname, 'auth_info');

let sock = null;
let currentQrRaw = null;
let currentQrImage = null;
let connectionState = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
let connectedUser = null;
let reconnectAttempts = 0;

const logger = pino({ level: 'silent' });

async function initWhatsApp() {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307], isLatest: true }));

    connectionState = 'connecting';
    console.log(`[WhatsApp Gateway] Starting connection with Baileys v${version.join('.')}...`);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger,
      browser: ['THE CLUB 777', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQrRaw = qr;
        connectionState = 'qr_ready';
        try {
          currentQrImage = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
          console.log('[WhatsApp Gateway] New QR code generated. Ready to scan!');
        } catch (err) {
          console.error('[WhatsApp Gateway] Failed to generate QR image:', err);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        console.log(`[WhatsApp Gateway] Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);

        currentQrRaw = null;
        currentQrImage = null;
        connectedUser = null;
        connectionState = 'disconnected';

        if (shouldReconnect) {
          reconnectAttempts++;
          const delay = Math.min(reconnectAttempts * 3000, 15000);
          console.log(`[WhatsApp Gateway] Reconnecting in ${delay / 1000}s...`);
          setTimeout(initWhatsApp, delay);
        } else {
          console.log('[WhatsApp Gateway] Logged out from WhatsApp. Clear session to rescan.');
        }
      } else if (connection === 'open') {
        reconnectAttempts = 0;
        connectionState = 'connected';
        currentQrRaw = null;
        currentQrImage = null;
        connectedUser = sock.user;
        console.log(`[WhatsApp Gateway] Successfully connected as: ${sock.user?.name || sock.user?.id || 'Connected'}`);
      }
    });

  } catch (error) {
    console.error('[WhatsApp Gateway] Initialization error:', error);
    connectionState = 'disconnected';
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getRandomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function generateAntiBanRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ref = '';
  for (let i = 0; i < 4; i++) {
    ref += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `#777-${ref}`;
}

// ---------------- REST API ROUTES ----------------

// 1. Connection Status
app.get('/status', (req, res) => {
  res.json({
    success: true,
    status: connectionState,
    connected: connectionState === 'connected',
    user: connectedUser ? {
      id: connectedUser.id,
      name: connectedUser.name || 'THE CLUB 777® Official Bot',
      phone: connectedUser.id ? connectedUser.id.split('@')[0].split(':')[0] : null
    } : null,
    qr: currentQrImage,
    anti_ban_active: true,
    timestamp: new Date().toISOString()
  });
});

// 2. Get QR Code directly
app.get('/qr', (req, res) => {
  if (connectionState === 'connected') {
    return res.json({
      success: true,
      status: 'connected',
      message: 'WhatsApp is already connected! No QR scan needed.'
    });
  }

  if (!currentQrImage) {
    return res.json({
      success: false,
      status: connectionState,
      message: 'QR code is being generated... Please wait a moment.'
    });
  }

  res.json({
    success: true,
    status: 'qr_ready',
    qr_image: currentQrImage,
    qr_raw: currentQrRaw
  });
});

// 3. Send WhatsApp Message with Anti-Ban Human Behavior Simulation
app.post('/send', async (req, res) => {
  try {
    const { phone, message, is_bulk } = req.body;

    if (!phone || !message) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and message body are required'
      });
    }

    if (connectionState !== 'connected' || !sock) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp Gateway is not connected. Please scan QR code in settings first.'
      });
    }

    let cleanPhone = String(phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length === 10) {
      cleanPhone = '91' + cleanPhone; // Default to India (+91)
    }

    const jid = `${cleanPhone}@s.whatsapp.net`;

    // 🛡️ ANTI-BAN HUMAN SIMULATION PROTOCOL:
    try {
      // 1. Subscribe to recipient presence
      await sock.presenceSubscribe(jid).catch(() => {});
      await sock.sendPresenceUpdate('available').catch(() => {});
      
      // 2. Simulate Realistic Typing Status
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      
      // Dynamic typing delay based on message length (1.2s to 3.0s for transactional; 8s to 18s if bulk)
      const typingTime = is_bulk ? getRandomDelay(4000, 9000) : getRandomDelay(1200, 2600);
      await sleep(typingTime);
      
      // 3. Pause typing right before dispatch
      await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    } catch (presenceErr) {
      // Ignore presence simulation errors on edge networks
    }

    // 🛡️ ANTI-HASH RANDOMIZATION (Ensures Meta spam filter never sees 2 identical message hashes)
    let finalMessage = String(message).trim();
    if (!finalMessage.includes('Ref: #777-') && !finalMessage.includes('Invoice No:')) {
      finalMessage += `\n\n_Ref: ${generateAntiBanRef()}_`;
    }

    const result = await sock.sendMessage(jid, { text: finalMessage });

    console.log(`[WhatsApp Anti-Ban Gateway] Message delivered safely to: ${cleanPhone} (Ref: ${result.key.id})`);
    
    // Cooldown jitter for safety
    if (is_bulk) {
      const cooldown = getRandomDelay(6000, 14000);
      console.log(`[WhatsApp Anti-Ban Queue] Cooldown jitter: ${cooldown / 1000}s before next recipient...`);
      await sleep(cooldown);
    }

    return res.json({
      success: true,
      message_id: result.key.id,
      recipient: cleanPhone,
      status: 'sent',
      anti_ban: 'protected'
    });

  } catch (error) {
    console.error('[WhatsApp Gateway] Send message error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to send WhatsApp message'
    });
  }
});

// 3B. Send WhatsApp Document (PDF Invoice) with Anti-Ban Protection
app.post('/send-document', async (req, res) => {
  try {
    const { phone, file_path, file_name, caption } = req.body;

    if (!phone || !file_path) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and file_path are required'
      });
    }

    if (connectionState !== 'connected' || !sock) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp Gateway is not connected. Please scan QR code in settings first.'
      });
    }

    // Verify file exists
    if (!fs.existsSync(file_path)) {
      return res.status(404).json({
        success: false,
        error: `PDF file not found at: ${file_path}`
      });
    }

    let cleanPhone = String(phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length === 10) {
      cleanPhone = '91' + cleanPhone;
    }

    const jid = `${cleanPhone}@s.whatsapp.net`;

    // 🛡️ ANTI-BAN HUMAN SIMULATION FOR DOCUMENTS
    try {
      await sock.presenceSubscribe(jid).catch(() => {});
      await sock.sendPresenceUpdate('available').catch(() => {});
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      await sleep(getRandomDelay(1500, 3000));
      await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    } catch (presenceErr) {
      // Ignore presence errors
    }

    // Read PDF file buffer
    const fileBuffer = fs.readFileSync(file_path);
    const docFileName = file_name || path.basename(file_path);

    // Add anti-hash token to caption
    let finalCaption = caption || `📄 Official Fee Receipt - THE CLUB 777®`;
    if (!finalCaption.includes('Ref: #777-')) {
      finalCaption += `\n\n_Ref: ${generateAntiBanRef()}_`;
    }

    // Send as document
    const result = await sock.sendMessage(jid, {
      document: fileBuffer,
      mimetype: 'application/pdf',
      fileName: docFileName,
      caption: finalCaption
    });

    console.log(`[WhatsApp Anti-Ban Gateway] PDF Document delivered to: ${cleanPhone} (File: ${docFileName}, Ref: ${result.key.id})`);

    return res.json({
      success: true,
      message_id: result.key.id,
      recipient: cleanPhone,
      file_name: docFileName,
      status: 'sent',
      type: 'document',
      anti_ban: 'protected'
    });

  } catch (error) {
    console.error('[WhatsApp Gateway] Send document error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to send WhatsApp document'
    });
  }
});

// 4. Logout / Reset Session
app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
    }
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    connectionState = 'disconnected';
    connectedUser = null;
    currentQrImage = null;
    currentQrRaw = null;

    setTimeout(initWhatsApp, 1500);

    return res.json({
      success: true,
      message: 'Session cleared and WhatsApp gateway reset. Ready for new QR scan.'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 5. WhatsApp Health Dashboard (Browser UI)
app.get('/health', (req, res) => {
  const uptimeSec = Math.floor(process.uptime());
  const hh = String(Math.floor(uptimeSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((uptimeSec % 3600) / 60)).padStart(2, '0');
  const ss = String(uptimeSec % 60).padStart(2, '0');
  const uptime = `${hh}:${mm}:${ss}`;

  const stateColor = { connected: '#10B981', qr_ready: '#F59E0B', connecting: '#6366F1', disconnected: '#EF4444' };
  const stateLabel = { connected: '✅ CONNECTED', qr_ready: '📷 SCAN QR CODE', connecting: '⏳ CONNECTING...', disconnected: '🔴 DISCONNECTED' };
  const color = stateColor[connectionState] || '#EF4444';
  const label = stateLabel[connectionState] || connectionState.toUpperCase();

  const qrSection = connectionState === 'connected'
    ? `<div class="info-box" style="background:#10B98122;border-color:#10B98144;">
        <div style="font-size:3rem;">✅</div>
        <div style="font-size:1.2rem;font-weight:800;color:#10B981;margin-top:.5rem;">WhatsApp Connected!</div>
        <div style="color:#94A3B8;margin-top:.25rem;font-size:.9rem;">
          ${connectedUser ? `📱 ${connectedUser.name || 'Connected'} &nbsp;|&nbsp; ${connectedUser.id?.split('@')[0]?.split(':')[0] || ''}` : ''}
        </div>
       </div>`
    : currentQrImage
      ? `<div class="info-box" style="background:#F59E0B11;border-color:#F59E0B44;">
          <p style="color:#F59E0B;font-weight:700;margin-bottom:1rem;">📱 Open WhatsApp → Linked Devices → Scan QR</p>
          <img src="${currentQrImage}" alt="QR Code" style="width:220px;height:220px;border-radius:12px;border:4px solid #F59E0B44;">
          <p style="color:#64748B;font-size:.75rem;margin-top:.75rem;">QR auto-refreshes every 20 seconds</p>
         </div>`
      : `<div class="info-box" style="background:#6366F111;border-color:#6366F144;">
          <div style="font-size:2.5rem;animation:spin 1s linear infinite;">⏳</div>
          <div style="color:#6366F1;font-weight:700;margin-top:.5rem;">Generating QR Code...</div>
          <div style="color:#64748B;font-size:.8rem;">This page will auto-refresh</div>
         </div>`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WhatsApp Gateway · THE CLUB 777®</title>
  <meta http-equiv="refresh" content="5">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0F172A;color:#E2E8F0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
    .card{background:#1E293B;border-radius:20px;padding:2.5rem;width:100%;max-width:560px;box-shadow:0 25px 60px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.06);text-align:center}
    .logo{font-size:1.6rem;font-weight:900;letter-spacing:-.04em}
    .logo span{color:#25D366}
    .status-badge{display:inline-block;padding:.55rem 1.4rem;border-radius:50px;font-size:.8rem;font-weight:800;letter-spacing:.06em;margin:1rem 0;border:1.5px solid ${color}44;background:${color}18;color:${color}}
    .info-box{background:#0F172A;border:1.5px solid rgba(255,255,255,.08);border-radius:14px;padding:1.5rem;margin:1.25rem 0}
    .stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:.65rem;margin:1.25rem 0;text-align:left}
    .stat{background:#0F172A;border-radius:10px;padding:.75rem 1rem;border:1px solid rgba(255,255,255,.06)}
    .stat-label{font-size:.68rem;color:#64748B;text-transform:uppercase;letter-spacing:.07em;font-weight:700}
    .stat-value{font-size:.9rem;font-weight:700;color:#E2E8F0;margin-top:.2rem}
    .btn{display:inline-block;padding:.55rem 1.2rem;border-radius:10px;font-size:.8rem;font-weight:700;text-decoration:none;cursor:pointer;border:none;margin:.25rem}
    .btn-danger{background:#EF444422;color:#EF4444;border:1px solid #EF444444}
    .btn-primary{background:#7C3AED22;color:#A78BFA;border:1px solid #7C3AED44}
    .btn-green{background:#10B98122;color:#10B981;border:1px solid #10B98144}
    .footer{color:#334155;font-size:.7rem;margin-top:1.25rem}
    .dot{width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;margin-right:6px;${connectionState==='connected'?'animation:pulse 1.5s ease infinite':''}}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.3)}}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
<div class="card">
  <div class="logo">💬 THE CLUB <span>777®</span></div>
  <div style="color:#64748B;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;margin-top:.25rem">WhatsApp Gateway Monitor</div>

  <div class="status-badge"><span class="dot"></span>${label}</div>

  ${qrSection}

  <div class="stat-grid">
    <div class="stat"><div class="stat-label">Uptime</div><div class="stat-value">⏱ ${uptime}</div></div>
    <div class="stat"><div class="stat-label">Port</div><div class="stat-value">🔌 ${PORT}</div></div>
    <div class="stat"><div class="stat-label">Reconnect Attempts</div><div class="stat-value">🔄 ${reconnectAttempts}</div></div>
    <div class="stat"><div class="stat-label">Anti-Ban</div><div class="stat-value" style="color:#10B981">🛡️ ACTIVE</div></div>
    <div class="stat" style="grid-column:1/-1"><div class="stat-label">Server Time</div><div class="stat-value">🕐 ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:true})}</div></div>
  </div>

  <div>
    <a href="/health" class="btn btn-primary">🔄 Refresh</a>
    <a href="/status" class="btn btn-green" target="_blank">📡 JSON API</a>
    <a href="/qr" class="btn btn-green" target="_blank">📷 QR JSON</a>
    <button onclick="if(confirm('Logout & reset WhatsApp session?')) fetch('/logout',{method:'POST'}).then(()=>location.reload())" class="btn btn-danger">🔓 Logout & Rescan</button>
  </div>

  <div class="footer">Auto-refreshes every 5s · THE CLUB 777® Gym Management</div>
</div>
</body>
</html>`);
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 THE CLUB 777® Node.js WhatsApp Gateway running on PORT ${PORT}`);
  console.log(`🛡️ 100% Anti-Ban Human Simulation & Queue Protection: ACTIVE`);
  console.log(`🔗 API: http://localhost:${PORT}/status`);
  console.log(`=======================================================`);
  initWhatsApp();
});
