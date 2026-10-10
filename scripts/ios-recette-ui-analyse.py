#!/usr/bin/env python3
"""Analyseur de la recette idb d'omp-console iOS (ios-recette-ui-automatisee-idb).

Analyseur PUR : il lit des relevés déjà pris (un JSON `idb ui describe-all --json`
et une capture PNG par surface et par configuration) et rend un verdict. Il ne
parle ni à simctl ni à idb ; c'est `scripts/ios-recette-ui.sh` qui relève et qui
l'appelle. stdlib seule (les PNG sont décodés par `lire_colonnes_png`).

Sous-commandes :
  marqueur <surface> <fichier.json>
      Sortie 0 si le marqueur de la surface est vrai dans ce relevé, 1 sinon.
      Aucune sortie texte (2 + message sur stderr si la surface est inconnue).
  analyser --exceptions <f> --valider-seulement
      Valide seulement la liste d'exceptions : 0 si valide, 2 + message sinon.
  analyser --releves <dossier> --exceptions <f> --rapport <fichier.txt>
      Valide les exceptions, exige les 24 paires <surface>-<apparence>-<taille>
      .json|.png, vérifie les marqueurs et le contrôle « appairé », applique les
      trois règles de défaut, écrit le rapport. Sortie 0 (aucun SIGNALÉ),
      1 (au moins un SIGNALÉ), 2 (la recette n'a pas pu conclure).

Règles de défaut (relevé par relevé, l'élément Application est exclu) :
  cible-44     un contrôle interactif dont un côté arrondi à 0,1 pt est < 44 pt
               (Apple HIG, Buttons : zone de toucher d'au moins 44 x 44 pt) ;
  id-duplique  un AXUniqueId non vide porté par au moins 2 éléments (une ligne
               par élément) ;
  bord         un élément (source ax) ou une plage de pixels de la capture
               (source capture, sections seulement) collé au bord de l'écran.

Les noms de fichier cités dans « relevé manquant » et « relevé invalide » sont
ceux du fichier fautif, extension comprise.
"""
import argparse
import json
import os
import re
import struct
import sys
import zlib

# ── Constantes ────────────────────────────────────────────────────────────────

# (clé, est une section). Seule `kanban-fiche` est une feuille : son fond touche
# les bords par construction, la règle bord/capture ne s'y applique pas.
SURFACES = [
    ("home", True),
    ("kanban", True),
    ("project", True),
    ("session", True),
    ("sessions", True),
    ("memory", True),
    ("stats", True),
    ("kanban-fiche", False),
]
SURFACE_KEYS = [s for s, _ in SURFACES]
SECTION_SURFACES = {s for s, est_section in SURFACES if est_section}

# (apparence, taille)
CONFIGS = [("clair", "defaut"), ("sombre", "defaut"), ("clair", "ax-xl")]
APPARENCES = ("clair", "sombre")
TAILLES = ("defaut", "ax-xl")

INTERACTIFS = {
    "Button", "PopUpButton", "Link", "TextField", "SecureTextField", "SearchField",
    "Switch", "Toggle", "Slider", "Stepper", "SegmentedControl", "CheckBox",
    "RadioButton", "MenuButton", "ComboBox",
}

CIBLE_MIN = 44        # pt, IOSMetrics.minimumTarget
TOLERANCE_BORD = 0.5  # pt, bord AX
Y_FOND = 30           # pt, ligne de l'échantillon de fond de la capture
ECART_PIXEL = 6       # écart absolu maximal sur R, G ou B pour « même fond »
PLAGE_MIN = 44        # pt, longueur minimale d'une plage de bord (capture)

REGLES = ("cible-44", "id-duplique", "bord")
SOURCES = ("ax", "capture")
CLES_EXCEPTION = ("surface", "apparence", "taille", "regle", "source", "element", "justification")

# Entrées protégées : elles masqueraient un défaut visé par l'audit.
PROTEGES_CIBLE_44 = {
    "id:ios.home.allPipelines",
    "id:ios.projet.start",
    "libellé:Tout afficher",
    "libellé:Lire le contrat",
    "libellé:Piloter un projet…",
    "id:ios.connexion.connect",
    "id:ios.memoire.retry",
    "id:ios.memoire.graphe.etiquette",
}
PROTEGE_CONTRAT = re.compile(r"^id:ios\.home\.attention\..+\.contract$")
PROTEGE_OUVRIR_PR = re.compile(r"^id:ios\.home\.delivered\.open\..+$")
PROTEGES_ID_DUPLIQUE = {"id:pipelines.card.sheet.title", "id:ios.memoire.screen"}
PROTEGES_BORD_CAPTURE = {"kanban", "sessions", "memory", "*"}

LIBELLE_NON_APPAIRE = "Non appairé"
MSG_APPAIRE = "simulateur appairé : la recette exige un simulateur jamais appairé au Mac"


class Echec(Exception):
    """La recette ne peut pas conclure : message sur stderr, sortie 2."""


# ── Lecture d'un relevé ───────────────────────────────────────────────────────

def _texte(valeur):
    return valeur if isinstance(valeur, str) else ""


def charger_arbre(chemin):
    """Tableau d'éléments (dicts) d'un JSON idb ; None si illisible."""
    try:
        with open(chemin, encoding="utf-8") as f:
            donnees = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(donnees, list):
        return None
    return [e for e in donnees if isinstance(e, dict)]


def cadre(element):
    """(x, y, largeur, hauteur) en points, ou None si le cadre est absent."""
    f = element.get("frame")
    if not isinstance(f, dict):
        return None
    try:
        return tuple(float(f[k]) for k in ("x", "y", "width", "height"))
    except (KeyError, TypeError, ValueError):
        return None


def application(arbre):
    for e in arbre:
        if e.get("type") == "Application":
            return e
    return None


def taille_ecran(arbre):
    """(W, H) du premier élément Application, ou None."""
    app = application(arbre)
    c = cadre(app) if app else None
    if c is None or c[2] <= 0 or c[3] <= 0:
        return None
    return c[2], c[3]


def elements_regles(arbre):
    """Éléments soumis aux règles : tout sauf Application, ordre de l'arbre."""
    return [e for e in arbre if e.get("type") != "Application"]


def designation(element):
    """id:<AXUniqueId>, sinon libellé:<AXLabel>, sinon type:<type>.

    Les ruptures de ligne et tabulations sont remplacées par une espace : la
    désignation figure telle quelle dans le rapport (une ligne par signalement,
    champs séparés par des tabulations) ET sert à la correspondance des exceptions.
    """
    ident = _texte(element.get("AXUniqueId"))
    if ident:
        texte = "id:" + ident
    else:
        libelle = _texte(element.get("AXLabel"))
        texte = "libellé:" + libelle if libelle else "type:" + str(element.get("type"))
    return re.sub(r"[\t\r\n]", " ", texte)


# ── Marqueurs (S-2) ───────────────────────────────────────────────────────────

def _ids(arbre):
    return [_texte(e.get("AXUniqueId")) for e in arbre]


def _marqueur_propre(surface, arbre):
    ids = _ids(arbre)
    libelles = [_texte(e.get("AXLabel")) for e in arbre]
    titres = [_texte(e.get("AXLabel")) for e in arbre if e.get("type") == "Heading"]
    fiche = any(i.startswith("pipelines.card.sheet") for i in ids)
    if surface == "home":
        return "ios.home.allPipelines" in ids
    if surface == "kanban":
        return not fiche and any(i.startswith("pipelines.") for i in ids)
    if surface == "project":
        # Non appairé, l'écran Projet n'expose que « Non appairé » et sa barre de
        # navigation, dont l'identifiant est le titre (MESURÉ iOS 27, iPhone).
        return (
            "ios.screen.project" in ids
            or any(i.startswith("ios.projet") for i in ids)
            or "Projet" in titres
            or "Projet" in ids
        )
    if surface == "session":
        return any(i.startswith("ios.sessionomp") for i in ids)
    if surface == "sessions":
        return any(l.startswith("parity-session-1") for l in libelles)
    if surface == "memory":
        return any(i.startswith("ios.memoire.") for i in ids)
    if surface == "stats":
        return (
            any(i.startswith("ios.stats") for i in ids)
            or "ios.screen.stats" in ids
            or "Statistiques" in titres
        )
    if surface == "kanban-fiche":
        return fiche
    raise Echec("surface inconnue : " + surface)


# Les écrans pleins de l'état de connexion partagé (IOSConnectionStateView, #118) :
# conteneurs « non connecté » et « connexion en cours », plus leurs feuilles propres
# à la forme plein écran (la cause, l'indicateur d'attente), car idb ne rend pas
# toujours les conteneurs. Les bandeaux, posés au-dessus de données conservées,
# n'excluent rien.
ECRANS_NON_CONNECTES = (
    "ios.connexion.horsLigne.ecran",
    "ios.connexion.enCours.ecran",
    "ios.connexion.cause",
    "ios.connexion.attente",
)


def marqueur(surface, arbre):
    """Vrai si l'arbre montre la surface annoncée (ni la racine, ni un écran plein
    « non connecté » ou « connexion en cours »)."""
    ids = _ids(arbre)
    if any(i.startswith("ios.section.") for i in ids):
        return False
    if any(i in ids for i in ECRANS_NON_CONNECTES):
        return False
    return _marqueur_propre(surface, arbre)


# ── Exceptions (S-4) ──────────────────────────────────────────────────────────

def _chaine(valeur):
    return isinstance(valeur, str)


def valider_exceptions(chemin):
    """Liste des entrées validées ; lève Echec avec le message de S-4 sinon."""
    try:
        with open(chemin, encoding="utf-8") as f:
            donnees = json.load(f)
    except OSError as e:
        raise Echec("exceptions invalides : %s : %s" % (chemin, e.strerror or e))
    except ValueError as e:
        raise Echec("exceptions invalides : %s : JSON invalide (%s)" % (chemin, e))
    if not isinstance(donnees, list):
        raise Echec("exceptions invalides : %s : un tableau JSON est attendu" % chemin)
    for n, entree in enumerate(donnees, start=1):
        _valider_entree(n, entree)
    return donnees


def _invalide(n, cle, raison):
    return Echec("exception %d invalide : %s %s" % (n, cle, raison))


def _valider_entree(n, e):
    if not isinstance(e, dict):
        raise _invalide(n, "entrée", "doit être un objet")
    for cle in CLES_EXCEPTION:
        if cle not in e:
            raise _invalide(n, cle, "est absente")
    for cle in e:
        if cle not in CLES_EXCEPTION:
            raise _invalide(n, cle, "n'est pas une clé permise")

    def enum(cle, permis):
        if not _chaine(e[cle]) or e[cle] not in permis:
            raise _invalide(n, cle, "doit valoir l'une de : " + ", ".join(permis))

    enum("surface", SURFACE_KEYS + ["*"])
    enum("apparence", list(APPARENCES) + ["*"])
    enum("taille", list(TAILLES) + ["*"])
    enum("regle", REGLES)
    enum("source", SOURCES)
    if e["source"] == "capture" and e["regle"] != "bord":
        raise _invalide(n, "source", "capture n'est permise qu'avec la règle bord")
    el = e["element"]
    if not _chaine(el) or not any(
        el.startswith(p) and len(el) > len(p) for p in ("id:", "libellé:", "type:")
    ):
        raise _invalide(n, "element", "doit commencer par id:, libellé: ou type: suivi d'un texte non vide")
    if not _chaine(e["justification"]) or not e["justification"].strip():
        raise _invalide(n, "justification", "doit être une chaîne non vide")
    if _protegee(e):
        raise Echec(
            "exception %d interdite : elle masquerait un défaut visé par l'audit (AC-2, AC-3 ou AC-4)" % n
        )


def _protegee(e):
    if e["regle"] == "cible-44":
        return (
            e["element"] in PROTEGES_CIBLE_44
            or bool(PROTEGE_CONTRAT.match(e["element"]))
            or bool(PROTEGE_OUVRIR_PR.match(e["element"]))
        )
    if e["regle"] == "id-duplique":
        return e["element"] in PROTEGES_ID_DUPLIQUE
    if e["regle"] == "bord":
        return e["source"] == "capture" and e["surface"] in PROTEGES_BORD_CAPTURE
    return False


# ── Règles (S-3) ──────────────────────────────────────────────────────────────

class Signalement:
    __slots__ = ("surface", "apparence", "taille", "regle", "source", "element", "cadre")

    def __init__(self, surface, apparence, taille, regle, source, element, cadre_):
        self.surface = surface
        self.apparence = apparence
        self.taille = taille
        self.regle = regle
        self.source = source
        self.element = element
        self.cadre = cadre_


def _nombre(v):
    """Une décimale, point décimal, jamais « -0.0 »."""
    return "%.1f" % (round(v, 1) + 0.0)


def _texte_cadre(c):
    return "%s,%s,%sx%s" % tuple(_nombre(v) for v in c)


def regle_cible_44(arbre):
    for e in elements_regles(arbre):
        c = cadre(e)
        if c is None or e.get("type") not in INTERACTIFS:
            continue
        if round(c[2], 1) < CIBLE_MIN or round(c[3], 1) < CIBLE_MIN:
            yield e, c


def regle_id_duplique(arbre):
    elements = elements_regles(arbre)
    compte = {}
    for e in elements:
        ident = _texte(e.get("AXUniqueId"))
        if ident:
            compte[ident] = compte.get(ident, 0) + 1
    for e in elements:
        ident = _texte(e.get("AXUniqueId"))
        if ident and compte[ident] >= 2:
            yield e, cadre(e) or (0.0, 0.0, 0.0, 0.0)


def regle_bord_ax(arbre, largeur):
    for e in elements_regles(arbre):
        c = cadre(e)
        if c is None or c[2] <= 0 or c[3] <= 0:
            continue
        if c[0] <= TOLERANCE_BORD or c[0] + c[2] >= largeur - TOLERANCE_BORD:
            yield e, c


def _plages(colonne, ref, echelle):
    """Plages maximales (début, longueur) en pixels de rangées qui diffèrent du fond."""
    plages = []
    debut = None
    for y, p in enumerate(colonne):
        differe = max(abs(p[0] - ref[0]), abs(p[1] - ref[1]), abs(p[2] - ref[2])) > ECART_PIXEL
        if differe and debut is None:
            debut = y
        elif not differe and debut is not None:
            plages.append((debut, y - debut))
            debut = None
    if debut is not None:
        plages.append((debut, len(colonne) - debut))
    return [(d, n) for d, n in plages if n / echelle >= PLAGE_MIN]


_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# Octets par pixel selon le type de couleur (profondeur 8 bits) : gris, RGB, gris+alpha, RGBA.
_PNG_OCTETS = {0: 1, 2: 3, 4: 2, 6: 4}


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def lire_png(chemin):
    """(largeur px, hauteur px, pixel) d'un PNG 8 bits non entrelacé (gris, RGB,
    gris+alpha ou RGBA) ; `pixel(x, y)` rend le triplet RGB du pixel. Décodage
    stdlib (zlib) : les captures de simctl, comme les PNG de test, en sont. Tout
    autre format lève ValueError."""
    with open(chemin, "rb") as f:
        donnees = f.read()
    if not donnees.startswith(_PNG_SIGNATURE):
        raise ValueError("pas un PNG")
    pos = len(_PNG_SIGNATURE)
    entete = None
    idat = []
    while pos + 8 <= len(donnees):
        longueur, genre = struct.unpack(">I4s", donnees[pos:pos + 8])
        corps = donnees[pos + 8:pos + 8 + longueur]
        pos += 12 + longueur
        if genre == b"IHDR":
            entete = struct.unpack(">IIBBBBB", corps)
        elif genre == b"IDAT":
            idat.append(corps)
        elif genre == b"IEND":
            break
    if entete is None:
        raise ValueError("PNG sans IHDR")
    px_l, px_h, profondeur, couleur, _, _, entrelace = entete
    if profondeur != 8 or couleur not in _PNG_OCTETS or entrelace != 0:
        raise ValueError("PNG non pris en charge (profondeur %d, couleur %d, entrelacé %d)" % (profondeur, couleur, entrelace))
    bpp = _PNG_OCTETS[couleur]
    pas = px_l * bpp
    brut = zlib.decompress(b"".join(idat))
    if len(brut) < (pas + 1) * px_h:
        raise ValueError("PNG tronqué")
    precedente = bytearray(pas)
    lignes = []
    for y in range(px_h):
        debut = y * (pas + 1)
        filtre = brut[debut]
        ligne = bytearray(brut[debut + 1:debut + 1 + pas])
        if filtre == 1:
            for i in range(bpp, pas):
                ligne[i] = (ligne[i] + ligne[i - bpp]) & 0xFF
        elif filtre == 2:
            for i in range(pas):
                ligne[i] = (ligne[i] + precedente[i]) & 0xFF
        elif filtre == 3:
            for i in range(pas):
                gauche_px = ligne[i - bpp] if i >= bpp else 0
                ligne[i] = (ligne[i] + ((gauche_px + precedente[i]) >> 1)) & 0xFF
        elif filtre == 4:
            for i in range(pas):
                a = ligne[i - bpp] if i >= bpp else 0
                c = precedente[i - bpp] if i >= bpp else 0
                ligne[i] = (ligne[i] + _paeth(a, precedente[i], c)) & 0xFF
        elif filtre != 0:
            raise ValueError("filtre PNG inconnu : %d" % filtre)
        lignes.append(ligne)
        precedente = ligne

    def pixel(x, y):
        ligne, i = lignes[y], x * bpp
        if bpp >= 3:
            return (ligne[i], ligne[i + 1], ligne[i + 2])
        return (ligne[i], ligne[i], ligne[i])

    return px_l, px_h, pixel


def lire_colonnes_png(chemin):
    """(largeur px, hauteur px, colonne gauche, colonne droite) d'un PNG décodé par
    `lire_png`, chaque colonne en triplets RGB."""
    px_l, px_h, pixel = lire_png(chemin)
    return (
        px_l,
        px_h,
        [pixel(0, y) for y in range(px_h)],
        [pixel(px_l - 1, y) for y in range(px_h)],
    )


def regle_bord_capture(arbre, largeur, chemin_png):
    """(côté, élément désigné ou None, cadre) pour chaque plage de bord de la capture."""
    px_l, px_h, gauche, droite = lire_colonnes_png(chemin_png)
    echelle = px_l / largeur
    y_ref = round(Y_FOND * echelle)
    if y_ref >= px_h:
        raise ValueError("capture trop basse")
    elements = elements_regles(arbre)
    pas = 1 / echelle
    for cote, colonne in (("gauche", gauche), ("droite", droite)):
        for debut, longueur in _plages(colonne, colonne[y_ref], echelle):
            y0, y1 = debut / echelle, (debut + longueur) / echelle
            x = 0.0 if cote == "gauche" else largeur - pas
            yield cote, _designe(elements, cote, y0, y1, largeur), (x, y0, pas, longueur / echelle)


def _designe(elements, cote, y0, y1, largeur):
    """L'élément le plus proche du bord parmi ceux qui ne couvrent pas toute la largeur."""
    meilleur = None
    for e in elements:
        c = cadre(e)
        if c is None:
            continue
        x, y, w, h = c
        if x <= TOLERANCE_BORD and x + w >= largeur - TOLERANCE_BORD:
            continue
        if not (y < y1 and y + h > y0):
            continue
        cle = x if cote == "gauche" else -(x + w)
        if meilleur is None or cle < meilleur[0]:
            meilleur = (cle, e)
    return meilleur[1] if meilleur else None


def signalements(surface, apparence, taille, arbre, chemin_png):
    """Signalements d'un relevé, dans l'ordre de S-3."""
    sortie = []
    largeur, _ = taille_ecran(arbre)

    def ajoute(regle, source, e, c):
        sortie.append(Signalement(surface, apparence, taille, regle, source, designation(e), c))

    for e, c in regle_cible_44(arbre):
        ajoute("cible-44", "ax", e, c)
    for e, c in regle_id_duplique(arbre):
        ajoute("id-duplique", "ax", e, c)
    for e, c in regle_bord_ax(arbre, largeur):
        ajoute("bord", "ax", e, c)
    if surface in SECTION_SURFACES:
        for _cote, e, c in regle_bord_capture(arbre, largeur, chemin_png):
            sortie.append(
                Signalement(
                    surface, apparence, taille, "bord", "capture",
                    designation(e) if e is not None else "type:capture", c,
                )
            )
    return sortie


# ── Verdict ───────────────────────────────────────────────────────────────────

def _correspond(entree, s):
    return (
        entree["surface"] in ("*", s.surface)
        and entree["apparence"] in ("*", s.apparence)
        and entree["taille"] in ("*", s.taille)
        and entree["regle"] == s.regle
        and entree["source"] == s.source
        and entree["element"] == s.element
    )


def _ligne(statut, s, extra=""):
    champs = [
        statut,
        "surface=" + s.surface,
        "apparence=" + s.apparence,
        "taille=" + s.taille,
        "regle=" + s.regle,
        "source=" + s.source,
        "element=" + s.element,
        "cadre=" + _texte_cadre(s.cadre),
    ]
    return "\t".join(champs) + extra


def analyser(dossier, exceptions, rapport):
    entrees = valider_exceptions(exceptions)

    nommes = [
        (surface, apparence, taille, "%s-%s-%s" % (surface, apparence, taille))
        for apparence, taille in CONFIGS
        for surface in SURFACE_KEYS
    ]
    # Ordre du rapport : surfaces, puis configurations.
    nommes.sort(key=lambda r: (SURFACE_KEYS.index(r[0]), CONFIGS.index((r[1], r[2]))))

    for _, _, _, base in nommes:
        for ext in (".json", ".png"):
            if not os.path.isfile(os.path.join(dossier, base + ext)):
                raise Echec("relevé manquant : " + base + ext)

    arbres = {}
    for _, _, _, base in nommes:
        arbre = charger_arbre(os.path.join(dossier, base + ".json"))
        if arbre is None or taille_ecran(arbre) is None:
            raise Echec("relevé invalide : " + base + ".json")
        arbres[base] = arbre

    for surface, apparence, taille, base in nommes:
        if not marqueur(surface, arbres[base]):
            raise Echec("surface non vérifiée : %s %s %s (marqueur absent)" % (surface, apparence, taille))

    for surface, _, _, base in nommes:
        if surface == "kanban" and not any(
            e.get("AXLabel") == LIBELLE_NON_APPAIRE for e in arbres[base]
        ):
            raise Echec(MSG_APPAIRE)

    tous = []
    for surface, apparence, taille, base in nommes:
        png = os.path.join(dossier, base + ".png")
        try:
            tous.extend(signalements(surface, apparence, taille, arbres[base], png))
        except Exception as e:  # PNG illisible ou incohérent avec l'arbre
            raise Echec("relevé invalide : %s.png (%s)" % (base, e))

    utilisees = set()
    lignes = []
    nb_signales = nb_exceptes = 0
    for s in tous:
        numero = next((n for n, en in enumerate(entrees, start=1) if _correspond(en, s)), None)
        if numero is None:
            nb_signales += 1
            lignes.append(_ligne("SIGNALÉ", s))
        else:
            nb_exceptes += 1
            utilisees.add(numero)
            justification = " ".join(entrees[numero - 1]["justification"].split())
            lignes.append(
                _ligne("EXCEPTÉ", s, "\texception=%d\tjustification=%s" % (numero, justification))
            )

    with open(rapport, "w", encoding="utf-8") as f:
        for ligne in lignes:
            f.write(ligne + "\n")

    print("rapport : " + rapport)
    print("%d signalé(s), %d excepté(s)" % (nb_signales, nb_exceptes))
    for n in range(1, len(entrees) + 1):
        if n not in utilisees:
            print("exception inutilisée : %d" % n)
    return 1 if nb_signales else 0


# ── Ligne de commande ─────────────────────────────────────────────────────────

class _Parseur(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "%s : %s\n" % (self.prog, message))


def main(argv):
    parseur = _Parseur(prog="ios-recette-ui-analyse.py", description=__doc__.split("\n")[0])
    sous = parseur.add_subparsers(dest="commande", required=True, parser_class=_Parseur)
    pm = sous.add_parser("marqueur")
    pm.add_argument("surface")
    pm.add_argument("fichier")
    pa = sous.add_parser("analyser")
    pa.add_argument("--exceptions", required=True)
    pa.add_argument("--valider-seulement", action="store_true")
    pa.add_argument("--releves")
    pa.add_argument("--rapport")
    args = parseur.parse_args(argv)

    try:
        if args.commande == "marqueur":
            if args.surface not in SURFACE_KEYS:
                raise Echec("surface inconnue : " + args.surface)
            arbre = charger_arbre(args.fichier)
            return 0 if arbre is not None and marqueur(args.surface, arbre) else 1
        if args.valider_seulement:
            valider_exceptions(args.exceptions)
            return 0
        if not args.releves or not args.rapport:
            raise Echec("analyser exige --releves et --rapport (ou --valider-seulement)")
        return analyser(args.releves, args.exceptions, args.rapport)
    except Echec as e:
        sys.stderr.write(str(e) + "\n")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
