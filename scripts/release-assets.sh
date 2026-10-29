#!/usr/bin/env bash
# Construit les fichiers joints à chaque release GitHub (.github/workflows/release-assets.yml).
#
#   scripts/release-assets.sh mac          → OMP-Console-macOS.zip (le bundle .app)
#   scripts/release-assets.sh ios          → OMP-Console-iOS.ipa
#   scripts/release-assets.sh chrome       → omp-chrome.zip (l'extension Chrome du poste
#                                            de travail, construite par
#                                            scripts/chrome-extension.sh ; tout OS,
#                                            node ≥ 22.13, aucun secret)
#   scripts/release-assets.sh --plan mac|ios
#                                          → le mode de signature que prendrait la
#                                            construction, lu des seules variables
#                                            d'environnement ; ne construit rien et
#                                            tourne sur tout OS
#   scripts/release-assets.sh nettoyer     → retire le trousseau temporaire et les
#                                            profils installés (étape `if: always()`
#                                            du workflow ; sans rien à retirer, code 0)
#
# Chaque fichier est écrit dans omp-console/build/release-assets/ (ignoré par git),
# à côté de son empreinte `<fichier>.sha256` — l'extension aussi : le workflow
# téléverse ce seul dossier.
#
# Deux modes par app, choisis par la présence des secrets (variables
# d'environnement du même nom, passées par le workflow à la seule étape de
# construction) : TOUS posés → app signée ; AUCUN → mode d'avant, avec une ligne
# `⚠` ; un jeu partiel est une erreur qui nomme les manquants, jamais un repli
# silencieux.
#
# App Mac. L'app est assemblée par scripts/swift-app.sh --no-tests : les tests ont
# déjà tourné sur la PR (job macos-app-swift), la release ne refait que le bundle.
#  · secrets MACOS_DEVELOPER_ID_P12_BASE64, MACOS_DEVELOPER_ID_P12_PASSWORD,
#    NOTARY_API_KEY_ID, NOTARY_API_ISSUER_ID, NOTARY_API_KEY_P8_BASE64 : le
#    certificat Developer ID Application est importé dans un trousseau temporaire,
#    swift-app.sh signe avec lui (OMP_CODESIGN_IDENTITY), puis mem0-rs et le bundle
#    sont re-signés avec le runtime renforcé (`--options runtime`) et un horodatage
#    Apple (`--timestamp`), que la notarisation exige. Le bundle part chez Apple
#    (`xcrun notarytool submit --wait`, clé d'API App Store Connect), le ticket est
#    agrafé (`xcrun stapler staple`), puis `stapler validate` et
#    `spctl --assess --type execute` le vérifient : l'archive jointe est celle du
#    bundle AGRAFÉ, qui s'ouvre au premier double-clic, même hors ligne.
#    Aucun entitlement : l'app n'est pas sandboxée (donc ni
#    `com.apple.security.network.client` ni autre clé de bac à sable), le runtime
#    renforcé ne limite pas le lancement de processus fils (mem0-rs via launchctl,
#    git, le shell du terminal), aucune bibliothèque d'une autre équipe n'est
#    chargée (SwiftPM sans dépendance externe, mem0-rs lié statiquement : pas de
#    `disable-library-validation`), aucun JIT, ni micro ni caméra, ni Apple Events.
#  · sans ces secrets : signature ad hoc (ou d'une identité d'équipe du trousseau,
#    voir l'en-tête de swift-app.sh) ; macOS met l'app en quarantaine au
#    téléchargement (`xattr -dr com.apple.quarantine`), et Siri n'en exécute aucun
#    intent.
#
# App iOS, construite en Release pour un appareil.
#  · secrets IOS_SIGNING_P12_BASE64, IOS_SIGNING_P12_PASSWORD,
#    IOS_PROFILE_APP_BASE64 (com.omp.console.ios), IOS_PROFILE_WIDGETS_BASE64
#    (com.omp.console.ios.widgets, l'extension de widgets embarquée) et
#    IOS_TEAM_ID : signature MANUELLE passée en réglages de ligne de commande —
#    aucune équipe n'est écrite dans le pbxproj — puis `xcodebuild archive` et
#    `-exportArchive`. La méthode d'export vient de IOS_EXPORT_METHOD (variable de
#    dépôt, pas un secret) : `ad-hoc` (défaut, Xcode : release-testing) ou
#    `development` (Xcode : debugging) ; elle doit correspondre au certificat et
#    aux profils fournis.
#  · sans ces secrets : `xcodebuild build CODE_SIGNING_ALLOWED=NO`, IPA non signée,
#    à re-signer par un outil qui signe avec ton compte (Sideloadly, AltStore, ou
#    `xcrun` avec ton profil).
#
# Aucun secret n'est imprimé : les valeurs ne passent que par l'environnement et
# des fichiers du dossier de signature (mode 700, retiré en sortie), et le mot de
# passe du trousseau, tiré au hasard, est masqué dans les journaux d'Actions
# (`::add-mask::`).
#
# Codes de sortie : 0 fichier écrit (ou plan affiché, ou nettoyage fait), 1 échec,
# 2 non exécuté (hors macOS ou Xcode inutilisable).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"
OUT="$ROOT/omp-console/build/release-assets"

# Le dossier de signature : trousseau, clé d'API, profils, options d'export. Un
# chemin FIXE, pour que `nettoyer` (une autre invocation) le retrouve.
SIGNING_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
SIGNING_DIR="${SIGNING_DIR%/}/omp-release-signing"
KEYCHAIN="$SIGNING_DIR/omp-release.keychain-db"
PROFILS_INSTALLES="$SIGNING_DIR/profils-installes.txt"

# Les secrets de chaque app, tous ou aucun.
SECRETS_MAC="MACOS_DEVELOPER_ID_P12_BASE64 MACOS_DEVELOPER_ID_P12_PASSWORD NOTARY_API_KEY_ID NOTARY_API_ISSUER_ID NOTARY_API_KEY_P8_BASE64"
SECRETS_IOS="IOS_SIGNING_P12_BASE64 IOS_SIGNING_P12_PASSWORD IOS_PROFILE_APP_BASE64 IOS_PROFILE_WIDGETS_BASE64 IOS_TEAM_ID"

secrets_de() {
  if [ "$1" = mac ]; then echo "$SECRETS_MAC"; else echo "$SECRETS_IOS"; fi
}

# La valeur de la variable nommée $1, vide si elle n'est pas posée.
valeur() {
  local nom="$1"
  printf '%s' "${!nom:-}"
}

# L'empreinte, nommée par le seul nom du fichier : `shasum -c` la vérifie à côté du
# fichier téléchargé.
empreinte() {
  (cd "$OUT" && shasum -a 256 "$1" > "$1.sha256")
  echo "  ✓ $OUT/$1 (+ .sha256)"
}

# Le mode de signature de <app> : « signe » si tous ses secrets sont posés,
# « non-signe » si aucun ne l'est. Un jeu partiel sort en 1 en nommant les
# manquants : c'est une configuration à finir, pas un fork.
mode_de() {
  local app="$1" nom presents=0 manquants=""
  for nom in $(secrets_de "$app"); do
    if [ -n "$(valeur "$nom")" ]; then
      presents=$((presents + 1))
    else
      manquants="${manquants:+$manquants, }$nom"
    fi
  done
  if [ -z "$manquants" ]; then
    echo signe
  elif [ "$presents" -eq 0 ]; then
    echo non-signe
  else
    echo "✗ signature $app incomplète : secret(s) manquant(s) : $manquants — pose tous les secrets de l'app, ou aucun (PUBLISHING.md § Apps jointes aux releases)" >&2
    return 1
  fi
}

# La méthode d'export iOS, au nom qu'emploie Xcode 26.
methode_export() {
  case "${IOS_EXPORT_METHOD:-}" in
    "" | ad-hoc | release-testing) echo release-testing ;;
    development | debugging) echo debugging ;;
    *)
      echo "✗ IOS_EXPORT_METHOD inconnue : « ${IOS_EXPORT_METHOD} » (attendu : ad-hoc ou development)" >&2
      return 1
      ;;
  esac
}

# Le plan : une ligne `<app> : <mode>`, suivie d'un `⚠` sans signature.
plan() {
  local app="$1" mode methode
  mode="$(mode_de "$app")" || return 1
  if [ "$app" = mac ] && [ "$mode" = signe ]; then
    echo "mac : notarisée — Developer ID, runtime renforcé, xcrun notarytool puis stapler"
  elif [ "$app" = mac ]; then
    echo "mac : ad hoc — non notarisée"
    echo "  ⚠ app Mac NON notarisée : secrets absents ($(secrets_de mac | sed 's/ /, /g')) — macOS la mettra en quarantaine au téléchargement (xattr -dr com.apple.quarantine)"
  elif [ "$mode" = signe ]; then
    methode="$(methode_export)" || return 1
    echo "ios : signée — xcodebuild archive puis -exportArchive (méthode $methode)"
  else
    echo "ios : non signée"
    echo "  ⚠ IPA NON signée : secrets absents ($(secrets_de ios | sed 's/ /, /g')) — à re-signer avec ton compte Apple avant installation"
  fi
}

# Retire tout ce que la signature a posé : profils installés, trousseau (ce qui
# le sort aussi de la liste de recherche), dossier de signature. Idempotent.
nettoyer_signature() {
  local fichier
  if [ -f "$PROFILS_INSTALLES" ]; then
    while IFS= read -r fichier; do
      [ -n "$fichier" ] && rm -f "$fichier"
    done < "$PROFILS_INSTALLES"
  fi
  if [ -e "$KEYCHAIN" ] && command -v security >/dev/null 2>&1; then
    security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  fi
  rm -rf "$SIGNING_DIR"
}

app="${1:-}"
case "$app" in
  mac | ios | chrome) ;;
  --plan)
    case "${2:-}" in
      mac | ios) plan "$2" ;;
      *)
        echo "✗ usage : scripts/release-assets.sh --plan mac|ios" >&2
        exit 1
        ;;
    esac
    exit $?
    ;;
  nettoyer)
    if [ -e "$SIGNING_DIR" ]; then
      nettoyer_signature
      echo "  ✓ trousseau et profils de signature retirés ($SIGNING_DIR)"
    else
      echo "· rien à nettoyer : aucun dossier de signature ($SIGNING_DIR)"
    fi
    exit 0
    ;;
  *)
    echo "✗ usage : scripts/release-assets.sh mac|ios|chrome (ou --plan mac|ios, ou nettoyer)" >&2
    exit 1
    ;;
esac

# L'extension Chrome : ni Xcode ni signature, elle se construit sur tout OS. L'archive
# porte manifest.json à sa racine : c'est la forme qu'attend le Chrome Web Store, et
# décompressée, celle que prend « Charger l'extension non empaquetée ».
if [ "$app" = chrome ]; then
  ZIP_CHROME="omp-chrome.zip"
  mkdir -p "$OUT" || exit 1
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  if ! bash "$ROOT/scripts/chrome-extension.sh" "$STAGE/omp-chrome"; then
    echo "✗ construction de l'extension Chrome échouée (scripts/chrome-extension.sh)" >&2
    exit 1
  fi
  rm -f "$OUT/$ZIP_CHROME"
  if ! (cd "$STAGE/omp-chrome" && zip -qrX "$OUT/$ZIP_CHROME" .); then
    echo "✗ archive de l'extension Chrome échouée (zip)" >&2
    exit 1
  fi
  VERSION="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version))' "$STAGE/omp-chrome/manifest.json")"
  echo "  ✓ extension Chrome $VERSION"
  empreinte "$ZIP_CHROME"
  exit 0
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "· non exécuté : les apps ne se construisent que sous macOS ($(uname -s) détecté)"
  exit 2
fi

# Même résolution d'Xcode que scripts/ios-build.sh : DEVELOPER_DIR s'il est posé,
# sinon /Applications/Xcode.app.
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
if [ -z "${DEVELOPER_DIR:-}" ] || ! xcodebuild -showsdks >/dev/null 2>&1; then
  echo "· non exécuté : Xcode inutilisable (DEVELOPER_DIR, ou /Applications/Xcode.app)"
  exit 2
fi
export DEVELOPER_DIR

# Le plan d'abord : un jeu de secrets partiel échoue avant toute compilation.
MODE="$(mode_de "$app")" || exit 1
plan "$app" || exit 1

mkdir -p "$OUT"

STAGE=""
# shellcheck disable=SC2329 # appelée par le trap EXIT
fin() {
  [ -n "$STAGE" ] && rm -rf "$STAGE"
  [ "$MODE" = signe ] && nettoyer_signature
  return 0
}
trap fin EXIT

# Masque une valeur dérivée d'un secret dans les journaux d'Actions.
masquer() {
  [ "${GITHUB_ACTIONS:-}" = true ] && printf '::add-mask::%s\n' "$1"
  return 0
}

# decoder <secret> <fichier> : le secret base64 décodé dans le fichier.
decoder() {
  if ! valeur "$1" | base64 --decode > "$2" 2>/dev/null || [ ! -s "$2" ]; then
    echo "✗ $1 n'est pas du base64 lisible (encode le fichier : base64 -i <fichier> | pbcopy, puis colle le résultat dans le secret)" >&2
    return 1
  fi
  chmod 600 "$2"
}

# lire_cle <fichier> <clé[.sous-clé]> : la valeur d'une clé d'un plist XML ou d'un
# JSON (premier élément pour un tableau), vide si absente ou illisible. Un JSON
# précédé d'autres lignes est lu sur sa dernière ligne lisible.
lire_cle() {
  python3 - "$1" "$2" 2>/dev/null <<'PY'
import json, plistlib, sys
raw = open(sys.argv[1], "rb").read()
try:
    d = plistlib.loads(raw)
except Exception:
    d = {}
    for ligne in reversed(raw.decode("utf-8", "replace").splitlines()):
        try:
            d = json.loads(ligne)
            break
        except ValueError:
            continue
for cle in sys.argv[2].split("."):
    if isinstance(d, list):
        d = d[0] if d else ""
    d = d.get(cle, "") if isinstance(d, dict) else ""
if isinstance(d, list):
    d = d[0] if d else ""
print(d if isinstance(d, str) else "")
PY
}

# preparer_trousseau <secret .p12> <secret mot de passe> : un trousseau neuf, au
# mot de passe aléatoire, déverrouillé, en tête de la liste de recherche, où le
# certificat et sa clé sont importés pour codesign sans dialogue d'autorisation.
preparer_trousseau() {
  local p12="$SIGNING_DIR/certificat.p12" mdp ligne
  local existants=()
  nettoyer_signature
  if ! mkdir -p "$SIGNING_DIR" || ! chmod 700 "$SIGNING_DIR"; then
    echo "✗ dossier de signature impossible à créer ($SIGNING_DIR)" >&2
    return 1
  fi
  decoder "$1" "$p12" || return 1
  mdp="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  masquer "$mdp"
  if ! security create-keychain -p "$mdp" "$KEYCHAIN" >/dev/null 2>&1 \
    || ! security set-keychain-settings -lut 21600 "$KEYCHAIN" >/dev/null 2>&1 \
    || ! security unlock-keychain -p "$mdp" "$KEYCHAIN" >/dev/null 2>&1; then
    echo "✗ trousseau temporaire impossible à créer ($KEYCHAIN)" >&2
    return 1
  fi
  if ! security import "$p12" -k "$KEYCHAIN" -P "$(valeur "$2")" -f pkcs12 \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>&1; then
    rm -f "$p12"
    echo "✗ import du certificat refusé : mot de passe faux ($2), ou .p12 exporté sans sa clé privée ($1)" >&2
    return 1
  fi
  rm -f "$p12"
  if ! security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$mdp" "$KEYCHAIN" >/dev/null 2>&1; then
    echo "✗ accès de codesign à la clé privée refusé (security set-key-partition-list)" >&2
    return 1
  fi
  while IFS= read -r ligne; do
    ligne="${ligne#"${ligne%%[![:space:]]*}"}"
    ligne="${ligne#\"}"
    ligne="${ligne%\"}"
    [ -n "$ligne" ] && existants+=("$ligne")
  done < <(security list-keychains -d user 2>/dev/null)
  security list-keychains -d user -s "$KEYCHAIN" ${existants[@]+"${existants[@]}"} >/dev/null 2>&1
  echo "  ✓ certificat importé dans un trousseau temporaire"
}

# identite <motif> : « <sha-1> <nom> » de la première identité valide du trousseau
# temporaire dont le nom commence par le motif (ERE).
identite() {
  security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null \
    | sed -nE "s/^ *[0-9]+\) ([0-9A-Fa-f]{40}) \"(($1)[^\"]*)\"\$/\1 \2/p" \
    | sed -n '1p'
}

# ── App Mac ───────────────────────────────────────────────────────────────────

BUNDLE="$ROOT/omp-console/build/OMP Console.app"

# Re-signe mem0-rs puis le bundle avec le runtime renforcé et l'horodatage, puis
# prouve l'un et l'autre (la notarisation refuserait sans eux).
signer_pour_notarisation() {
  local id="$1" code details
  local mem0="$BUNDLE/Contents/Resources/mem0-rs"
  for code in "$mem0" "$BUNDLE"; do
    if ! codesign --force --timestamp --options runtime --sign "$id" "$code"; then
      echo "✗ signature Developer ID échouée : $code (codesign --options runtime --timestamp)" >&2
      return 1
    fi
  done
  if ! codesign --verify --strict --deep "$BUNDLE"; then
    echo "✗ vérification de signature échouée (codesign --verify --strict --deep \"$BUNDLE\")" >&2
    return 1
  fi
  # La sortie est lue en entier AVANT grep : `grep -q` fermerait le tube au premier
  # résultat, et sous pipefail le SIGPIPE de codesign ferait échouer le test.
  for code in "$mem0" "$BUNDLE"; do
    details="$(codesign -dv "$code" 2>&1)"
    if ! printf '%s\n' "$details" | grep -qE 'flags=0x[0-9a-fA-F]+\([^)]*runtime'; then
      echo "✗ runtime renforcé absent de la signature de $code (codesign -dv : aucun drapeau runtime) — notarytool le refuserait" >&2
      return 1
    fi
  done
  echo "  ✓ signé Developer ID, runtime renforcé et horodatage (mem0-rs, puis le bundle)"
}

# Soumet le bundle à Apple, attend le verdict, agrafe le ticket et le vérifie.
notariser() {
  local p8="$SIGNING_DIR/AuthKey.p8" zip="$SIGNING_DIR/notarisation.zip"
  local resultat="$SIGNING_DIR/notarytool.json" erreurs="$SIGNING_DIR/notarytool.err"
  local id statut evaluation
  decoder NOTARY_API_KEY_P8_BASE64 "$p8" || return 1
  local auth=(--key "$p8" --key-id "$NOTARY_API_KEY_ID" --issuer "$NOTARY_API_ISSUER_ID")
  rm -f "$zip"
  if ! ditto -c -k --keepParent "$BUNDLE" "$zip"; then
    echo "✗ archive à notariser échouée (ditto)" >&2
    return 1
  fi
  echo "  · notarisation : soumission à Apple (xcrun notarytool submit --wait, 30 min au plus)"
  xcrun notarytool submit "$zip" "${auth[@]}" --wait --timeout 30m --output-format json > "$resultat" 2> "$erreurs"
  id="$(lire_cle "$resultat" id)"
  statut="$(lire_cle "$resultat" status)"
  if [ -z "$id" ]; then
    echo "✗ soumission à notarytool échouée, aucune soumission créée — vérifie NOTARY_API_KEY_ID, NOTARY_API_ISSUER_ID, NOTARY_API_KEY_P8_BASE64 (clé d'API App Store Connect, rôle Developer, non révoquée) :" >&2
    cat "$erreurs" >&2
    return 1
  fi
  if [ "$statut" = "In Progress" ]; then
    echo "✗ notarisation non terminée en 30 min (soumission $id) : Apple traite encore ; relance Actions › release-assets › Run workflow avec ce tag, ou suis-la par xcrun notarytool info $id" >&2
    return 1
  fi
  if [ "$statut" != Accepted ]; then
    echo "✗ notarisation refusée par Apple (statut ${statut:-illisible}, soumission $id). Journal de notarytool :" >&2
    if ! xcrun notarytool log "$id" "${auth[@]}" >&2; then
      echo "  (journal indisponible : xcrun notarytool log $id avec la même clé d'API)" >&2
    fi
    echo "  → chaque entrée « issues » du journal nomme le fichier refusé et la cause (signature, runtime renforcé, horodatage, entitlement) ; corrige-la, puis relance Actions › release-assets › Run workflow avec ce tag" >&2
    return 1
  fi
  echo "  ✓ notarisation acceptée (soumission $id)"
  if ! xcrun stapler staple "$BUNDLE"; then
    echo "✗ agrafage du ticket échoué (xcrun stapler staple)" >&2
    return 1
  fi
  if ! xcrun stapler validate "$BUNDLE"; then
    echo "✗ ticket agrafé invalide (xcrun stapler validate)" >&2
    return 1
  fi
  if ! evaluation="$(spctl --assess --type execute -vv "$BUNDLE" 2>&1)"; then
    echo "✗ Gatekeeper refuse le bundle agrafé (spctl --assess --type execute -vv) :" >&2
    printf '%s\n' "$evaluation" >&2
    return 1
  fi
  printf '%s\n' "$evaluation" | sed 's/^/    /'
  echo "  ✓ ticket agrafé, accepté par Gatekeeper"
}

if [ "$app" = mac ]; then
  ZIP="OMP-Console-macOS.zip"
  if [ "$MODE" = signe ]; then
    preparer_trousseau MACOS_DEVELOPER_ID_P12_BASE64 MACOS_DEVELOPER_ID_P12_PASSWORD || exit 1
    ligne="$(identite 'Developer ID Application: ')"
    if [ -z "$ligne" ]; then
      echo "✗ MACOS_DEVELOPER_ID_P12_BASE64 ne contient aucune identité « Developer ID Application » valide (un certificat « Apple Development » ou « Apple Distribution » ne se notarise pas)" >&2
      exit 1
    fi
    ID_SHA="${ligne%% *}"
    if ! OMP_CODESIGN_IDENTITY="$ID_SHA" bash "$ROOT/scripts/swift-app.sh" --no-tests; then
      echo "✗ assemblage de l'app Mac échoué (scripts/swift-app.sh --no-tests)" >&2
      exit 1
    fi
    signer_pour_notarisation "$ID_SHA" || exit 1
    notariser || exit 1
  elif ! bash "$ROOT/scripts/swift-app.sh" --no-tests; then
    echo "✗ assemblage de l'app Mac échoué (scripts/swift-app.sh --no-tests)" >&2
    exit 1
  fi
  rm -f "$OUT/$ZIP"
  # `ditto` garde les droits d'exécution, la signature et le ticket agrafé, que zip
  # perdrait.
  if ! ditto -c -k --keepParent "$BUNDLE" "$OUT/$ZIP"; then
    echo "✗ archive de l'app Mac échouée (ditto)" >&2
    exit 1
  fi
  empreinte "$ZIP"
  exit 0
fi

# ── App iOS ───────────────────────────────────────────────────────────────────

IPA="OMP-Console-iOS.ipa"
DERIVED="$ROOT/omp-console/build/ios-derived"
PROJECT=omp-console/ios/OMPConsoleIOS.xcodeproj
BUNDLE_ID_APP=com.omp.console.ios
BUNDLE_ID_WIDGETS=com.omp.console.ios.widgets

# installer_profil <secret> <bundle id> : décode le profil, vérifie qu'il vise
# <équipe>.<bundle id>, l'installe là où Xcode les cherche et imprime son UUID.
installer_profil() {
  local brut="$SIGNING_DIR/$2.mobileprovision" plist="$SIGNING_DIR/$2.plist"
  local uuid appid dossier
  decoder "$1" "$brut" || return 1
  if ! security cms -D -i "$brut" > "$plist" 2>/dev/null; then
    echo "✗ $1 n'est pas un profil de provisionnement (security cms -D refuse le fichier)" >&2
    return 1
  fi
  uuid="$(lire_cle "$plist" UUID)"
  appid="$(lire_cle "$plist" Entitlements.application-identifier)"
  if ! printf '%s' "$uuid" | grep -qE '^[0-9A-Fa-f-]{36}$'; then
    echo "✗ $1 : profil sans UUID lisible" >&2
    return 1
  fi
  if [ "$appid" != "$IOS_TEAM_ID.$2" ]; then
    echo "✗ $1 : le profil vise « ${appid:-rien} », attendu « $IOS_TEAM_ID.$2 » (un profil par cible : l'app et l'extension de widgets)" >&2
    return 1
  fi
  for dossier in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
    mkdir -p "$dossier" && cp "$brut" "$dossier/$uuid.mobileprovision" || return 1
    echo "$dossier/$uuid.mobileprovision" >> "$PROFILS_INSTALLES"
  done
  echo "$uuid"
}

# Échappement XML d'une valeur écrite dans ExportOptions.plist.
xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

if [ "$MODE" = signe ]; then
  METHODE="$(methode_export)" || exit 1
  if ! printf '%s' "$IOS_TEAM_ID" | grep -qE '^[A-Z0-9]{10}$'; then
    echo "✗ IOS_TEAM_ID n'est pas un identifiant d'équipe Apple (10 caractères, majuscules et chiffres)" >&2
    exit 1
  fi
  preparer_trousseau IOS_SIGNING_P12_BASE64 IOS_SIGNING_P12_PASSWORD || exit 1
  ligne="$(identite '(Apple|iPhone) (Distribution|Development|Developer): ')"
  if [ -z "$ligne" ]; then
    echo "✗ IOS_SIGNING_P12_BASE64 ne contient aucune identité iOS valide (« Apple Distribution » pour ad-hoc, « Apple Development » pour development)" >&2
    exit 1
  fi
  ID_NOM="${ligne#* }"
  UUID_APP="$(installer_profil IOS_PROFILE_APP_BASE64 "$BUNDLE_ID_APP")" || exit 1
  UUID_WIDGETS="$(installer_profil IOS_PROFILE_WIDGETS_BASE64 "$BUNDLE_ID_WIDGETS")" || exit 1
  echo "  ✓ profils installés (app $UUID_APP, widgets $UUID_WIDGETS)"

  ARCHIVE="$ROOT/omp-console/build/OMPConsoleIOS.xcarchive"
  EXPORT="$ROOT/omp-console/build/ios-export"
  rm -rf "$ARCHIVE" "$EXPORT"
  # Signature manuelle en réglages de ligne de commande, rien dans le pbxproj :
  # chaque cible choisit son profil par son nom, `$(OMP_PROFILE_$(TARGET_NAME))`
  # étant évalué cible par cible (les cibles du paquet ConsoleCore, des
  # bibliothèques statiques, ne sont pas signées).
  # shellcheck disable=SC2016 # la macro est pour Xcode, pas pour le shell
  if ! xcodebuild archive \
    -project "$PROJECT" \
    -scheme OMPConsoleIOS \
    -configuration Release \
    -destination "generic/platform=iOS" \
    -derivedDataPath "$DERIVED" \
    -archivePath "$ARCHIVE" \
    CODE_SIGN_STYLE=Manual \
    "DEVELOPMENT_TEAM=$IOS_TEAM_ID" \
    "CODE_SIGN_IDENTITY=$ID_NOM" \
    "OMP_PROFILE_OMPConsoleIOS=$UUID_APP" \
    "OMP_PROFILE_OMPConsoleWidgets=$UUID_WIDGETS" \
    'PROVISIONING_PROFILE_SPECIFIER=$(OMP_PROFILE_$(TARGET_NAME))'; then
    echo "✗ archive signée de l'app iOS échouée (xcodebuild archive) : certificat, profils et IOS_TEAM_ID doivent être de la même équipe, et les profils couvrir les capacités des entitlements (groupe d'apps, notifications)" >&2
    exit 1
  fi
  OPTIONS="$SIGNING_DIR/ExportOptions.plist"
  cat > "$OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>$METHODE</string>
	<key>teamID</key>
	<string>$IOS_TEAM_ID</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>signingCertificate</key>
	<string>$(xml "$ID_NOM")</string>
	<key>provisioningProfiles</key>
	<dict>
		<key>$BUNDLE_ID_APP</key>
		<string>$UUID_APP</string>
		<key>$BUNDLE_ID_WIDGETS</key>
		<string>$UUID_WIDGETS</string>
	</dict>
	<key>thinning</key>
	<string>&lt;none&gt;</string>
</dict>
</plist>
PLIST
  if ! xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$OPTIONS" -exportPath "$EXPORT"; then
    echo "✗ export de l'IPA signée échoué (xcodebuild -exportArchive, méthode $METHODE) : la méthode doit correspondre au type des profils" >&2
    exit 1
  fi
  EXPORTEE="$(find "$EXPORT" -maxdepth 1 -name '*.ipa' -type f | sed -n '1p')"
  if [ -z "$EXPORTEE" ]; then
    echo "✗ aucune IPA dans $EXPORT après l'export" >&2
    exit 1
  fi
  # La preuve est la signature de l'app exportée, pas le code de xcodebuild.
  STAGE="$(mktemp -d)"
  if ! unzip -q "$EXPORTEE" -d "$STAGE" \
    || ! codesign --verify --strict --deep "$STAGE/Payload/OMPConsoleIOS.app"; then
    echo "✗ l'IPA exportée ne porte pas de signature valide (codesign --verify --strict --deep)" >&2
    exit 1
  fi
  EQUIPE="$(codesign -dv "$STAGE/Payload/OMPConsoleIOS.app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  if [ "$EQUIPE" != "$IOS_TEAM_ID" ]; then
    echo "✗ l'IPA exportée est signée par l'équipe « ${EQUIPE:-aucune} », attendu IOS_TEAM_ID" >&2
    exit 1
  fi
  rm -f "$OUT/$IPA"
  cp "$EXPORTEE" "$OUT/$IPA" || exit 1
  echo "  ✓ IPA signée (méthode $METHODE), signature vérifiée"
  empreinte "$IPA"
  exit 0
fi

if ! xcodebuild build \
  -project "$PROJECT" \
  -scheme OMPConsoleIOS \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO; then
  echo "✗ compilation Release de l'app iOS échouée" >&2
  exit 1
fi
APP="$DERIVED/Build/Products/Release-iphoneos/OMPConsoleIOS.app"
if [ ! -d "$APP" ]; then
  echo "✗ app iOS introuvable après compilation : $APP" >&2
  exit 1
fi

# Une IPA est une archive zip dont la racine est `Payload/<app>.app`.
STAGE="$(mktemp -d)"
mkdir "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
rm -f "$OUT/$IPA"
if ! (cd "$STAGE" && zip -qry "$OUT/$IPA" Payload); then
  echo "✗ archive de l'IPA échouée (zip)" >&2
  exit 1
fi
empreinte "$IPA"
exit 0
