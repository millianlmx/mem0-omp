#!/usr/bin/env python3
"""API HTTP mem0, pensée pour être appelée en fetch() depuis un plugin OMP
natif (TypeScript), sans passer par un transport MCP/stdio.

Lancée en continu par docker-compose (uvicorn), écoute sur 0.0.0.0:8321.
"""
import asyncio
import json
import os
from datetime import datetime, timezone

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from mem0 import AsyncMemory
from pydantic import BaseModel
from qdrant_client import models as qdrant_models

from memory_config import CONFIG, USER

app = FastAPI(title="mem0-http")
_mem: AsyncMemory | None = None

# Clé partagée facultative : si MEM0_HTTP_TOKEN est définie côté serveur,
# le plugin doit l'envoyer via le header X-Mem0-Token. Le service n'écoute
# que sur le réseau docker-compose + localhost par défaut, donc c'est une
# protection en profondeur plutôt qu'une exigence stricte.
HTTP_TOKEN = os.environ.get("MEM0_HTTP_TOKEN", "")


async def get_memory() -> AsyncMemory:
    global _mem
    if _mem is None:
        # from_config est un classmethod SYNCHRONE en mem0 2.x ; seules les
        # méthodes d'instance (add/search/get_all/...) sont des coroutines.
        _mem = AsyncMemory.from_config(CONFIG)
    return _mem


def scope_filters(agent_id: str | None, run_id: str | None = None, extra: dict | None = None) -> dict:
    """Filtres d'entité pour search/get_all.

    mem0 2.x REFUSE user_id/agent_id/run_id en paramètres de premier niveau sur
    search() et get_all() : ils doivent passer par `filters`. Les filtres de
    métadonnées fournis par l'appelant sont appliqués d'abord, puis le scoping
    d'entité par-dessus — le cloisonnement ne doit pas pouvoir être contourné
    depuis le corps de la requête.
    """
    f: dict = dict(extra or {})
    f["user_id"] = USER
    if agent_id:
        f["agent_id"] = agent_id
    if run_id:
        f["run_id"] = run_id
    return f


def check_token(token: str | None) -> None:
    if HTTP_TOKEN and token != HTTP_TOKEN:
        raise HTTPException(status_code=401, detail="bad or missing X-Mem0-Token")


# Page initiale de la lecture exhaustive de /memory/all. mem0 2.x n'a AUCUNE
# pagination dans sa surface publique (aucun page/page_size/offset dans
# mem0/memory/main.py) et `get_all(top_k=N)` TRONQUE à N : `top_k` est le plafond
# du nombre de lignes rendues, pas une taille de page. Le seul lectorat exhaustif
# passe donc par des `top_k` croissants — cette constante est le premier d'entre
# eux, quadruplé tant que la page revient saturée. Aucune constante ne borne le
# nombre de lignes : le plafond résiduel de 100 est justement ce qu'on supprime.
MEMORY_PAGE = 500


def memory_rows(page: object) -> list[dict]:
    """Lignes d'une réponse de `get_all` (dict `{"results": [...]}` sinon liste nue)."""
    if isinstance(page, dict):
        found = page.get("results")
        return list(found) if isinstance(found, list) else []
    return list(page) if isinstance(page, list) else []


def memory_order(memories: list[dict]) -> list[dict]:
    """Trie par `updated_at` décroissant, sans muter l'entrée.

    Qdrant rend les points dans l'ordre des id, PAS par date (le scroll jette
    `next_page_offset`, cf. `mem0/vector_stores/qdrant.py`) : le tri exigé par
    l'API est donc fait ici. Une ligne sans date exploitable (absente, non
    chaîne, illisible par `fromisoformat`) est classée APRÈS toutes les lignes
    datées, son ordre relatif préservé (tri stable) — elle est rendue, jamais
    jetée. Un `datetime` naïf (pas de décalage) est interprété en UTC : le
    comparer à un « aware » lèverait un TypeError.
    """

    def sort_key(row: dict) -> tuple[int, float]:
        raw = row.get("updated_at") if isinstance(row, dict) else None
        if isinstance(raw, str):
            try:
                when = datetime.fromisoformat(raw)
            except ValueError:
                return (0, 0.0)
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            return (1, when.timestamp())
        return (0, 0.0)

    return sorted(memories, key=sort_key, reverse=True)


async def read_all_memories(m: AsyncMemory, filters: dict) -> list[dict]:
    """Toutes les lignes de la scope, sans plafond.

    Page initiale `MEMORY_PAGE`, puis quadruplée tant que la page précédente
    revient SATURÉE (autant de lignes que de `top_k` demandé) : c'est le seul
    signal disponible pour distinguer « la scope est plus petite que la page »
    de « la scope est plus grande et a été coupée ». L'escalade s'arrête aussi
    dès qu'une page plus grande ne rend pas plus de lignes que la précédente
    (scope vide, ou écriture concurrente qui a fait disparaître des lignes).
    Toujours `m.get_all(...)` : descendre dans `m.vector_store` contournerait les
    filtres d'entité et sortirait de la surface couverte par test_api.py.
    """
    top_k = MEMORY_PAGE
    memories = memory_rows(await m.get_all(filters=filters, top_k=top_k))
    while len(memories) == top_k:
        top_k *= 4
        page = memory_rows(await m.get_all(filters=filters, top_k=top_k))
        if len(page) <= len(memories):
            break
        memories = page
    return memories


# ---------------------------------------------------------------------------
# Graphe des souvenirs (S-3) : les arêtes de proximité sémantique, calculées sur
# les vecteurs DÉJÀ stockés dans Qdrant. Route de LECTURE seule : aucun appel
# oMLX, aucune écriture, aucun seuil choisi par l'appelant.
# ---------------------------------------------------------------------------

# Un voisin est retenu à partir de ce cosinus, et au plus GRAPH_TOP_K par
# souvenir (les meilleurs) : constantes du SERVICE, l'app ne les choisit pas.
GRAPH_THRESHOLD = 0.75
GRAPH_TOP_K = 8
# Le scroll Qdrant est paginé (`next_page_offset`), et la similarité se calcule
# par blocs de lignes pour borner la mémoire du service. Mesuré sur la pile
# locale le 2026-10-06 : 1 892 points, ~0,5 s, réponse ~250 Ko pour 2 204 arêtes.
GRAPH_PAGE = 1000
GRAPH_BLOCK = 256


def dense_vector(vector: object) -> list[float] | None:
    """Le vecteur DENSE d'un point Qdrant, dans ses DEUX formes.

    La collection rend `{"": [...], "bm25": {...}}` pour les points hybrides et
    une liste nue pour les points antérieurs à l'hybridation : les deux portent
    le dense. Un point sans clé `""` (ou au vecteur vide) n'a pas de dense — il
    est écarté des arêtes, jamais une exception.
    """
    if isinstance(vector, dict):
        vector = vector.get("")
    if isinstance(vector, list) and vector:
        return [float(value) for value in vector]
    return None


def read_dense_vectors(m: AsyncMemory, filters: dict) -> dict[str, list[float]]:
    """Les vecteurs denses de la scope : id de souvenir → vecteur.

    Le POINT Qdrant porte l'id du souvenir — mem0 insère `str(uuid4())` comme id
    de point et ne pose aucune clé `id` dans le payload — donc la clé rendue est
    directement celle des lignes de /memory/all. Lecture paginée jusqu'à
    épuisement (`next_page_offset` absent) ; l'échec de Qdrant remonte tel quel,
    jamais une liste partielle.
    """
    store = m.vector_store
    conditions = [
        qdrant_models.FieldCondition(key=key, match=qdrant_models.MatchValue(value=value))
        for key, value in filters.items()
    ]
    query_filter = qdrant_models.Filter(must=conditions) if conditions else None
    vectors: dict[str, list[float]] = {}
    offset = None
    while True:
        points, offset = store.client.scroll(
            collection_name=store.collection_name,
            scroll_filter=query_filter,
            limit=GRAPH_PAGE,
            offset=offset,
            with_payload=False,
            with_vectors=True,
        )
        for point in points:
            dense = dense_vector(point.vector)
            if dense is not None:
                vectors[str(point.id)] = dense
        if offset is None:
            break
    return vectors


def graph_edges(
    vectors: dict[str, list[float]],
    threshold: float = GRAPH_THRESHOLD,
    top_k: int = GRAPH_TOP_K,
) -> list[dict]:
    """Les arêtes non orientées entre souvenirs proches (S-3), numpy pur.

    Pour chaque souvenir, ses `top_k` meilleurs voisins de cosinus ≥ `threshold`.
    Une arête n'est émise qu'UNE fois, `source < target` (ordre
    lexicographique) ; le tri final est score décroissant, puis source, puis
    target — déterministe. Un vecteur de norme nulle n'a pas de cosinus : il est
    écarté, jamais un score inventé. Moins de deux souvenirs ⇒ aucune arête.
    """
    ids = sorted(vectors)
    if len(ids) < 2:
        return []
    matrix = np.array([vectors[key] for key in ids], dtype=np.float64)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    # Un vecteur nul ne peut pas être normalisé : il est mis hors jeu (`inf` ⇒
    # cosinus nul), et ne peut donc jamais atteindre le seuil.
    norms[norms == 0] = np.inf
    unit = matrix / norms

    edges: dict[tuple[str, str], float] = {}
    for start in range(0, len(ids), GRAPH_BLOCK):
        block = unit[start : start + GRAPH_BLOCK]
        scores = block @ unit.T
        for row in range(scores.shape[0]):
            index = start + row
            line = scores[row]
            line[index] = -np.inf  # jamais son propre voisin
            above = np.flatnonzero(line >= threshold)
            if above.size == 0:
                continue
            # Les meilleurs d'abord ; à score égal, l'id décide (déterministe).
            ranked = sorted(above.tolist(), key=lambda j: (-float(line[j]), ids[j]))
            for j in ranked[:top_k]:
                a, b = ids[index], ids[j]
                source, target = (a, b) if a < b else (b, a)
                score = float(line[j])
                previous = edges.get((source, target))
                if previous is None or score > previous:
                    edges[(source, target)] = score

    return [
        {"source": source, "target": target, "score": score}
        for (source, target), score in sorted(
            edges.items(), key=lambda item: (-item[1], item[0][0], item[0][1])
        )
    ]


class AddRequest(BaseModel):
    text: str
    agent_id: str | None = None
    run_id: str | None = None
    tags: str | None = None
    infer: bool = True


class AddProcedureRequest(BaseModel):
    steps: str
    agent_id: str


class UpdateRequest(BaseModel):
    text: str
    # Étiquettes REMPLACÉES quand le champ est présent (`""` les retire) ; ABSENT,
    # les étiquettes existantes sont conservées — compatibilité du plugin, qui
    # n'envoie que `text`.
    tags: str | None = None


class SearchRequest(BaseModel):
    query: str
    agent_id: str | None = None
    limit: int = 5
    filters: dict | None = None
    # Plancher de score. mem0 applique 0.1 quand c'est None (`_search_vector_store`),
    # ce qui revient à « renvoie tout » : le filtrage utile se décide côté appelant.
    threshold: float | None = None
    # Ajoute `score_details.semantic_score` à chaque résultat : c'est la SEULE voie
    # d'accès au cosinus brut. Le `score` renvoyé, lui, est le score combiné
    # (sémantique + bm25 + boost entités) — BM25 le sature, donc il ne départage pas
    # un souvenir hors-sujet d'un souvenir pertinent. Optionnel : absent = réponse
    # strictement identique à avant (`score_details` en moins pour les anciens clients).
    explain: bool = False


@app.get("/health")
async def health():
    import mem0

    return {"ok": True, "mem0": getattr(mem0, "__version__", "?"), "user": USER}


@app.post("/memory/add")
async def add_memory(req: AddRequest, x_mem0_token: str | None = Header(default=None)):
    check_token(x_mem0_token)
    m = await get_memory()
    metadata = {"tags": req.tags} if req.tags else None
    return await m.add(
        req.text,
        user_id=USER,
        agent_id=req.agent_id or None,
        run_id=req.run_id or None,
        metadata=metadata,
        infer=req.infer,
    )


@app.post("/memory/add_procedure")
async def add_procedure(req: AddProcedureRequest, x_mem0_token: str | None = Header(default=None)):
    """Écrit une procédure **telle quelle** (une procédure est stockée mot pour mot).

    Cette route existait pour `add(..., memory_type="procedural_memory")`. Ce
    chemin-là n'écrit PAS le texte reçu : mem0 le fait résumer par le LLM
    (`_create_procedural_memory`, prompt « You are a memory summarization
    system… ») et stocke SA réponse en posant `metadata.memory_type =
    "procedural_memory"`. D'où le préfixe « ## Summary of the agent's execution
    history » et les résumés hallucinés — et une écriture qui dépendait d'oMLX.

    On écrit donc par le chemin `infer=False`, celui de `/memory/add` : aucun
    appel LLM, `data` byte-identique au texte reçu, et aucune clé `memory_type`
    dans le payload (donc la future purge par ce tag ne l'atteint pas).

    La route est CONSERVÉE (jamais supprimée) pour la compatibilité descendante :
    la pile se met à jour par `docker compose build mem0-http` et le plugin par
    la marketplace, indépendamment l'un de l'autre — la supprimer ferait
    répondre 404 à un plugin installé qui n'a pas encore été mis à jour.
    """
    check_token(x_mem0_token)
    m = await get_memory()
    return await m.add(req.steps, user_id=USER, agent_id=req.agent_id, infer=False)


@app.post("/memory/search")
async def search_memories(req: SearchRequest, x_mem0_token: str | None = Header(default=None)):
    check_token(x_mem0_token)
    m = await get_memory()
    return await m.search(
        req.query,
        top_k=req.limit,                                     # `limit` s'appelle top_k en 2.x
        filters=scope_filters(req.agent_id, extra=req.filters),
        threshold=req.threshold,
        explain=req.explain,
    )


@app.get("/memory/all")
async def get_all_memories(agent_id: str | None = None, x_mem0_token: str | None = Header(default=None)):
    """Toute la mémoire de la scope, triée par `updated_at` décroissant.

    La réponse GAGNE la clé `total` (= `len(results)`) sans rien perdre : un
    client antérieur qui lit `results` (ou une liste nue) reste fonctionnel.
    Aucun paramètre de plafond n'est exposé — le client ne choisit pas la borne.
    """
    check_token(x_mem0_token)
    m = await get_memory()
    memories = memory_order(await read_all_memories(m, scope_filters(agent_id)))
    return {"total": len(memories), "results": memories}


@app.get("/memory/graph")
async def memory_graph(x_mem0_token: str | None = Header(default=None)):
    """Les arêtes de proximité sémantique entre les souvenirs de la scope (S-3).

    `total` compte les souvenirs porteurs d'un vecteur dense ; les arêtes sont
    calculées sur ces vecteurs, jamais réécrites. L'échec de la lecture Qdrant
    remonte en 500 : la réponse est complète ou elle n'est pas.
    """
    check_token(x_mem0_token)
    m = await get_memory()
    vectors = await asyncio.to_thread(read_dense_vectors, m, scope_filters(None))
    return {
        "total": len(vectors),
        "threshold": GRAPH_THRESHOLD,
        "top_k": GRAPH_TOP_K,
        "edges": graph_edges(vectors),
    }


@app.put("/memory/{memory_id}")
async def update_memory(memory_id: str, req: UpdateRequest, x_mem0_token: str | None = Header(default=None)):
    """Réécriture intégrale d'un souvenir.

    Sert la fusion côté plugin : quand `mem0_add` retrouve un souvenir proche, il
    complète l'entrée au lieu d'en créer une deuxième. `update()` conserve l'id et
    empile une révision dans l'historique, donc l'état précédent reste consultable
    via /memory/{id}/history.

    `tags` présent (même `""`) remplace les étiquettes ; absent, elles ne sont pas
    touchées — c'est le contrat du plugin, qui n'envoie que `text`.
    """
    check_token(x_mem0_token)
    m = await get_memory()
    metadata = {"tags": req.tags} if "tags" in req.model_fields_set else None
    return await m.update(memory_id=memory_id, text=req.text, metadata=metadata)


@app.delete("/memory/{memory_id}")
async def delete_memory(memory_id: str, x_mem0_token: str | None = Header(default=None)):
    check_token(x_mem0_token)
    m = await get_memory()
    return await m.delete(memory_id=memory_id)


@app.get("/memory/{memory_id}/history")
async def memory_history(memory_id: str, x_mem0_token: str | None = Header(default=None)):
    check_token(x_mem0_token)
    m = await get_memory()
    return await m.history(memory_id=memory_id)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8321)
