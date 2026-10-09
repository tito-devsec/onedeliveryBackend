#!/usr/bin/env bash
# Deploys a new version of the OneDelivery API on the VPS.
#
# From the developer PC (Git Bash), first copy the code, then run this script:
#   git archive --format=tar.gz HEAD | ssh root@SERVER "cat > /tmp/onedelivery-backend.tar.gz && echo $(git rev-parse --short HEAD) > /tmp/onedelivery-backend.commit"
#   ssh root@SERVER 'bash -s' < scripts/deploy-vps.sh
#
# What it does (stops at the first error, before touching the live API):
#   1. finds the live folder from the running pm2 process "onedelivery-api"
#   2. backs up the database
#   3. unpacks the new code next to the live folder, copies .env and secrets/
#   4. installs packages and runs the (additive, re-runnable) database migration
#   5. swaps the folders (the old one is kept) and restarts the API
#   6. checks /api/health and prints how to switch back
set -euo pipefail

APP=onedelivery-api
TAR=/tmp/onedelivery-backend.tar.gz
STAMP=$(date +%Y%m%d-%H%M%S)

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

command -v pm2 >/dev/null || die "pm2 is not installed for user $(whoami)"
command -v node >/dev/null || die "node is not installed for user $(whoami)"
[ -s "$TAR" ] || die "$TAR is missing - run the copy command on your PC first"

# Live folder = where pm2 runs the API from
LIVE=$(pm2 jlist 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const list = JSON.parse(s.slice(s.indexOf("[")));
    const p = list.find(x => x.name === process.argv[1]);
    if (!p) return;
    const exec = p.pm2_env.pm_exec_path || "";
    const m = exec.match(/^(.*)\/src\/server\.js$/);
    process.stdout.write(m ? m[1] : (p.pm2_env.pm_cwd || ""));
  });' "$APP")
[ -n "$LIVE" ] || die "pm2 has no process called $APP for user $(whoami)"
[ -f "$LIVE/package.json" ] && [ -f "$LIVE/.env" ] || die "$LIVE does not look like the API folder (no package.json/.env)"
NEW="$LIVE-new"
OLD="$LIVE-old-$STAMP"
COMMIT=$(cat /tmp/onedelivery-backend.commit 2>/dev/null || echo unknown)
echo "Live API folder: $LIVE"
echo "Deploying commit: $COMMIT"

# Read a value from .env without executing it (values may contain spaces)
env_get() { grep -E "^$1=" "$LIVE/.env" | tail -n1 | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"'][[:space:]]*$//"; }

say "1/6 Backing up the database"
DUMP=$(command -v mariadb-dump || command -v mysqldump || true)
[ -n "$DUMP" ] || die "mysqldump/mariadb-dump not found"
DB_NAME=$(env_get DB_NAME); DB_USER=$(env_get DB_USER); DB_PASS=$(env_get DB_PASS)
DB_HOST=$(env_get DB_HOST); DB_PORT=$(env_get DB_PORT)
mkdir -p "$HOME/onedelivery-backups"
BACKUP="$HOME/onedelivery-backups/db-$STAMP.sql.gz"
# --no-tablespaces: avoids needing the PROCESS privilege on MySQL 8 (the app has no
# stored routines, so none are dumped)
MYSQL_PWD="$DB_PASS" "$DUMP" -h "${DB_HOST:-127.0.0.1}" -P "${DB_PORT:-3306}" -u "$DB_USER" \
  --single-transaction --quick --no-tablespaces "$DB_NAME" | gzip > "$BACKUP"
gzip -t "$BACKUP" && [ "$(gzip -dc "$BACKUP" | grep -c 'CREATE TABLE')" -gt 0 ] || die "database backup looks empty: $BACKUP"
echo "Saved $BACKUP ($(du -h "$BACKUP" | cut -f1))"

say "2/6 Unpacking the new version"
[ -e "$NEW" ] && mv "$NEW" "$NEW-stale-$STAMP" && echo "(moved an old $NEW aside)"
mkdir -p "$NEW"
tar -xzf "$TAR" -C "$NEW"
[ -f "$NEW/package.json" ] || die "the copied code has no package.json"
cp -a "$LIVE/.env" "$NEW/.env"
[ -d "$LIVE/secrets" ] && cp -a "$LIVE/secrets" "$NEW/"
echo "$COMMIT" > "$NEW/DEPLOYED_COMMIT"
# Keep the folder a git checkout of GitHub when it is one (never prompts: stdin is this script)
if [ -d "$LIVE/.git" ]; then
  cp -a "$LIVE/.git" "$NEW/.git"
  if command -v git >/dev/null \
     && GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" timeout 60 git -C "$NEW" fetch -q origin </dev/null 2>/dev/null \
     && git -C "$NEW" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
    git -C "$NEW" reset -q "$COMMIT" </dev/null && echo "Git: the folder is at commit $COMMIT"
  else
    echo "(Git history in the folder not updated: couldn't fetch $COMMIT from GitHub - the code itself is deployed)"
  fi
fi

say "3/6 Installing packages"
cd "$NEW"
npm ci --omit=dev --no-audit --no-fund

say "4/6 Updating the database (adds new tables/columns only)"
npm run db:migrate

say "5/6 Switching to the new version"
cd /
mv "$LIVE" "$OLD"
mv "$NEW" "$LIVE"
pm2 restart "$APP"

say "6/6 Checking the API"
PORT=$(env_get PORT); PORT=${PORT:-4000}
HEALTH=""
for _ in $(seq 1 30); do
  # nginx normally adds this header; without it the API redirects to https
  if HEALTH=$(curl -fsS -H "X-Forwarded-Proto: https" "http://127.0.0.1:$PORT/api/health" 2>/dev/null); then break; fi
  HEALTH=""; sleep 1
done
if [ -n "$HEALTH" ]; then
  echo "$HEALTH"
else
  echo "The API is not answering on port $PORT. Recent logs:"
  pm2 logs "$APP" --lines 40 --nostream || true
fi

cat <<EOF

Done: commit $COMMIT is live in $LIVE
Previous version kept in: $OLD
Database backup: $BACKUP

If something is wrong, switch back with:
  pm2 stop $APP && mv "$LIVE" "$LIVE-failed-$STAMP" && mv "$OLD" "$LIVE" && pm2 restart $APP
(The database changes only add tables/columns, so the old version keeps working with them.)
EOF
