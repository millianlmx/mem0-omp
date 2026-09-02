"""Config mem0 partagée par le serveur HTTP (http_server.py).

Le prompt d'extraction est la pièce qui décide de la qualité de la mémoire : c'est
lui qui trie, dans un segment de conversation brut, ce qui mérite d'être gardé. Il
est aligné sur le bloc AGENTS.md posé dans les projets.
"""
import os
import sys


def _env(name: str, default: str) -> str:
    """Variable d'environnement, avec repli si absente OU vide.

    docker-compose écrit une chaîne vide quand une variable est déclarée sans
    valeur dans .env (`EMBEDDING_DIMS=`). os.environ.get() renvoie alors "" et
    non le défaut : sans ce repli, int("") lève une ValueError obscure.
    """
    raw = os.environ.get(name)
    return default if raw is None or raw.strip() == "" else raw.strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name, str(default))
    try:
        return int(raw)
    except ValueError:
        raise SystemExit(
            f"[mem0-config] {name}={raw!r} n'est pas un entier. "
            f"Corrige la valeur dans .env (attendu : un nombre, ex. {default})."
        )


QDRANT_HOST = _env("QDRANT_HOST", "qdrant")
QDRANT_PORT = _env_int("QDRANT_PORT", 6333)
# Docker Desktop : host.docker.internal — Podman : host.containers.internal.
OMLX_BASE_URL = _env("OMLX_BASE_URL", "http://host.containers.internal:8000/v1")
LLM_MODEL = _env("OMLX_LLM_MODEL", "qwen3-8b")
EMBED_MODEL = _env("OMLX_EMBED_MODEL", "bge-m3")
# oMLX peut exiger une clé. Le client OpenAI en veut une non vide de toute
# façon, d'où le repli sur une valeur factice quand le serveur n'en demande pas.
OMLX_API_KEY = _env("OMLX_API_TOKEN", "not-needed")
# Doit correspondre au modèle d'embedding (bge-m3 = 1024). La collection Qdrant
# est créée avec cette dimension au premier appel : la changer ensuite fait
# rejeter les écritures.
EMBEDDING_DIMS = _env_int("EMBEDDING_DIMS", 1024)

# Constant : c'est toi. Le cloisonnement se fait par agent_id (= nom du projet),
# envoyé par le plugin OMP.
USER = "moi"

FACT_EXTRACTION_PROMPT = """
Tu extrais les souvenirs durables d'une session de développement logiciel.

GARDE uniquement, et seulement si l'information est explicitement présente :
- stack et choix techniques du projet (langage, framework, versions imposées,
  outil de test, linter, cible de déploiement) ;
- décisions d'architecture, avec leur raison ;
- conventions de code et contraintes du dépôt, surtout celles qui ne sont écrites
  nulle part ;
- bugs résolus : symptôme + cause racine + correctif ;
- exigences incontournables d'une feature (compat, perf, règle métier, sécurité,
  accessibilité) ;
- préférences de travail exprimées par l'utilisateur.

IGNORE :
- l'état courant du code (nombre de lignes, contenu d'un fichier, ce qui est en
  cours) — ça change, le dépôt fait autorité ;
- les raisonnements intermédiaires, hypothèses non confirmées, tâches en cours,
  sorties de tests, logs ;
- le bavardage, les confirmations, les remerciements ;
- tout secret, clé, token, mot de passe, identifiant ou donnée personnelle.

Chaque fait doit être AUTOPORTANT : compréhensible dans six mois sans la
conversation d'origine. Nomme les fichiers, modules et symboles concernés. Un fait
sans sa cause ou sa raison n'a presque aucune valeur — ne le produis pas à moitié.

Réponds uniquement en JSON, clé "facts", liste de chaînes. Liste vide si rien ne
mérite d'être retenu — c'est un résultat normal et fréquent.

Exemples :

Input: Bon ça marche enfin, merci
Output: {"facts": []}

Input: J'ai relancé les tests, 42 passent
Output: {"facts": []}

Input: Le TypeError venait de pydantic v2, fallait remplacer .dict() par .model_dump() dans api/serializers.py
Output: {"facts": ["Bug TypeError dans api/serializers.py : cause = appel de .dict() (API pydantic v1) sur un modele v2. Fix = .model_dump(). Verifier ce pattern partout ou pydantic est utilise."]}

Input: On part sur Ruff plutot que Flake8+Black, un seul outil a configurer et c'est 10x plus rapide en CI
Output: {"facts": ["Decision projet : linter et formatter = Ruff, retenu contre Flake8+Black pour n'avoir qu'un outil a configurer et un temps de CI nettement plus court."]}

Input: Attention le reset de mot de passe doit rester a usage unique, c'est non negociable pour l'audit
Output: {"facts": ["Exigence non negociable (audit) : les tokens de reset de mot de passe sont a usage unique."]}
"""

UPDATE_MEMORY_PROMPT = """
Tu compares un souvenir existant a une nouvelle information sur le meme sujet.

Si la nouvelle information corrige ou precise l'ancienne, produis un souvenir mis a
jour qui garde une trace explicite de l'etat precedent ("auparavant X, desormais Y"
et la raison du changement si elle est connue). L'historique d'une decision vaut
souvent autant que la decision.

Ne supprime jamais silencieusement une information encore potentiellement utile. Si
les deux informations coexistent sans se contredire, garde les deux.
"""

CONFIG = {
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "collection_name": "omp_memory",
            "host": QDRANT_HOST,
            "port": QDRANT_PORT,
            "embedding_model_dims": EMBEDDING_DIMS,
        },
    },
    "llm": {
        "provider": "openai",
        "config": {
            "model": LLM_MODEL,
            "api_key": OMLX_API_KEY,
            "openai_base_url": OMLX_BASE_URL,
        },
    },
    "embedder": {
        "provider": "openai",
        "config": {
            "model": EMBED_MODEL,
            "api_key": OMLX_API_KEY,
            "openai_base_url": OMLX_BASE_URL,
            # pas de embedding_dims ici : cf. bug mem0 #4153 avec certains
            # backends OpenAI-compatible qui n'aiment pas le param "dimensions"
        },
    },
    "custom_fact_extraction_prompt": FACT_EXTRACTION_PROMPT,
    "custom_update_memory_prompt": UPDATE_MEMORY_PROMPT,
    "version": "v1.1",
}


if __name__ == "__main__":
    # Auto-test : `podman run --rm <image> python memory_config.py` affiche la
    # configuration réellement embarquée dans l'image. Utile quand le conteneur
    # redémarre en boucle et que tu veux voir ce qu'il exécute vraiment.
    import json as _json

    print("memory_config chargé sans erreur.")
    print(f"  fichier        : {__file__}")
    print(f"  QDRANT         : {QDRANT_HOST}:{QDRANT_PORT}")
    print(f"  OMLX_BASE_URL  : {OMLX_BASE_URL}")
    _k = OMLX_API_KEY
    print(f"  OMLX_API_TOKEN : {'(aucun)' if _k == 'not-needed' else _k[:6] + '…' + _k[-3:]}")
    print(f"  LLM            : {LLM_MODEL}")
    print(f"  EMBED          : {EMBED_MODEL} ({EMBEDDING_DIMS} dimensions)")
    print(f"  USER           : {USER}")
    missing = [k for k in ("vector_store", "llm", "embedder") if k not in CONFIG]
    if missing:
        raise SystemExit(f"CONFIG incomplète, sections manquantes : {missing}")
    print("CONFIG complète.")
    _json.dumps(CONFIG)  # sérialisable = exploitable par mem0
