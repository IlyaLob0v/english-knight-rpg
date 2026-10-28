#!/usr/bin/env sh
# Brings up the local LMS stack and writes the gateway's settings for it:
#   docker/state/tool-key.pem       the tool's LTI signing key (kept across runs)
#   docker/state/lti-platforms.json the Moodle registration (LTI_PLATFORMS_FILE)
#   docker/state/gateway.env        env for `pnpm dev:server:lms`
# Safe to run again: Moodle provisioning is idempotent and the key is reused.
set -eu
cd "$(dirname "$0")/.."
STATE=docker/state
mkdir -p "$STATE"

if [ ! -f "$STATE/tool-key.pem" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$STATE/tool-key.pem" 2>/dev/null
  echo "generated the tool key: $STATE/tool-key.pem"
fi

docker compose up -d

printf "waiting for Moodle (the first start installs it, about 2-3 minutes)"
i=0
until curl -sf -o /dev/null http://localhost:8080/login/index.php; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then echo; echo "Moodle did not come up; see: docker compose logs moodle" >&2; exit 1; fi
  printf "."
  sleep 5
done
echo " ready"

# The activities come from the course files, so a new unit gets its LMS link on the next run.
MODULES=$(node -e '
const fs = require("fs");
const read = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")));
const modules = read("content/modules");
const out = read("content/courses").flatMap((c) => c.units).map((id) => ({ id, title: modules.find((m) => m.module_id === id).title.en }));
process.stdout.write(JSON.stringify(out));
')
docker compose exec -T -e MOONBRIDGE_MODULES="$MODULES" moodle php /provision/provision.php > "$STATE/lti-platforms.json"

cat > "$STATE/gateway.env" <<ENV
DATABASE_URL=postgres://moonbridge:moonbridge@localhost:5432/moonbridge
LRS_ENDPOINT=http://localhost:8090/xapi
LRS_KEY=moonbridge-gateway
LRS_SECRET=moonbridge-gateway-secret
LTI_PLATFORMS_FILE=$PWD/$STATE/lti-platforms.json
LTI_PRIVATE_KEY_FILE=$PWD/$STATE/tool-key.pem
PUBLIC_URL=http://localhost:8787
CLIENT_URL=http://localhost:5173
ENV

echo
echo "Done. Next, in two terminals:"
echo "  pnpm dev:server:lms   # the gateway with Postgres, the LRS and Moodle"
echo "  pnpm dev:client"
echo "Moodle: http://localhost:8080 (student / Moonbridge-Student-1, teacher / Moonbridge-Teacher-1, admin / Moonbridge-Admin-1)"
echo "LRS admin: http://localhost:8090 (admin / moonbridge-admin)"
