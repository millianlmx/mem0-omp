#!/usr/bin/env python3
"""Conformité du serveur à l'API mem0 réellement installée.

À lancer dans l'image, où mem0ai est présent :

    podman run --rm mem0-stack-mem0-http:latest python test_api.py

Aucun appel réseau : ni Qdrant, ni oMLX. Le test remplace AsyncMemory par un
double qui applique les VRAIES contraintes de la version installée — signatures
liées avec inspect, validateurs d'entité du module mem0. Un appel illégal échoue
ici exactement comme il échouerait en production.

Raison d'être : mem0 2.x a cassé l'API de 1.x sans changer les noms. Trois
ruptures silencieuses, qui ne se voient qu'à l'exécution de la route concernée :
  - from_config est redevenu synchrone (l'attendre lève un TypeError) ;
  - search/get_all REFUSENT user_id/agent_id/run_id au premier niveau ;
  - search prend top_k, plus limit.
"""
import inspect
import sys
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from mem0 import AsyncMemory
    import mem0.memory.main as mem0_main
except ImportError as exc:  # pragma: no cover
    print(f"Dépendance manquante : {exc}. Lance ce test dans l'image.")
    sys.exit(2)

calls: list[tuple[str, dict]] = []


class StubMemory:
    @classmethod
    def from_config(cls, config):
        # Si from_config redevenait une coroutine, le serveur casserait ici et
        # non en production : c'est le but.
        assert not inspect.iscoroutinefunction(AsyncMemory.from_config), (
            "AsyncMemory.from_config est devenu asynchrone : ajoute un await dans get_memory()"
        )
        return cls()

    async def _record(self, name, args, kwargs):
        inspect.signature(getattr(AsyncMemory, name)).bind(self, *args, **kwargs)
        if name in ("search", "get_all"):
            mem0_main._reject_top_level_entity_params(kwargs, name)
            entities = kwargs.get("filters") or {}
            if not any(k in entities for k in ("user_id", "agent_id", "run_id")):
                raise ValueError(f"{name}: filters sans identifiant d'entité")
        calls.append((name, kwargs))
        return {"results": [{"id": "m1", "memory": "test"}]}

    async def add(self, *a, **k):
        return await self._record("add", a, k)

    async def search(self, *a, **k):
        return await self._record("search", a, k)

    async def get_all(self, *a, **k):
        return await self._record("get_all", a, k)

    async def delete(self, *a, **k):
        return await self._record("delete", a, k)

    async def history(self, *a, **k):
        return await self._record("history", a, k)


def main() -> int:
    with patch("http_server.AsyncMemory", StubMemory):
        import http_server

        http_server._mem = None
        client = TestClient(http_server.app)
        failures = 0

        def check(label, response, extra=True):
            nonlocal failures
            ok = response.status_code == 200 and extra
            print(f"{'PASS' if ok else 'FAIL'}  {label}  [{response.status_code}]")
            if not ok:
                failures += 1
                print("      " + response.text[:400])

        health = client.get("/health")
        check(f"/health — mem0 {health.json().get('mem0')}", health)
        check("/memory/add", client.post("/memory/add", json={"text": "f", "agent_id": "P"}))
        check("/memory/add infer=false", client.post("/memory/add", json={"text": "f", "agent_id": "P", "infer": False, "tags": "t"}))
        check("/memory/add_procedure", client.post("/memory/add_procedure", json={"steps": "s", "agent_id": "P"}))
        check("/memory/search", client.post("/memory/search", json={"query": "q", "agent_id": "P", "limit": 8}))
        check("/memory/all", client.get("/memory/all?agent_id=P"))
        check("/memory/{id} DELETE", client.delete("/memory/x1"))
        check("/memory/{id}/history", client.get("/memory/x1/history"))

        search = next(k for n, k in calls if n == "search")
        get_all = next(k for n, k in calls if n == "get_all")
        expected = {"user_id": "moi", "agent_id": "P"}
        for label, ok in (
            ("search : entités dans filters", search.get("filters") == expected),
            ("search : limit converti en top_k", search.get("top_k") == 8),
            ("get_all : entités dans filters", get_all.get("filters") == expected),
        ):
            print(f"{'PASS' if ok else 'FAIL'}  {label}")
            failures += 0 if ok else 1

        # Le cloisonnement ne doit pas être contournable depuis le corps HTTP.
        calls.clear()
        client.post("/memory/search", json={"query": "q", "agent_id": "A", "filters": {"user_id": "autre", "tags": "z"}})
        merged = calls[0][1]["filters"]
        ok = merged.get("user_id") == "moi" and merged.get("agent_id") == "A" and merged.get("tags") == "z"
        print(f"{'PASS' if ok else 'FAIL'}  filtres client fusionnés sans écraser le scope : {merged}")
        failures += 0 if ok else 1

        print()
        print("Conforme." if failures == 0 else f"{failures} échec(s).")
        return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
