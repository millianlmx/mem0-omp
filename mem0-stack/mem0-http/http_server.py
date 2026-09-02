#!/usr/bin/env python3
"""API HTTP mem0, pensée pour être appelée en fetch() depuis un plugin OMP
natif (TypeScript), sans passer par un transport MCP/stdio.

Lancée en continu par docker-compose (uvicorn), écoute sur 0.0.0.0:8321.
"""
import json
import os

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
        _mem = await AsyncMemory.from_config(CONFIG)
    return _mem


def check_token(token: str | None) -> None:
    if HTTP_TOKEN and token != HTTP_TOKEN:
        raise HTTPException(status_code=401, detail="bad or missing X-Mem0-Token")


class AddRequest(BaseModel):
    text: str
    agent_id: str | None = None
    run_id: str | None = None
    tags: str | None = None
    infer: bool = True


class AddProcedureRequest(BaseModel):
    steps: str
    agent_id: str


class SearchRequest(BaseModel):
    query: str
    agent_id: str | None = None
    limit: int = 5
    filters: dict | None = None


@app.get("/health")
async def health():
    return {"ok": True}


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
        user_id=USER,
        agent_id=req.agent_id or None,
        limit=req.limit,
        filters=req.filters,
    )


@app.get("/memory/all")
async def get_all_memories(agent_id: str | None = None, x_mem0_token: str | None = Header(default=None)):
    check_token(x_mem0_token)
    m = await get_memory()
    return await m.get_all(user_id=USER, agent_id=agent_id or None)


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
