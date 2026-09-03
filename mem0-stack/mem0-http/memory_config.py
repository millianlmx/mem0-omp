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

# Seul slot d'extraction réellement lu par mem0 2.0.20 : `MemoryConfig.custom_instructions`
# (mem0/configs/base.py), injecté en section « ## Custom Instructions » du prompt
# utilisateur d'extraction. `custom_fact_extraction_prompt` et
# `custom_update_memory_prompt` sont du config mort dans cette version — aucun appelant —
# et donnaient l'illusion que l'extraction était sous contrôle. Le prompt système
# grand public de mem0 (ADDITIVE_EXTRACTION_PROMPT) reste en tête et n'est pas
# remplaçable : ce chemin ne sert donc que pour l'échappatoire mem0_add(infer=true),
# jamais pour une écriture automatique.
CUSTOM_INSTRUCTIONS = (
    "Contexte : session de développement logiciel, pas conversation personnelle. "
    "N'extrais QUE : stack et choix techniques, décisions d'architecture avec leur raison, "
    "conventions du dépôt, bugs résolus (symptôme + cause racine + correctif), exigences "
    "non négociables d'une feature. N'extrais RIEN d'autre : ni préférences personnelles, "
    "ni expériences, ni recommandations de l'assistant, ni état courant du code. "
    "Une liste vide est un résultat normal et fréquent. "
    "Rédige dans la langue de la conversation, en nommant fichiers, modules et symboles."
)

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
    "custom_instructions": CUSTOM_INSTRUCTIONS,
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
