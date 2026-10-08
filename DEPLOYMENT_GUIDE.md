# OneDelivery — Complete VPS Hosting Guide
## Hostinger VPS · Ubuntu 24.04 · api.onedelivery.co.tz

---

## Table of Contents
1. [Server Provisioning](#1-server-provisioning)
2. [Initial Server Hardening](#2-initial-server-hardening)
3. [Install Node.js, MySQL, Redis](#3-install-nodejs-mysql-redis)
4. [MySQL Database Setup](#4-mysql-database-setup)
5. [Redis Setup](#5-redis-setup)
6. [Deploy the Backend](#6-deploy-the-backend)
7. [Nginx Reverse Proxy](#7-nginx-reverse-proxy)
8. [SSL Certificates (Let's Encrypt)](#8-ssl-certificates-lets-encrypt)
9. [DNS Configuration at Netpoa](#9-dns-configuration-at-netpoa)
10. [PM2 Process Manager](#10-pm2-process-manager)
11. [Firebase Push Notifications](#11-firebase-push-notifications)
12. [Cloudinary Setup](#12-cloudinary-setup)
13. [Snippe Gateway Configuration](#13-snippe-gateway-configuration)
14. [Environment Variables Reference](#14-environment-variables-reference)
15. [Redis Integration Guide](#15-redis-integration-guide)
16. [Firewall & Security](#16-firewall--security)
17. [Monitoring & Logs](#17-monitoring--logs)
18. [CI/CD with GitHub Actions](#18-cicd-with-github-actions)
19. [Scaling Checklist](#19-scaling-checklist)
20. [Troubleshooting](#20-troubleshooting)

---

## 1. Server Provisioning

### Recommended Hostinger VPS Plan
| Plan | RAM | CPU | Storage | Suitable for |
|------|-----|-----|---------|-------------|
| KVM 2 | 8 GB | 4 vCPU | 100 GB NVMe | Launch / up to ~500 users |
| KVM 4 | 16 GB | 6 vCPU | 200 GB NVMe | Growth / up to ~5,000 users |
| KVM 8 | 32 GB | 8 vCPU | 400 GB NVMe | Scale / 5,000+ users |

### Create the VPS
1. Log in at **hpanel.hostinger.com**
2. Go to **VPS → Create New** → Select **Ubuntu 24.04 LTS**
3. Choose your plan, pick **Frankfurt** or closest datacenter
4. Set a **strong root password** (save it securely)
5. Note your **VPS IP address** (e.g. `123.456.789.100`)

---

## 2. Initial Server Hardening

### Connect via SSH
```bash
ssh root@YOUR_VPS_IP
```

### Create a non-root deployment user
```bash
adduser deploy
usermod -aG sudo deploy

# Copy SSH key to new user
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

### SSH Hardening
```bash
nano /etc/ssh/sshd_config
```
Change/add these lines:
```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
Port 22
MaxAuthTries 3
```
```bash
systemctl restart sshd
```

### Swap file (important for 8GB RAM servers)
```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### System updates
```bash
apt update && apt upgrade -y
apt install -y curl wget git unzip build-essential ufw fail2ban
```

---

## 3. Install Node.js, MySQL, Redis

### Node.js 22 LTS
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
apt install -y nodejs
node -v   # should show v22.x.x
npm -v
```

### MySQL 8
```bash
apt install -y mysql-server
mysql_secure_installation
# Answer: Yes to all prompts
# Set a STRONG root password
```

### Redis 7
```bash
curl -fsSL https://packages.redis.io/gpg | gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/redis.list
apt update && apt install -y redis-server
```

### Nginx
```bash
apt install -y nginx
systemctl enable nginx
```

### Certbot (for SSL)
```bash
apt install -y certbot python3-certbot-nginx
```

---

## 4. MySQL Database Setup

### Secure MySQL and create the database
```bash
mysql -u root -p
```

Run inside MySQL shell:
```sql
-- Create database
CREATE DATABASE onedelivery CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create dedicated user (replace STRONG_PASSWORD)
CREATE USER 'onedelivery_user'@'localhost' IDENTIFIED BY 'STRONG_PASSWORD_HERE';

-- Grant privileges
GRANT ALL PRIVILEGES ON onedelivery.* TO 'onedelivery_user'@'localhost';
FLUSH PRIVILEGES;

-- Verify
SHOW DATABASES;
EXIT;
```

### Run the schema migration
```bash
cd /var/www/onedelivery-backend
node src/config/migrate.js
```

### MySQL performance tuning (edit `/etc/mysql/mysql.conf.d/mysqld.cnf`)
```ini
[mysqld]
innodb_buffer_pool_size = 2G          # 25% of RAM for 8GB server
innodb_log_file_size = 256M
innodb_flush_log_at_trx_commit = 2   # Slightly relaxed for performance
max_connections = 200
query_cache_type = 0                  # Disabled in MySQL 8
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 2
```
```bash
systemctl restart mysql
```

---

## 5. Redis Setup

### Configure Redis
```bash
nano /etc/redis/redis.conf
```

Key settings to change:
```conf
# Bind to localhost only (never expose Redis publicly)
bind 127.0.0.1

# Set a password (same as REDIS_PASSWORD in .env)
requirepass YOUR_STRONG_REDIS_PASSWORD

# Persistence (choose one)
save 900 1        # Save if 1 key changed in 900 seconds
save 300 10       # Save if 10 keys changed in 300 seconds
appendonly yes    # WAL-style persistence (recommended)

# Max memory
maxmemory 1gb
maxmemory-policy allkeys-lru

# Disable dangerous commands in production
rename-command FLUSHALL ""
rename-command FLUSHDB  ""
rename-command DEBUG    ""
rename-command CONFIG   "CONFIG_SECRET_STRING"
```

```bash
systemctl restart redis-server
systemctl enable redis-server

# Test
redis-cli -a YOUR_REDIS_PASSWORD ping
# Should return: PONG
```

---

## 6. Deploy the Backend

### Create deployment directory
```bash
mkdir -p /var/www/onedelivery-backend
chown deploy:deploy /var/www/onedelivery-backend
```

### Upload your code (from your local machine)
```bash
# Option A: SCP
scp -r ./onedelivery-backend/* deploy@YOUR_VPS_IP:/var/www/onedelivery-backend/

# Option B: Git (recommended)
# On the server:
su - deploy
cd /var/www
git clone https://github.com/YOUR_USERNAME/onedelivery-backend.git
cd onedelivery-backend
```

### Install dependencies
```bash
cd /var/www/onedelivery-backend
npm install --omit=dev
```

### Create the environment file
```bash
nano /var/www/onedelivery-backend/.env
```

Paste and fill in all variables (see Section 14 for reference):
```env
NODE_ENV=production
PORT=4000
JWT_SECRET=<64_char_hex>
JWT_REFRESH_SECRET=<another_64_char_hex>
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=onedelivery
DB_USER=onedelivery_user
DB_PASS=STRONG_PASSWORD_HERE
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=YOUR_STRONG_REDIS_PASSWORD
CLOUDINARY_CLOUD_NAME=onedelivery
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
SNIPPE_API_KEY=snp_...
SNIPPE_WEBHOOK_SECRET=whsec_...
FIREBASE_SERVICE_ACCOUNT_PATH=/etc/onedelivery/firebase-service-account.json
GOOGLE_MAPS_API_KEY=...
CLIENT_URL=https://onedelivery.co.tz
API_URL=https://api.onedelivery.co.tz
ADMIN_EMAIL=admin@onedelivery.co.tz
BASE_SHIPPING_COST=2000
TAX_RATE=0
CORS_ORIGIN=https://onedelivery.co.tz,https://admin.onedelivery.co.tz
```

### Secure the .env file
```bash
chmod 600 /var/www/onedelivery-backend/.env
chown deploy:deploy /var/www/onedelivery-backend/.env
```

### Place Firebase service account
```bash
mkdir -p /etc/onedelivery
# Upload your firebase-service-account.json to the server:
# scp firebase-service-account.json deploy@YOUR_VPS_IP:/etc/onedelivery/
chmod 600 /etc/onedelivery/firebase-service-account.json
```

### Run database migration
```bash
cd /var/www/onedelivery-backend
node src/config/migrate.js
```

---

## 7. Nginx Reverse Proxy

### Create Nginx config for the API
```bash
nano /etc/nginx/sites-available/api.onedelivery.co.tz
```

```nginx
# Rate limiting zones
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=10r/m;

upstream onedelivery_api {
    server 127.0.0.1:4000;
    keepalive 32;
}

server {
    listen 80;
    server_name api.onedelivery.co.tz;
    # Will be upgraded to HTTPS by Certbot
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.onedelivery.co.tz;

    # SSL — filled in by Certbot
    ssl_certificate     /etc/letsencrypt/live/api.onedelivery.co.tz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.onedelivery.co.tz/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;

    # Hide Nginx version
    server_tokens off;

    # Max upload size (for product images)
    client_max_body_size 20M;

    # Auth rate limiting
    location ~ ^/api/auth/(login|register) {
        limit_req zone=auth_limit burst=5 nodelay;
        proxy_pass http://onedelivery_api;
        include /etc/nginx/proxy_params;
    }

    # WebSocket support (Socket.io)
    location /socket.io/ {
        proxy_pass http://onedelivery_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }

    # API proxy
    location /api/ {
        limit_req zone=api_limit burst=50 nodelay;
        proxy_pass http://onedelivery_api;
        include /etc/nginx/proxy_params;
        proxy_read_timeout 60s;
        proxy_connect_timeout 10s;
    }

    # Health check (no rate limit)
    location /api/health {
        proxy_pass http://onedelivery_api;
        include /etc/nginx/proxy_params;
        access_log off;
    }

    # Block hidden files
    location ~ /\. {
        deny all;
        return 404;
    }

    # Gzip
    gzip on;
    gzip_types application/json text/plain application/javascript;
    gzip_min_length 1000;
}
```

### Create shared proxy params
```bash
nano /etc/nginx/proxy_params
```
```nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection "";
proxy_buffering off;
```

### Main site (onedelivery.co.tz) — serves the user app / admin panel
```bash
nano /etc/nginx/sites-available/onedelivery.co.tz
```
```nginx
server {
    listen 80;
    server_name onedelivery.co.tz www.onedelivery.co.tz;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name onedelivery.co.tz www.onedelivery.co.tz;

    ssl_certificate     /etc/letsencrypt/live/onedelivery.co.tz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/onedelivery.co.tz/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root /var/www/admin/dist;
    index index.html;

    # Serve React/Vite SPA
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets aggressively
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
}
```

### Enable sites
```bash
ln -sf /etc/nginx/sites-available/api.onedelivery.co.tz /etc/nginx/sites-enabled/
ln -sf /etc/nginx/sites-available/onedelivery.co.tz     /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t          # test config
systemctl reload nginx
```

---

## 8. SSL Certificates (Let's Encrypt)

### Get certificates (run AFTER DNS is propagated — see Section 9)
```bash
certbot --nginx -d api.onedelivery.co.tz
certbot --nginx -d onedelivery.co.tz -d www.onedelivery.co.tz
```

### Auto-renewal (already set up by certbot, but verify)
```bash
certbot renew --dry-run
# Add to crontab:
crontab -e
# Add this line:
0 3 * * * certbot renew --quiet && systemctl reload nginx
```

---

## 9. DNS Configuration at Netpoa

Log in to your Netpoa account → **DNS Management** for `onedelivery.co.tz`

Add these DNS records:

| Type  | Host             | Value (Points to)   | TTL  |
|-------|------------------|---------------------|------|
| A     | @                | YOUR_VPS_IP         | 3600 |
| A     | www              | YOUR_VPS_IP         | 3600 |
| A     | api              | YOUR_VPS_IP         | 3600 |
| CNAME | admin            | onedelivery.co.tz   | 3600 |

### Verify DNS propagation
```bash
# From your local machine
nslookup api.onedelivery.co.tz
dig api.onedelivery.co.tz

# Should return your VPS IP
```

> DNS can take 5 minutes to 48 hours to propagate. Use https://dnschecker.org to monitor.

---

## 10. PM2 Process Manager

### Install PM2
```bash
npm install -g pm2
```

### Create PM2 ecosystem file
```bash
nano /var/www/onedelivery-backend/ecosystem.config.cjs
```

```javascript
module.exports = {
  apps: [
    {
      name:        "onedelivery-api",
      script:      "src/server.js",
      cwd:         "/var/www/onedelivery-backend",
      instances:   "max",        // Use all CPU cores
      exec_mode:   "cluster",    // Node.js cluster mode
      watch:       false,
      max_memory_restart: "1G",

      env_production: {
        NODE_ENV: "production",
      },

      // Log settings
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file:  "/var/log/onedelivery/out.log",
      error_file:"/var/log/onedelivery/error.log",
      merge_logs: true,

      // Graceful shutdown
      kill_timeout: 5000,
      wait_ready:   true,
      listen_timeout: 10000,
    }
  ]
};
```

### Create log directory
```bash
mkdir -p /var/log/onedelivery
chown deploy:deploy /var/log/onedelivery
```

### Start with PM2
```bash
cd /var/www/onedelivery-backend
pm2 start ecosystem.config.cjs --env production

# Save PM2 process list (survives reboots)
pm2 save

# Set PM2 to start on boot
pm2 startup
# Copy and run the command it outputs
```

### PM2 common commands
```bash
pm2 status              # Show all processes
pm2 logs onedelivery-api   # Tail logs
pm2 reload onedelivery-api # Zero-downtime reload
pm2 restart onedelivery-api
pm2 stop onedelivery-api
pm2 monit               # Real-time monitoring dashboard
```

---

## 11. Firebase Push Notifications

### Setup Firebase Project
1. Go to **console.firebase.google.com**
2. Create a new project → **onedelivery**
3. Go to **Project Settings → Service Accounts**
4. Click **Generate new private key** → Download the JSON file
5. Upload to your VPS:
   ```bash
   scp firebase-service-account.json deploy@YOUR_VPS_IP:/etc/onedelivery/
   chmod 600 /etc/onedelivery/firebase-service-account.json
   ```

### For the Mobile Apps (React Native / Expo)
1. In Firebase Console → **Project Settings → General**
2. Add Android app: package `com.yourcompany.onedelivery`
3. Add iOS app: bundle ID `com.yourcompany.onedelivery`
4. Download `google-services.json` (Android) and `GoogleService-Info.plist` (iOS)
5. Place them in your Expo project

### Update app.json for Expo notifications
```json
{
  "expo": {
    "plugins": [
      ["expo-notifications", {
        "icon": "./assets/icon.png",
        "color": "#F97316",
        "androidMode": "default",
        "androidCollapsedTitle": "OneDelivery"
      }]
    ]
  }
}
```

---

## 12. Cloudinary Setup

1. Sign up at **cloudinary.com**
2. Dashboard → copy **Cloud Name, API Key, API Secret**
3. Go to **Settings → Upload**
4. Create upload presets if needed
5. Set your **Cloud Name** to `onedelivery` (or your chosen name)
6. Add to your `.env`:
   ```env
   CLOUDINARY_CLOUD_NAME=onedelivery
   CLOUDINARY_API_KEY=826474627281563
   CLOUDINARY_API_SECRET=BAx3a_nnB6vWoJPo25F2as10NCY
   ```

---

## 13. Snippe Gateway Configuration

### Get API Keys
1. Go to **snippe.sh** → Dashboard
2. Copy your **Live API Key** (starts with `snp_`)
3. Go to **Webhooks** section

### Configure Webhook
1. Add webhook URL: `https://api.onedelivery.co.tz/api/payment/webhook`
2. Select events:
   - `payment.completed`
   - `payment.failed`
   - `payment.expired`
   - `payment.voided`
3. Copy the **Webhook Secret** (starts with `whsec_`)
4. Add both to `.env`:
   ```env
   SNIPPE_API_KEY=snp_YOUR_LIVE_KEY
   SNIPPE_WEBHOOK_SECRET=whsec_YOUR_SECRET
   ```

### Test the webhook
```bash
# After deploying, test Snippe can reach your server:
curl -X POST https://api.onedelivery.co.tz/api/payment/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"test","id":"test123","data":{"reference":"test"}}'
# Should return: {"received":true}
```

---

## 14. Environment Variables Reference

Full `.env` for production:

```env
# ── Server
NODE_ENV=production
PORT=4000

# ── JWT (generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
JWT_SECRET=<64_char_random_hex>
JWT_EXPIRES_IN=7d
JWT_REFRESH_SECRET=<different_64_char_random_hex>
JWT_REFRESH_EXPIRES_IN=30d

# ── MySQL
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=onedelivery
DB_USER=onedelivery_user
DB_PASS=<your_mysql_password>
DB_POOL_MIN=2
DB_POOL_MAX=20

# ── Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=<your_redis_password>

# ── Cloudinary
CLOUDINARY_CLOUD_NAME=onedelivery
CLOUDINARY_API_KEY=<your_key>
CLOUDINARY_API_SECRET=<your_secret>

# ── Snippe
SNIPPE_API_KEY=snp_<your_live_key>
SNIPPE_WEBHOOK_SECRET=whsec_<your_secret>

# ── Firebase
FIREBASE_SERVICE_ACCOUNT_PATH=/etc/onedelivery/firebase-service-account.json

# ── Google Maps
GOOGLE_MAPS_API_KEY=<your_server_side_key>

# ── App
CLIENT_URL=https://onedelivery.co.tz
API_URL=https://api.onedelivery.co.tz
ADMIN_EMAIL=admin@onedelivery.co.tz

# ── Commerce
BASE_SHIPPING_COST=2000
TAX_RATE=0

# ── CORS (comma-separated, no spaces)
CORS_ORIGIN=https://onedelivery.co.tz,https://admin.onedelivery.co.tz
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=300
```

### Generate secure JWT secrets
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# Run this twice — once for JWT_SECRET and once for JWT_REFRESH_SECRET
```

---

## 15. Redis Integration Guide

Redis is used in this backend for 5 critical purposes:

### Purpose 1 — Driver Online Status (Real-time)
```
Key pattern:  drivers:online          → SET of online driver user IDs
Key pattern:  driver:loc:{userId}     → HASH {lat, lng, ts}
TTL: 120 seconds (auto-expires if driver stops sending heartbeats)
```
How it works:
- Driver calls `PUT /api/rides/driver/online` or sends `driver:location` via Socket.io
- Backend calls `setDriverOnline(userId, lat, lng)` → writes to Redis
- When a new ride is requested, backend reads `getOnlineDriverIds()` from Redis (fast, no DB query)
- If driver disconnects without calling offline, the key expires in 120s automatically

### Purpose 2 — Response Caching
```
Key pattern:  product:{id}   → JSON, TTL 300s
```
Avoids repeated DB queries for frequently viewed products.

### Purpose 3 — Idempotency Keys
```
Key pattern:  idem:{key}     → JSON result, TTL 86400s
```
Prevents duplicate payment/order creation if the client retries.

### Purpose 4 — Rate Limiting (sliding window)
```
Key pattern:  rl:{ip}:{endpoint}   → Sorted Set of timestamps
```
More precise than express-rate-limit alone.

### Purpose 5 — Session / Token Blacklist (future)
When you add logout-all-devices, you store revoked JWT IDs here.

### Connecting the Mobile Apps to Redis
The apps do NOT connect to Redis directly. Only the backend connects.
The apps talk to the backend API → the backend reads/writes Redis internally.

### Monitoring Redis
```bash
redis-cli -a YOUR_PASSWORD monitor          # Live command stream
redis-cli -a YOUR_PASSWORD info memory      # Memory usage
redis-cli -a YOUR_PASSWORD info stats       # Stats
redis-cli -a YOUR_PASSWORD dbsize           # Number of keys
```

---

## 16. Firewall & Security

### UFW (Uncomplicated Firewall)
```bash
ufw default deny incoming
ufw default allow outgoing

# Allow SSH (critical — do this FIRST)
ufw allow 22/tcp

# Allow HTTP and HTTPS
ufw allow 80/tcp
ufw allow 443/tcp

# Enable firewall
ufw enable
ufw status verbose
```

> **Never** open port 3306 (MySQL) or 6379 (Redis) to the public internet.
> They should only be accessible on localhost (127.0.0.1).

### Fail2ban (protects against brute-force)
```bash
# Fail2ban is already installed from Section 2
nano /etc/fail2ban/jail.local
```
```ini
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd

[sshd]
enabled  = true
port     = 22
maxretry = 3

[nginx-limit-req]
enabled  = true
filter   = nginx-limit-req
port     = http,https
logpath  = /var/log/nginx/error.log
maxretry = 10
```
```bash
systemctl restart fail2ban
fail2ban-client status
```

### MySQL Security
```bash
# MySQL should only accept localhost connections (default after mysql_secure_installation)
# Verify:
grep "bind-address" /etc/mysql/mysql.conf.d/mysqld.cnf
# Should show: bind-address = 127.0.0.1
```

---

## 17. Monitoring & Logs

### Log locations
```bash
# Application logs
/var/log/onedelivery/out.log         # stdout
/var/log/onedelivery/error.log       # stderr

# Nginx logs
/var/log/nginx/access.log
/var/log/nginx/error.log

# MySQL
/var/log/mysql/error.log
/var/log/mysql/slow.log

# System
journalctl -u nginx -f
journalctl -u mysql -f
```

### Log rotation (prevent disk fill)
```bash
nano /etc/logrotate.d/onedelivery
```
```
/var/log/onedelivery/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        pm2 reloadLogs
    endscript
}
```

### Disk usage monitoring
```bash
df -h           # Disk usage
du -sh /var/log # Log sizes
du -sh /var/lib/mysql  # MySQL data size
```

### Simple uptime monitoring
Use a free external monitor like **UptimeRobot** (uptimerobot.com):
1. Add new monitor → HTTP(s)
2. URL: `https://api.onedelivery.co.tz/api/health`
3. Check interval: 5 minutes
4. Alert email: admin@onedelivery.co.tz

---

## 18. CI/CD with GitHub Actions

### Create `.github/workflows/deploy.yml` in your repo
```yaml
name: Deploy to VPS

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to VPS via SSH
        uses: appleboy/ssh-action@master
        with:
          host:     ${{ secrets.VPS_HOST }}
          username: deploy
          key:      ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /var/www/onedelivery-backend
            git pull origin main
            npm install --omit=dev
            node src/config/migrate.js
            pm2 reload onedelivery-api --update-env
            echo "✅ Deployed at $(date)"
```

### Add GitHub Secrets
In your GitHub repo → Settings → Secrets → Actions:
- `VPS_HOST` = your VPS IP
- `VPS_SSH_KEY` = your deploy user's private SSH key

---

## 19. Scaling Checklist

When traffic grows, here's what to do in order:

### Stage 1 — Optimize current server (free)
- [ ] Enable MySQL query cache (already tuned in Section 4)
- [ ] Add Redis caching to more endpoints (products list, categories)
- [ ] Enable Nginx gzip (already in config)
- [ ] Run `pm2 start ecosystem.config.cjs` with `instances: "max"` (uses all CPU cores)

### Stage 2 — Upgrade VPS plan
- [ ] Upgrade to KVM 4 (16 GB RAM) on Hostinger — zero downtime upgrade
- [ ] Increase `DB_POOL_MAX` to 40
- [ ] Increase `maxmemory` in Redis to 2gb
- [ ] Increase MySQL `max_connections` to 400

### Stage 3 — Separate database server
- [ ] Move MySQL to a dedicated Hostinger DB VPS or Hostinger MySQL service
- [ ] Update `DB_HOST` in `.env` to the DB server IP
- [ ] Configure MySQL to accept connections from app server IP only

### Stage 4 — Load balancer + multiple app servers
- [ ] Set up a Hostinger load balancer
- [ ] Deploy 2+ identical app servers
- [ ] Move Redis to a dedicated server (or Redis Cloud)
- [ ] Use sticky sessions or JWT (already stateless ✅)
- [ ] Use shared Cloudinary for file storage (already ✅)

### Stage 5 — Managed services
- [ ] Migrate MySQL to **PlanetScale** or **AWS RDS**
- [ ] Migrate Redis to **Upstash** (serverless Redis) or **Redis Cloud**
- [ ] Use **Cloudflare** for global CDN + DDoS protection

---

## 20. Troubleshooting

### Backend won't start
```bash
cd /var/www/onedelivery-backend
node src/server.js          # Run directly to see errors
# Common: missing .env variable, MySQL not running, port already in use
```

### MySQL connection refused
```bash
systemctl status mysql
systemctl start mysql
mysql -u onedelivery_user -p onedelivery    # Test connection
```

### Redis connection failed
```bash
systemctl status redis-server
redis-cli -a YOUR_PASSWORD ping
# Check /etc/redis/redis.conf for requirepass setting
```

### Nginx 502 Bad Gateway
```bash
# Backend not running
pm2 status
pm2 start ecosystem.config.cjs --env production

# Wrong port
grep "proxy_pass" /etc/nginx/sites-available/api.onedelivery.co.tz
# Must match PORT in .env
```

### SSL certificate issues
```bash
certbot certificates             # List all certs
certbot renew                    # Force renewal
certbot --nginx -d api.onedelivery.co.tz   # Re-run if needed
```

### Webhook not receiving events from Snippe
```bash
# Test your webhook endpoint is reachable
curl https://api.onedelivery.co.tz/api/payment/webhook
# Check Snippe dashboard → Webhook logs for delivery errors
# Verify SNIPPE_WEBHOOK_SECRET matches in .env and Snippe dashboard
```

### Deployment checklist for go-live
```
[ ] .env filled with production values (real API keys)
[ ] node src/config/migrate.js ran successfully
[ ] pm2 status shows "online"
[ ] https://api.onedelivery.co.tz/api/health returns {"status":"ok"}
[ ] Snippe webhook URL registered and tested
[ ] Firebase service account uploaded to /etc/onedelivery/
[ ] DNS A records pointing to VPS IP (verified with nslookup)
[ ] SSL certificate active (https:// works)
[ ] UFW firewall enabled
[ ] Fail2ban running
[ ] UptimeRobot monitor added
[ ] Admin user created in database
```

### Create first admin user
```bash
mysql -u onedelivery_user -p onedelivery
```
```sql
-- First register via API, then promote to admin:
UPDATE users SET role = 'admin' WHERE email = 'admin@onedelivery.co.tz';
```

---

## Quick Reference — API Endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login → returns JWT tokens |
| POST | `/api/auth/refresh` | Refresh access token |
| POST | `/api/auth/logout` | Logout (invalidate refresh token) |
| GET  | `/api/auth/me` | Get current user profile |

### Products
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/api/products` | List approved products |
| GET  | `/api/products/:id` | Get single product |
| POST | `/api/products` | Create product (seller) |
| GET  | `/api/products/seller/mine` | Seller's own products |

### Payment
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payment/checkout` | Mobile money checkout |
| POST | `/api/payment/checkout/card` | Card checkout |
| POST | `/api/payment/delivery` | Pay delivery fee |
| POST | `/api/payment/withdraw` | Request withdrawal |
| POST | `/api/payment/webhook` | Snippe webhook (internal) |

### Rides / Delivery
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/api/rides/options` | Get vehicle options & fares |
| POST | `/api/rides/request` | Request delivery |
| GET  | `/api/rides/:rideId` | Get ride status + driver location |
| PUT  | `/api/rides/driver/location` | Driver location heartbeat |
| PUT  | `/api/rides/driver/online` | Toggle driver online/offline |

### Socket.io Events
| Event (client → server) | Description |
|--------------------------|-------------|
| `driver:online` | Driver goes online with location |
| `driver:location` | Location heartbeat (every 5s) |
| `driver:offline` | Driver goes offline |
| `chat:join` | Join a conversation room |
| `chat:typing` | Typing indicator |

| Event (server → client) | Description |
|--------------------------|-------------|
| `driver:location_update` | Live driver position for customer |
| `new_message` | New chat message |
| `chat:typing` | Someone is typing |
| `driver:position` | All driver positions (admin) |

---

*OneDelivery Backend v2 — Production Ready*
*Domain: api.onedelivery.co.tz | Stack: Node.js + MySQL + Redis + Socket.io + Snippe*
