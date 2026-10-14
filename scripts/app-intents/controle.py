#!/usr/bin/env python3
"""Compare le Metadata.appintents d'un bundle à la liste attendue.

Usage : python3 scripts/app-intents/controle.py <mac|ios> <extract.actionsdata>

La liste attendue vit dans attendus.json, à côté de ce fichier : c'est le seul
endroit qui nomme les intents Siri et leurs phrases d'App Shortcut, lu par
scripts/swift-app.sh (bundle Mac) et scripts/ios-build.sh (app iOS). La
comparaison est une égalité exacte d'ensembles : intents, puis couples
(intent, phrase), chaînes comparées octet pour octet. Toute phrase du bundle
doit contenir ${applicationName}.

Codes de sortie : 0 conforme ; 1 pour tout écart, liste invalide, bundle
illisible ou usage erroné. Rien n'est écrit sur disque. Python 3.9, stdlib seule.
"""

import json
import sys
from pathlib import Path

ATTENDUS = Path(__file__).resolve().with_name("attendus.json")
ATTENDUS_AFFICHE = "scripts/app-intents/attendus.json"
JETON = "${applicationName}"
LIBELLES = {"mac": "Mac", "ios": "iOS"}


class Echec(Exception):
    """Une ligne ✗ déjà formée : le contrôle s'arrête sur elle."""


def ecrire(flux, ligne):
    # Les messages portent ’ « » — : on écrit l'UTF-8 sans dépendre de la locale.
    flux.buffer.write((ligne + "\n").encode("utf-8"))
    flux.flush()


def lire_json(chemin):
    with open(chemin, encoding="utf-8") as fichier:
        return json.load(fichier)


def raison_json(erreur):
    return "JSON invalide : %s (ligne %d, colonne %d)" % (erreur.msg, erreur.lineno, erreur.colno)


def liste_invalide(raison):
    return Echec("  ✗ liste attendue invalide : %s (%s)" % (ATTENDUS_AFFICHE, raison))


def lire_attendus():
    try:
        attendus = lire_json(ATTENDUS)
    except json.JSONDecodeError as erreur:
        raise liste_invalide(raison_json(erreur))
    except OSError:
        raise liste_invalide("fichier absent")
    if (
        not isinstance(attendus, dict)
        or set(attendus) != set(LIBELLES)
        or not all(isinstance(intents, dict) for intents in attendus.values())
    ):
        raise liste_invalide("clés de premier niveau attendues : ios, mac")
    for bundle, intents in attendus.items():
        vues = set()
        for type_intent, phrases in intents.items():
            if not isinstance(phrases, list) or not all(isinstance(p, str) for p in phrases):
                raise liste_invalide("%s.%s : liste de chaînes attendue" % (bundle, type_intent))
            for phrase in phrases:
                if JETON not in phrase:
                    raise liste_invalide(
                        "phrase sans %s : « %s » (%s.%s)" % (JETON, phrase, bundle, type_intent)
                    )
                if phrase in vues:
                    raise liste_invalide("phrase en double : « %s » (%s)" % (phrase, bundle))
                vues.add(phrase)
    return attendus


def lire_bundle(chemin):
    def illisible(raison):
        return Echec("  ✗ extract.actionsdata illisible : %s (%s)" % (chemin, raison))

    if not Path(chemin).is_file():
        raise illisible("fichier absent")
    try:
        donnees = lire_json(chemin)
    except json.JSONDecodeError as erreur:
        raise illisible(raison_json(erreur))
    except (OSError, UnicodeDecodeError):
        raise illisible("forme inattendue")
    if not isinstance(donnees, dict) or not isinstance(donnees.get("actions"), dict):
        raise illisible("forme inattendue")
    raccourcis = donnees.get("autoShortcuts", [])
    if not isinstance(raccourcis, list):
        raise illisible("forme inattendue")
    couples = set()
    for raccourci in raccourcis:
        if not isinstance(raccourci, dict) or not isinstance(raccourci.get("actionIdentifier"), str):
            raise illisible("forme inattendue")
        gabarits = raccourci.get("phraseTemplates", [])
        if not isinstance(gabarits, list):
            raise illisible("forme inattendue")
        for gabarit in gabarits:
            if not isinstance(gabarit, dict) or not isinstance(gabarit.get("key"), str):
                raise illisible("forme inattendue")
            couples.add((raccourci["actionIdentifier"], gabarit["key"]))
    return set(donnees["actions"]), couples


def pluriel(nombre, mot):
    return "%d %s%s" % (nombre, mot, "" if nombre == 1 else "s")


def comparer(bundle, chemin):
    libelle = LIBELLES[bundle]
    attendus = lire_attendus()[bundle]
    intents_attendus = set(attendus)
    couples_attendus = {(t, p) for t, phrases in attendus.items() for p in phrases}
    intents, couples = lire_bundle(chemin)

    sans_jeton = {c for c in couples if JETON not in c[1]}
    ecarts = []
    for t in sorted(intents_attendus - intents):
        ecarts.append(
            "  ✗ intent attendu absent du bundle %s : %s introuvable dans extract.actionsdata"
            % (libelle, t)
        )
    for t, p in sorted(couples_attendus - couples):
        ecarts.append(
            "  ✗ phrase attendue absente du bundle %s : « %s » (intent %s) introuvable dans extract.actionsdata"
            % (libelle, p, t)
        )
    for t in sorted(intents - intents_attendus):
        ecarts.append(
            "  ✗ intent non listé dans le bundle %s : %s — à ajouter à %s" % (libelle, t, ATTENDUS_AFFICHE)
        )
    for t, p in sorted(couples - couples_attendus - sans_jeton):
        ecarts.append(
            "  ✗ phrase non listée dans le bundle %s : « %s » (intent %s) — à ajouter à %s"
            % (libelle, p, t, ATTENDUS_AFFICHE)
        )
    for t, p in sorted(sans_jeton):
        ecarts.append(
            "  ✗ phrase sans %s dans le bundle %s : « %s » (intent %s)" % (JETON, libelle, p, t)
        )
    if ecarts:
        for ligne in ecarts:
            ecrire(sys.stderr, ligne)
        return 1
    ecrire(
        sys.stdout,
        "  ✓ intents Siri conformes à %s (bundle %s : %s, %s)"
        % (
            ATTENDUS_AFFICHE,
            libelle,
            pluriel(len(intents_attendus), "intent"),
            pluriel(len(couples_attendus), "phrase"),
        ),
    )
    return 0


def main(arguments):
    if len(arguments) != 2 or arguments[0] not in LIBELLES:
        ecrire(sys.stderr, "  ✗ usage : python3 scripts/app-intents/controle.py <mac|ios> <extract.actionsdata>")
        return 1
    try:
        return comparer(arguments[0], arguments[1])
    except Echec as echec:
        ecrire(sys.stderr, str(echec))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
