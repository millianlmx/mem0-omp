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
SRC="$(cd "$HERE/.." && pwd)"
DEST=/opt/omp-harness

for tool in node git systemd-run systemctl choom sudo visudo; do
  command -v "$tool" >/dev/null || { echo "✗ $tool est requis" >&2; exit 1; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=6)?0:1)' \
  || { echo "✗ Node ≥ 22.6 requis (node:sqlite, --experimental-strip-types)" >&2; exit 1; }
command -v omp >/dev/null || echo "· omp introuvable dans le PATH : renseigne ompBin dans /etc/omp-harness/config.json"

echo "· users et groupe (sysusers)"
install -m 0644 "$HERE/sysusers.conf" /etc/sysusers.d/omp-harness.conf
systemd-sysusers /etc/sysusers.d/omp-harness.conf

echo "· arborescence (tmpfiles)"
install -m 0644 "$HERE/tmpfiles.conf" /etc/tmpfiles.d/omp-harness.conf
systemd-tmpfiles --create /etc/tmpfiles.d/omp-harness.conf

echo "· code du service → $DEST/omp-harness"
install -d -m 0755 "$DEST"
rm -rf "$DEST/omp-harness.new"
cp -a "$SRC" "$DEST/omp-harness.new"
rm -rf "$DEST/omp-harness"
mv "$DEST/omp-harness.new" "$DEST/omp-harness"
chown -R root:root "$DEST"

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

echo "· git : les worktrees changent de propriétaire entre service, runners et heavy"
for user in omp-harness omp-runner omp-heavy; do
  home="$(getent passwd "$user" | cut -d: -f6)"
  if ! sudo -u "$user" HOME="$home" git config --global --get-all safe.directory 2>/dev/null | grep -qx '\*'; then
    sudo -u "$user" HOME="$home" git config --global --add safe.directory '*'
  fi
done

echo "· tranches, service, zram, oomd"
install -m 0644 "$HERE/omp-harness.slice" "$HERE/omp-harness-runners.slice" "$HERE/omp-harness-heavy.slice" "$HERE/omp-harness.service" /etc/systemd/system/
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

if grep -q '"repos": \[\s*\]' /etc/omp-harness/config.json || grep -q '"mon-produit"' /etc/omp-harness/config.json; then
  echo
  echo "→ Édite /etc/omp-harness/config.json (dépôts, modèles), clone chaque dépôt dans /var/lib/omp-harness/repos/<nom>"
  echo "  (sudo -u omp-harness git clone --bare … ), puis : systemctl enable --now omp-harness"
else
  systemctl enable omp-harness.service
  systemctl restart omp-harness.service
fi

cat <<'EOT'

Étapes restantes :
  1. Connexion des runners aux fournisseurs LLM, dans LEUR profil :
       sudo -u omp-runner -H omp --profile pipeline   (puis /login)
     ou des clés d'API dans /etc/omp-harness/runner.env (ANTHROPIC_API_KEY=…, root 0600).
     Chaque dépôt cloné : sudo -u omp-harness git -C <dépôt> config core.sharedRepository 0640
     (le service le pose aussi au démarrage : les gitdirs restent illisibles en écriture au groupe).
  2. Le jeton de l'API : /var/lib/omp-harness/state/token (créé au premier démarrage).
  3. Publier l'API : tailscale serve --bg --https=443 http://127.0.0.1:8790
     (ou un reverse proxy TLS devant 127.0.0.1:8790).
EOT
