# One Delivery — Full Platform Deployment Guide

**From Anywhere To You.** This guide covers the complete platform end-to-end:

1. **Backend** (Express + MySQL + Redis + Socket.io) — the brain everything talks to
2. **Admin web app** (React + Vite) — approve drivers/sellers, manage the platform
3. **Mobile app** (customer — Expo/React Native)
4. **Driver app** (Expo/React Native)

Plus: hosting the backend on a **Hostinger VPS**, generating **Android APK & AAB**, and **iOS** builds for the App Store, and turning on **Brevo email + SMS verification**.

> Replace `onedelivery.co.tz` / `api.onedelivery.co.tz` with your real domain and every `CHANGE_ME...`. The credentials already in the `.env` files are the temporary ones you provided — rotate them before real production.

---

## How the four pieces communicate

```
                 ┌─────────────────────────────────────────────┐
                 │            BACKEND  (the VPS)                │
                 │  Express REST  +  Socket.io  +  MySQL/Redis  │
                 │  https://api.onedelivery.co.tz/api           │
                 └───────▲───────────▲───────────▲──────────────┘
                         │REST+WS    │REST+WS    │REST+WS
        ┌────────────────┘           │           └────────────────┐
   ┌────┴─────┐               ┌──────┴──────┐              ┌───────┴──────┐
   │ Mobile   │   request →   │  Driver app │   approve →  │  Admin web   │
   │ (customer)│  ride/track  │  GO LIVE,   │   driver     │  panel       │
   │          │ ◄ live driver │  navigate   │ ◄────────────│              │
   └──────────┘   location    └─────────────┘   triggers   └──────────────┘
                                                push+email+SMS
```

- All clients authenticate with the **same JWT** scheme (`/api/auth/*`), storing the access token under `od_access_token`.
- **Live tracking:** the driver app streams GPS over Socket.io (`driver:location`); the backend relays it to the customer (`driver:location_update`) and the admin (`driver:position`).
- **Approval flow:** admin approves in the panel → backend flips the driver to approved, sends a **push** (Firebase) **+ email + SMS** (Brevo) → the driver app's Home swaps "Application in review" for **GO LIVE**.

Everything was verified to use matching endpoints, socket events, and token keys.

---
---

# PART A — Backend on a Hostinger VPS

The backend is Node.js (Express) with **MySQL + Redis + Socket.io**, **Cloudinary** uploads, **Snippe** payments, **Firebase** push, and **Brevo** email/SMS.

## A0. Get the VPS & SSH in
1. Hostinger → **VPS** → a plan with ≥ 2 GB RAM. OS template: **Ubuntu 24.04 LTS** (clean Ubuntu, not a control-panel image).
2. Note the public IP, then: `ssh root@YOUR_VPS_IP`

## A1. DNS records (at your domain's DNS)
| Type | Name | Value |
|---|---|---|
| A | `api` | `YOUR_VPS_IP` |
| A | `admin` | `YOUR_VPS_IP` |
| A | `@` / `www` | `YOUR_VPS_IP` |

## A2. Create a deploy user
```bash
adduser deploy && usermod -aG sudo deploy && su - deploy
```

## A3. Install the stack
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential git mysql-server redis-server nginx
sudo npm install -g pm2
sudo systemctl enable --now mysql redis-server nginx
node -v && redis-cli ping   # PONG
```

## A4. MySQL database
```bash
sudo mysql_secure_installation
sudo mysql -u root -p
```
```sql
CREATE DATABASE onedelivery CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'onedelivery_user'@'localhost' IDENTIFIED BY 'CHANGE_ME_STRONG_DB_PASSWORD';
GRANT ALL PRIVILEGES ON onedelivery.* TO 'onedelivery_user'@'localhost';
FLUSH PRIVILEGES; EXIT;
```

## A5. Redis password
```bash
sudo nano /etc/redis/redis.conf      # uncomment & set:  requirepass CHANGE_ME_REDIS_PASSWORD
sudo systemctl restart redis-server
```

## A6. Upload the backend
```bash
# from your computer:
scp -r ./onedelivery-backend deploy@YOUR_VPS_IP:~/onedelivery-backend
# (or git clone a private repo)
```

## A7. Configure `.env`
The shipped `.env` already has your Cloudinary, Snippe, Google Maps, **Brevo SMTP + SMS**, and generated JWT secrets. On the server set just the infra values:
```bash
cd ~/onedelivery-backend
nano .env
```
```env
NODE_ENV=production
PORT=4000
DB_PASS=CHANGE_ME_STRONG_DB_PASSWORD       # match A4
REDIS_PASSWORD=CHANGE_ME_REDIS_PASSWORD    # match A5
API_URL=https://api.onedelivery.co.tz
CORS_ORIGIN=https://onedelivery.co.tz,https://admin.onedelivery.co.tz
FIREBASE_SERVICE_ACCOUNT_PATH=./secrets/firebase-service-account.json
```
Confirm the Firebase key is present: `ls -l secrets/firebase-service-account.json`

## A8. Install, migrate, create admin
```bash
npm install --omit=dev
npm run db:migrate                                  # builds all tables
npm run db:seed-admin admin@onedelivery.co.tz 'CHANGE_ME_ADMIN_PASSWORD' 'One Delivery Admin'
```
The last command creates your **admin login** (used by the admin panel).

## A9. Run with PM2
```bash
pm2 start src/server.js --name onedelivery-api
pm2 save && pm2 startup        # run the printed command
curl http://localhost:4000/api/health   # status ok
```

## A10. Nginx + WebSockets for the API
```bash
sudo nano /etc/nginx/sites-available/onedelivery-api
```
```nginx
server {
    listen 80;
    server_name api.onedelivery.co.tz;
    client_max_body_size 15M;
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/onedelivery-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## A11. HTTPS + firewall
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.onedelivery.co.tz       # choose redirect to HTTPS
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
curl https://api.onedelivery.co.tz/api/health
```

## A12. Snippe webhook
In Snippe set the webhook to `https://api.onedelivery.co.tz/api/payment/webhook` (HMAC verified with `SNIPPE_WEBHOOK_SECRET`).

## A13. Updating later
```bash
cd ~/onedelivery-backend && git pull
npm install --omit=dev && npm run db:migrate && pm2 restart onedelivery-api
```

### Backend is live at `https://api.onedelivery.co.tz` ✅

---
---

# PART B — Admin web app

A React + Vite SPA. Two ways to host it; pick one.

## Option 1 — Separate subdomain (recommended)

Build locally (or on the VPS):
```bash
cd onedelivery-admin
cp .env.example .env     # set VITE_API_URL=https://api.onedelivery.co.tz/api
npm install
npm run build            # outputs ./dist
```
Copy `dist` to the VPS and serve with Nginx:
```bash
scp -r ./dist deploy@YOUR_VPS_IP:~/admin-dist
```
On the VPS:
```bash
sudo mkdir -p /var/www/onedelivery-admin
sudo cp -r ~/admin-dist/* /var/www/onedelivery-admin/
sudo nano /etc/nginx/sites-available/onedelivery-admin
```
```nginx
server {
    listen 80;
    server_name admin.onedelivery.co.tz;
    root /var/www/onedelivery-admin;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }   # SPA fallback
}
```
```bash
sudo ln -s /etc/nginx/sites-available/onedelivery-admin /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d admin.onedelivery.co.tz
```
Open `https://admin.onedelivery.co.tz` and sign in with the admin from **A8**.

## Option 2 — Served by the backend
The backend already serves `../../admin/dist` in production. Put the built admin there:
```bash
# on the VPS, relative to the backend folder
mkdir -p ~/admin/dist && cp -r ~/admin-dist/* ~/admin/dist/
pm2 restart onedelivery-api
```
Then the admin is available at `https://api.onedelivery.co.tz/`.

> Branding: the admin login + sidebar now use `public/logo.png`, and the browser tab uses `public/favicon.svg` (your provided assets). Swap those two files anytime to rebrand.

---
---

# PART C — Mobile (customer) app — APK / AAB / iOS

Expo SDK 53 / React Native. Uses EAS Build (cloud — no Android Studio/Xcode needed).

## C0. Prereqs
```bash
npm install -g eas-cli
eas login                     # free Expo account
cd onedelivery-mobile
npm install
eas init                      # links project, prints projectId
```
Set the `projectId` it prints into `app.json` → `extra.eas.projectId`.

## C1. Point `.env` at production
```env
EXPO_PUBLIC_API_URL=https://api.onedelivery.co.tz/api
EXPO_PUBLIC_SOCKET_URL=https://api.onedelivery.co.tz
EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY=AIzaSy...   # real keys, Maps SDK + Directions enabled
EXPO_PUBLIC_GOOGLE_MAPS_IOS_KEY=AIzaSy...
```

## C2. Android APK (testing) & AAB (Play Store)
```bash
npm run build:android:apk     # → installable .apk  (eas preview profile)
npm run build:android:aab     # → .aab for Play Store (eas production profile)
```
First production build: let EAS generate & store the **keystore** (say yes).

## C3. Publish to Google Play
1. Play Console (one-time $25) → **Create app** "One Delivery".
2. Listing, screenshots, **Data safety**, **Content rating**, **Privacy policy URL**.
3. **Production → Create release →** upload the `.aab` → roll out.
```bash
# optional automated submit after configuring a Play service account:
eas submit --platform android --profile production --latest
```

## C4. iOS
Requires an **Apple Developer account** ($99/yr). No Mac needed.
```bash
npm run build:ios             # eas builds a signed .ipa; let EAS manage credentials
```
Then in **App Store Connect**: create the app (bundle id from `app.json`), fill listing + **App Privacy** (location), and:
```bash
eas submit --platform ios --profile production --latest
```
Test via **TestFlight**, then **Submit for Review**.

---
---

# PART D — Driver app — APK / AAB / iOS

Same toolchain. The driver app adds live navigation, GO-LIVE, and the application-review flow.

## D0. Prereqs
```bash
npm install -g eas-cli && eas login
cd onedelivery-driver-app
npm install
eas init                      # set the printed projectId into app.json → extra.eas.projectId
```

## D1. Production `.env`
```env
EXPO_PUBLIC_API_URL=https://api.onedelivery.co.tz/api
EXPO_PUBLIC_SOCKET_URL=https://api.onedelivery.co.tz
EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY=AIzaSy...
EXPO_PUBLIC_GOOGLE_MAPS_IOS_KEY=AIzaSy...
EXPO_PUBLIC_GOOGLE_DIRECTIONS_KEY=AIzaSy...   # for in-app route drawing + ETA
EXPO_PUBLIC_ENABLE_OTP=false
```

## D2. Android
```bash
eas build --platform android --profile preview      # APK (testing)
eas build --platform android --profile production    # AAB (Play Store)
```

## D3. iOS
```bash
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

> **Background location:** both apps request background location for live tracking. In Play Console record a short video justifying it, and in App Store Connect review notes explain trip tracking — otherwise the stores may reject the release. The usage-description strings are already set in each `app.json`.

---
---

# PART E — Brevo email + SMS verification

Already wired into the backend `.env`:
```env
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=...@smtp-brevo.com
SMTP_PASS=xsmtpsib-...
SMTP_FROM_EMAIL=no-reply@mail.onedelivery.co.tz
BREVO_API_KEY=xkeysib-...
SMS_PROVIDER=brevo
SMS_SENDER_ID=OneDeliver
```

**What works automatically now:**
- Driver **approval / rejection** emails + SMS (in addition to push).
- A reusable verification API:
  - `POST /api/auth/send-verification` `{ "channel": "email" | "sms" }` — sends a 6-digit code (Redis, 10-min TTL).
  - `POST /api/auth/verify-code` `{ "channel": "...", "code": "123456" }` — marks `email_verified` / `phone_verified`.

**Brevo setup checklist (one-time):**
1. In Brevo → **Senders & Domains**, authenticate the domain `mail.onedelivery.co.tz` (add the SPF/DKIM DNS records Brevo gives you) so emails don't land in spam, or change `SMTP_FROM_EMAIL` to a verified sender.
2. For SMS, top up SMS credits in Brevo and confirm the sender name `OneDeliver` is allowed in your country (Tanzania supports alphanumeric sender IDs).
3. Test from the VPS:
```bash
curl -X POST https://api.onedelivery.co.tz/api/auth/send-verification \
  -H "Authorization: Bearer <a-user-access-token>" \
  -H "Content-Type: application/json" -d '{"channel":"email"}'
```

> **Note on OTP login:** phone-OTP sign-in is intentionally still **off** (`OTP_ENABLED=false`) so the email/password flow keeps working. The Brevo channel + verify endpoints above are the foundation to switch it on later without re-architecting.

---

# First-run checklist

- [ ] Backend health green: `curl https://api.onedelivery.co.tz/api/health`
- [ ] Admin user created (A8) and you can log in at the admin URL
- [ ] Mobile & driver `.env` point at the **HTTPS** API + socket URL
- [ ] Real Google Maps keys in both apps' `.env` (Maps SDK Android/iOS + Directions API enabled, keys restricted to the bundle/package IDs)
- [ ] `projectId` set in each app's `app.json` after `eas init`
- [ ] Register a test driver → approve in admin → confirm push + email + SMS arrive and the app shows **GO LIVE**
- [ ] Place a test order in mobile → driver receives request → accept → customer sees the vehicle move live

---

# Troubleshooting

| Symptom | Fix |
|---|---|
| App "Network error" | `.env` must use the HTTPS API on real devices (`10.0.2.2` is Android-emulator only). |
| Sockets won't connect | Nginx needs the `Upgrade`/`Connection "upgrade"` headers (A10). |
| Map blank | Maps key missing/unrestricted or SDK not enabled; use an EAS **dev/prod build**, not Expo Go. |
| Push not received | Use an EAS build (not Expo Go) and set `projectId` in `app.json`. FCM uses the Firebase service account on the server. |
| Email in spam / not sent | Authenticate the sender domain in Brevo (SPF/DKIM) or use a verified `SMTP_FROM_EMAIL`. |
| SMS not sent | Add Brevo SMS credits; confirm sender ID allowed; check server logs for `[messaging] Brevo SMS failed`. |
| Admin "Access denied" | The account must have `role = 'admin'` — re-run `npm run db:seed-admin`. |
| Uploads fail (413) | Raise `client_max_body_size` in Nginx (set to 15M in A10). |

---

**One Delivery — From Anywhere To You.**
