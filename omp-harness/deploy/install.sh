#!/usr/bin/env bash
# Installe le harness sur un VPS systemd (Debian, Ubuntu) — en root, depuis le clone.
#
#   sudo bash omp-harness/deploy/install.sh
#
# Idempotent : une configuration déjà posée (/etc/omp-harness/config.json,
# launcher.conf, zram) n'est jamais écrasée. Rien n'est démarré tant que la
# configuration n'a pas au moins un dépôt.
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "✗ à lancer en root" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DEST=/opt/omp-harness

for tool in node git curl sha256sum ssh-keygen systemd-run systemctl choom sudo visudo; do
  command -v "$tool" >/dev/null || { echo "✗ $tool est requis" >&2; exit 1; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)' \
  || { echo "✗ Node ≥ 22.6 requis (node:sqlite, --experimental-strip-types)" >&2; exit 1; }

# omp, à la version de l'app Mac (omp-console/Sources/OMPConsole/Setup/ComponentManifest.swift),
# vérifié contre une empreinte épinglée ici — jamais contre celle que publie le serveur.
OMP_VERSION=18.6.0
case "$(uname -m)" in
  x86_64) OMP_ASSET=omp-linux-x64; OMP_SHA256=844c640c620ec4c152abe4b3736049f963205da50e9e77bd9bdf2a981a6ead55 ;;
  aarch64 | arm64) OMP_ASSET=omp-linux-arm64; OMP_SHA256=542083fe42a6169565861a4ee9118fbed64d09c93468b6907e6016cc76ef00d1 ;;
  *) echo "✗ architecture non prise en charge par omp : $(uname -m)" >&2; exit 1 ;;
esac
if [ "$(/usr/local/bin/omp --version 2>/dev/null || true)" != "omp/$OMP_VERSION" ]; then
  echo "· omp $OMP_VERSION → /usr/local/bin/omp"
  tmp="$(mktemp)"
  curl -fsSL "https://github.com/can1357/oh-my-pi/releases/download/v$OMP_VERSION/$OMP_ASSET" -o "$tmp"
  echo "$OMP_SHA256  $tmp" | sha256sum -c --quiet - || { rm -f "$tmp"; echo "✗ empreinte d'omp inattendue" >&2; exit 1; }
  install -m 0755 "$tmp" /usr/local/bin/omp
  rm -f "$tmp"
fi

echo "· users et groupe (sysusers)"
install -m 0644 "$HERE/sysusers.conf" /etc/sysusers.d/omp-harness.conf
systemd-sysusers /etc/sysusers.d/omp-harness.conf

echo "· arborescence (tmpfiles)"
install -m 0644 "$HERE/tmpfiles.conf" /etc/tmpfiles.d/omp-harness.conf
systemd-tmpfiles --create /etc/tmpfiles.d/omp-harness.conf

# Le service ET le plugin mémoire, côte à côte : le harness lit la table des
# manifestes du plugin (même scope que le Mac), les runners chargent le plugin (-e).
echo "· code du service et du plugin mémoire → $DEST"
install -d -m 0755 "$DEST"
for part in omp-harness omp-mem0-memory; do
  rm -rf "$DEST/$part.new"
  cp -a "$REPO/$part" "$DEST/$part.new"
  rm -rf "$DEST/$part"
  mv "$DEST/$part.new" "$DEST/$part"
done
chown -R root:root "$DEST"

echo "· oracle mem0-rs"
if [ ! -x /usr/local/bin/mem0-rs ] || [ "${OMP_HARNESS_REBUILD_MEM0:-0}" = "1" ]; then
  if command -v cargo >/dev/null; then
    cargo build --release --locked --manifest-path "$REPO/mem0-stack/mem0-rs/Cargo.toml"
    install -m 0755 "$REPO/mem0-stack/mem0-rs/target/release/mem0-rs" /usr/local/bin/mem0-rs
  else
    echo "· cargo absent : installe /usr/local/bin/mem0-rs à la main (cargo build --release dans mem0-stack/mem0-rs)"
  fi
fi

echo "· lanceur root + sudoers"
install -m 0755 -o root -g root "$HERE/omp-harness-systemd-run" /usr/local/libexec/omp-harness-systemd-run
install -m 0440 -o root -g root "$HERE/sudoers" /etc/sudoers.d/omp-harness.new
visudo -cf /etc/sudoers.d/omp-harness.new >/dev/null
mv /etc/sudoers.d/omp-harness.new /etc/sudoers.d/omp-harness

echo "· configuration (/etc/omp-harness)"
install -d -m 0755 /etc/omp-harness
[ -e /etc/omp-harness/launcher.conf ] || install -m 0644 "$HERE/launcher.conf" /etc/omp-harness/launcher.conf
[ -e /etc/omp-harness/config.json ] || install -m 0640 -g omp-harness "$HERE/config.example.json" /etc/omp-harness/config.json
[ -e /etc/omp-harness/env ] || install -m 0640 -g omp-harness /dev/null /etc/omp-harness/env
# Les clés des fournisseurs LLM des runners : root seul les lit, le lanceur les passe au runner.
[ -e /etc/omp-harness/runner.env ] || install -m 0600 -o root -g root /dev/null /etc/omp-harness/runner.env
# La mémoire du projet : un jeton partagé par mem0-rs, le service et les runners.
if [ ! -e /etc/omp-harness/mem0.env ]; then
  token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  sed "s/^MEM0_HTTP_TOKEN=.*/MEM0_HTTP_TOKEN=$token/" "$HERE/mem0.env.example" > /etc/omp-harness/mem0.env
  chmod 0600 /etc/omp-harness/mem0.env
  printf 'MEM0_HTTP_TOKEN=%s\n' "$token" >> /etc/omp-harness/env
  printf 'MEM0_HTTP_URL=http://127.0.0.1:8321\nMEM0_HTTP_TOKEN=%s\n' "$token" >> /etc/omp-harness/runner.env
  echo "· /etc/omp-harness/mem0.env créé : renseigne OMLX_BASE_URL (le homelab via Tailscale)"
fi

echo "· git : les worktrees changent de propriétaire entre service, runners et heavy"
for user in omp-harness omp-runner omp-heavy; do
  home="$(getent passwd "$user" | cut -d: -f6)"
  if ! sudo -u "$user" HOME="$home" git config --global --get-all safe.directory 2>/dev/null | grep -qx '\*'; then
    sudo -u "$user" HOME="$home" git config --global --add safe.directory '*'
  fi
done

echo "· clé SSH du service : il pousse les merges sur le distant"
if [ ! -e /var/lib/omp-harness/.ssh/id_ed25519 ]; then
  install -d -m 0700 -o omp-harness -g omp-harness /var/lib/omp-harness/.ssh
  sudo -u omp-harness ssh-keygen -q -t ed25519 -N '' -C "omp-harness@$(hostname)" -f /var/lib/omp-harness/.ssh/id_ed25519
  # Premier contact : la clé d'hôte est retenue ; une clé qui change ensuite est refusée.
  printf 'Host *\n  StrictHostKeyChecking accept-new\n' > /var/lib/omp-harness/.ssh/config
  chown omp-harness:omp-harness /var/lib/omp-harness/.ssh/config
  chmod 0600 /var/lib/omp-harness/.ssh/config
fi
install -m 0755 "$HERE/omp-harness-check" /usr/local/bin/omp-harness-check

echo "· tranches, service, zram, oomd"
install -m 0644 "$HERE/omp-harness.slice" "$HERE/omp-harness-runners.slice" "$HERE/omp-harness-heavy.slice" \
  "$HERE/omp-harness.service" "$HERE/omp-harness-mem0.service" /etc/systemd/system/
if [ ! -e /etc/systemd/zram-generator.conf ]; then
  install -m 0644 "$HERE/zram-generator.conf" /etc/systemd/zram-generator.conf
  [ -e /usr/lib/systemd/system-generators/zram-generator ] || echo "· installe systemd-zram-generator pour activer le swap zram (8 Go)"
fi
install -d -m 0755 /etc/systemd/oomd.conf.d
install -m 0644 "$HERE/oomd.conf" /etc/systemd/oomd.conf.d/omp-harness.conf
systemctl daemon-reload
if systemctl list-unit-files systemd-oomd.service >/dev/null 2>&1; then
  systemctl enable --now systemd-oomd.service || echo "· systemd-oomd n'a pas démarré : vérifie le support PSI du noyau"
else
  echo "· systemd-oomd absent : installe-le (paquet systemd-oomd) pour la politique heavy avant runners"
fi
systemctl start dev-zram0.swap 2>/dev/null || true
[ -x /usr/local/bin/mem0-rs ] && systemctl enable --now omp-harness-mem0.service || echo "· oracle non démarré : mem0-rs absent"

if grep -q '"repos": \[\s*\]' /etc/omp-harness/config.json || grep -q '"mon-produit"' /etc/omp-harness/config.json; then
  echo
  echo "Installé. La suite (omp-harness/README.md § Installer le serveur) :"
  echo "  1. Clé de déploiement AVEC écriture, sur chaque dépôt :"
  echo "       $(cat /var/lib/omp-harness/.ssh/id_ed25519.pub)"
  echo "  2. sudo -u omp-harness git clone --bare git@github.com:<toi>/<dépôt>.git /var/lib/omp-harness/repos/<dépôt>"
  echo "  3. sudoedit /etc/omp-harness/config.json : repos, models"
  echo "  4. Comptes LLM : ANTHROPIC_API_KEY=… dans /etc/omp-harness/runner.env, ou sudo -u omp-runner -H omp --profile pipeline (/login)"
  echo "  5. OMLX_BASE_URL dans /etc/omp-harness/mem0.env, puis systemctl restart omp-harness-mem0"
  echo "  6. sudo omp-harness-check, puis systemctl enable --now omp-harness"
else
  systemctl enable omp-harness.service
  systemctl restart omp-harness.service
  echo
  echo "Mis à jour et redémarré. Vérifie : sudo omp-harness-check"
fi
