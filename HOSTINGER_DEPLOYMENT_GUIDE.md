# The Club 777° — Hostinger Cloud Startup Plan 24×7 Deployment Guide
## Node.js WhatsApp Reminder Worker & Multi-Device Service

**Operating Environment:** Hostinger Cloud Startup Plan (Ubuntu 22.04/24.04 LTS, 2 vCPU, 3 GB RAM, NVMe Storage)  
**Service Role:** 24×7 Background Process for Membership Reminders, Message Queue, and Multi-Device WhatsApp Connectivity  
**Date:** October 2026  

---

## 1. Architectural Overview & Cloud Sizing

Hostinger Cloud Startup plan provides dedicated compute resources that ensure your PHP web application and background Node.js services run simultaneously without memory starvation:
- **PHP 8.3 + Apache + MariaDB (Web Tier):** Handles member check-ins, POS transactions, reports, and administrative UI (~400–600 MB RAM).
- **Node.js Baileys Worker (Background Service):** Consumes only **35–70 MB RAM** and < 1% CPU when idle.
- **Buffer/OS Headroom:** Over 2 GB of RAM remains free for database query caching and spike handling.

```
┌─────────────────────────────────────────────────────────────────┐
│               HOSTINGER CLOUD STARTUP SERVER                    │
│                                                                 │
│   ┌───────────────────────────┐    ┌─────────────────────────┐  │
│   │   PHP Application / POS   │    │  Node.js Baileys Worker │  │
│   │  http://localhost/GYM/    │    │  http://127.0.0.1:3001  │  │
│   └─────────────┬─────────────┘    └────────────┬────────────┘  │
│                 │                               │               │
│                 │      Internal IPC / cURL      │               │
│                 └─────────► X-Worker-Auth ◄─────┘               │
│                                 │                               │
│                                 ▼                               │
│                    ┌─────────────────────────┐                  │
│                    │     MySQL / MariaDB     │                  │
│                    │  whatsapp_reminder_queue│                  │
│                    │  whatsapp_worker_status │                  │
│                    └─────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Server Prerequisites & Node.js LTS Installation

SSH into your Hostinger Cloud server as root or an administrative sudo user:

```bash
# 1. Update system packages
sudo apt update && sudo apt upgrade -y

# 2. Install Node.js v22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential

# Verify versions
node -v # Expected: v22.x.x
npm -v  # Expected: v10.x.x

# 3. Install PM2 Globally
sudo npm install -g pm2
```

---

## 3. Dedicated Service Account & Directory Permissions

Do not run the worker as the `root` user in production. Create a dedicated least-privilege service account:

```bash
# Create dedicated system group and user
sudo addgroup --system gymworker
sudo adduser --system --ingroup gymworker --no-create-home gymworker

# Navigate to service directory (e.g. /var/www/theclub777/whatsapp_gateway)
cd /var/www/theclub777/whatsapp_gateway

# Install production dependencies
npm ci --only=production

# Create logs directory
mkdir -p logs auth_info
sudo chown -R gymworker:gymworker .
sudo chmod 700 auth_info logs
sudo chmod 600 .env
```

---

## 4. Least-Privilege MySQL Account Configuration

Instead of granting `root` database permissions to Node.js, create a dedicated database user restricted only to the necessary tables:

```sql
-- Run in MySQL Console on Hostinger server
CREATE USER 'club777_worker'@'127.0.0.1' IDENTIFIED BY 'STRONG_UNIQUE_PASSWORD_HERE';

-- Grant required permissions on reminder and queue tables
GRANT SELECT, INSERT, UPDATE, DELETE ON gym_db.whatsapp_reminder_queue TO 'club777_worker'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE ON gym_db.whatsapp_worker_status TO 'club777_worker'@'127.0.0.1';
GRANT SELECT ON gym_db.member_subscriptions TO 'club777_worker'@'127.0.0.1';
GRANT SELECT, UPDATE ON gym_db.members TO 'club777_worker'@'127.0.0.1';
GRANT SELECT ON gym_db.membership_types TO 'club777_worker'@'127.0.0.1';
GRANT SELECT ON gym_db.settings TO 'club777_worker'@'127.0.0.1';

FLUSH PRIVILEGES;
```

Update your `.env` file with these credentials:
```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=club777_worker
DB_PASS=STRONG_UNIQUE_PASSWORD_HERE
DB_NAME=gym_db
```

---

## 5. PM2 Process Supervision & Automatic Reboot Persistence

Deploy with the provided `ecosystem.config.cjs`:

```bash
# 1. Start the service with PM2 under the gymworker user
sudo -u gymworker pm2 start ecosystem.config.cjs

# 2. Check operational status
sudo -u gymworker pm2 status
sudo -u gymworker pm2 logs club777-whatsapp-worker --lines 30

# 3. Configure PM2 to auto-start on server reboot (Systemd)
sudo -u gymworker pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u gymworker --hp /home/gymworker
```

---

## 6. Automated Log Rotation (`pm2-logrotate`)

Prevent logs from filling disk space over months of 24×7 operation:

```bash
sudo -u gymworker pm2 install pm2-logrotate

# Configure rotation thresholds
sudo -u gymworker pm2 set pm2-logrotate:max_size 10M
sudo -u gymworker pm2 set pm2-logrotate:retain 7
sudo -u gymworker pm2 set pm2-logrotate:compress true
```

---

## 7. Firewall & Network Security Rules

The Node.js service must **never** be exposed directly to the public internet:

```bash
# Ensure UFW allows only SSH, HTTP, and HTTPS externally
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# Verify that port 3001 is listening strictly on 127.0.0.1 (Loopback only)
sudo ss -tulpn | grep 3001
# Expected output: 127.0.0.1:3001 (NOT 0.0.0.0:3001)
```

---

## 8. Health Check & Monitoring Commands

```bash
# Quick health check from CLI
curl -s http://127.0.0.1:3001/health

# Authenticated status inspection
curl -s -H "X-Worker-Auth: YOUR_SECRET_HERE" http://127.0.0.1:3001/status | jq .

# Trigger manual reminder scan
curl -s -X POST -H "X-Worker-Auth: YOUR_SECRET_HERE" http://127.0.0.1:3001/scan | jq .
```

---

## 9. Disaster Recovery & Session Reset

If a phone number is unlinked or Meta resets authentication keys:
1. In the PHP Admin Dashboard (`index.php?page=communication`), click **"Disconnect / Reset"**.
2. Or via CLI:
   ```bash
   sudo -u gymworker pm2 stop club777-whatsapp-worker
   rm -rf auth_info/*
   sudo -u gymworker pm2 start club777-whatsapp-worker
   ```
3. Open `index.php?page=communication` as Super Admin and scan the newly generated QR code.
