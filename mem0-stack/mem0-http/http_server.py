#!/usr/bin/env python3
"""API HTTP mem0, pensée pour être appelée en fetch() depuis un plugin OMP
natif (TypeScript), sans passer par un transport MCP/stdio.

Lancée en continu par docker-compose (uvicorn), écoute sur 0.0.0.0:8321.
"""
import json
import os
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException
from mem0 import AsyncMemory
from pydantic import BaseModel

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
    check_token(x_mem0_token)
    m = await get_memory()
    return await m.add(
        req.steps,
        user_id=USER,
        agent_id=req.agent_id,
        memory_type="procedural_memory",
    )


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


@app.put("/memory/{memory_id}")
async def update_memory(memory_id: str, req: UpdateRequest, x_mem0_token: str | None = Header(default=None)):
    """Réécriture intégrale d'un souvenir.

    Sert la fusion côté plugin : quand `mem0_add` retrouve un souvenir proche, il
    complète l'entrée au lieu d'en créer une deuxième. `update()` conserve l'id et
    empile une révision dans l'historique, donc l'état précédent reste consultable
    via /memory/{id}/history.
    """
    check_token(x_mem0_token)
    m = await get_memory()
    return await m.update(memory_id=memory_id, text=req.text)


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
