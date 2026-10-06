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
import types
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient
    from mem0 import AsyncMemory
    import mem0.memory.main as mem0_main
    from qdrant_client import QdrantClient
except ImportError as exc:  # pragma: no cover
    print(f"Dépendance manquante : {exc}. Lance ce test dans l'image.")
    sys.exit(2)

calls: list[tuple[str, dict]] = []

_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _fake_store(n: int, legacy: bool = False) -> list[dict]:
    """Base factice conforme au RÉEL : lignes ordonnées par id, pas par date.

    Qdrant rend les points dans l'ordre des id alors que /memory/all doit trier
    par `updated_at` décroissant : `updated_at` croît donc avec l'index, ce qui
    met l'ordre du magasin à l'exact inverse de l'ordre attendu. Une implémentation
    qui se contenterait de rendre la page telle quelle échoue sur le tri.

    `legacy=True` retire `updated_at` de la PREMIÈRE ligne (la plus ancienne) :
    elle doit être rendue en DERNIÈRE position sans perturber le reste du tri.
    """
    rows = []
    for i in range(n):
        when = _EPOCH + timedelta(minutes=i)
        row = {
            "id": f"m{i:04d}",
            "memory": f"souvenir {i}",
            "user_id": "moi",
            "agent_id": "P",
            "created_at": when.isoformat(),
            "updated_at": when.isoformat(),
        }
        rows.append(row)
    if legacy:
        del rows[0]["updated_at"]
    return rows


# Ce que sert le double : 150 lignes, la première sans `updated_at`.
STORE = _fake_store(150, legacy=True)

# Panne injectée : la lecture échoue APRÈS la première page, donc en plein
# escalade. La route doit alors remonter l'erreur, jamais rendre la première
# page — ce serait exactement le plafond silencieux que cette feature supprime.
FAIL_AFTER_FIRST_PAGE = False


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
        # mem0 tronque à `top_k` (`output_limit`) : c'est cette troncature que la
        # route doit neutraliser, et c'est elle qui rend un plafond falsifiable.
        await self._record("get_all", a, k)
        if FAIL_AFTER_FIRST_PAGE and sum(1 for n, _ in calls if n == "get_all") > 1:
            raise RuntimeError("Qdrant indisponible (panne injectée en pleine escalade)")
        return {"results": list(STORE[: int(k.get("top_k", 20))])}

    async def delete(self, *a, **k):
        return await self._record("delete", a, k)

    async def history(self, *a, **k):
        return await self._record("history", a, k)

    async def update(self, *a, **k):
        return await self._record("update", a, k)


# ---------------------------------------------------------------------------
# Chemin RÉEL : la route écrit dans un VRAI AsyncMemory dont seuls le LLM,
# l'embedder, le vector store et la base d'historique sont des doubles.
#
# Le double `StubMemory` ci-dessus borne les signatures mais n'exécute JAMAIS le
# code de mem0 : il rend toujours `{"memory": "test"}`, donc il ne peut pas
# distinguer « le texte fourni » de « le texte réécrit par le LLM ». Seul ce
# chemin-ci voit la différence, et c'est lui qui porte la feature.
# ---------------------------------------------------------------------------


class LlmCanary:
    """Témoin du chemin réécrivant. Le seul nombre d'appels attendu est ZÉRO.

    `add(memory_type="procedural_memory")` fait résumer la « conversation » par le
    LLM (`PROCEDURAL_MEMORY_SYSTEM_PROMPT`) et stocke SA réponse : c'est là que
    naissaient le préfixe « ## Summary of the agent's execution history » et les
    résumés hallucinés. Lever ici rend l'appel visible au lieu de le laisser
    passer pour une reformulation anodine de mem0.
    """

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def generate_response(self, **kwargs):
        self.calls.append(kwargs)
        raise AssertionError("canari LLM appelé — le texte allait être réécrit")


class RealEmbedder:
    def embed(self, text, memory_action=None):
        return [0.1, 0.2, 0.3]


class RealVectorStore:
    """Retient les payloads réellement insérés par `_create_memory`.

    `get`/`update` servent le chemin de `PUT /memory/{id}` : le VRAI
    `AsyncMemory.update` relit le payload existant (`vector_store.get`) puis
    réécrit le point (`vector_store.update`). Sans eux, le cas « étiquettes
    remplacées » ne pourrait pas observer le payload FINAL.
    """

    def __init__(self) -> None:
        self.payloads: list[dict] = []
        self.points: dict[str, object] = {}
        self.updates: list[dict] = []

    def insert(self, vectors=None, ids=None, payloads=None):
        for point_id, payload in zip(ids or [], payloads or []):
            self.points[str(point_id)] = types.SimpleNamespace(payload=payload)
        self.payloads.extend(payloads or [])

    def get(self, vector_id=None, *args, **kwargs):
        return self.points.get(str(vector_id))

    def update(self, vector_id=None, vector=None, payload=None, **kwargs):
        self.updates.append({"vector_id": str(vector_id), "vector": vector, "payload": payload})
        self.points[str(vector_id)] = types.SimpleNamespace(payload=payload)


class RealDb:
    """Base d'historique : `add_history` est appelé par `_create_memory`, on le trace."""

    def __init__(self) -> None:
        self.rows: list[tuple] = []

    def add_history(self, *args, **kwargs):
        self.rows.append((args, kwargs))

    def close(self):
        pass


class StubScrollClient:
    """Client Qdrant enregistreur du lecteur de vecteurs du graphe (S-3).

    Il LIE les arguments reçus à la vraie signature de `QdrantClient.scroll`
    (motif de `StubMemory._record`) : un nom de paramètre inventé — `with_vector`
    au lieu de `with_vectors`, mesuré en sonde réelle — échoue ici, pas en
    production.
    """

    def __init__(self, pages: list[tuple]) -> None:
        self.pages = list(pages)
        self.calls: list[dict] = []

    def scroll(self, **kwargs):
        inspect.signature(QdrantClient.scroll).bind(self, **kwargs)
        self.calls.append(kwargs)
        if not self.pages:
            return [], None
        return self.pages.pop(0)


class StubVectorStore:
    """Le strict nécessaire de `m.vector_store` : le client et le nom de collection."""

    def __init__(self, client: StubScrollClient, collection_name: str = "probe") -> None:
        self.client = client
        self.collection_name = collection_name


def real_memory(llm: LlmCanary, store: RealVectorStore, db: RealDb) -> AsyncMemory:
    """Un vrai `AsyncMemory` sans réseau ni Qdrant (motif mesuré sur 2.1.0/2.2.1).

    `__new__` court-circuite `__init__`/`from_config`, qui construiraient le
    vector store Qdrant et le client oMLX. Les attributs posés sont exactement
    ceux que `add(infer=False)` lit : `config.llm.config` (clé `enable_vision`,
    lue avant l'embedding), le LLM, l'embedder, le vector store et la base.
    `_entity_store = None` court-circuite la maintenance d'entités d'`update()`
    (aucune extraction, aucun store d'entités) : c'est l'état d'une instance
    fraîche avant son premier usage d'entités.
    """
    mem = AsyncMemory.__new__(AsyncMemory)
    mem.config = types.SimpleNamespace(llm=types.SimpleNamespace(config={}))
    mem.llm = llm
    mem.embedding_model = RealEmbedder()
    mem.vector_store = store
    mem.db = db
    mem.custom_instructions = None
    mem._entity_store = None
    return mem


def main() -> int:
    # Le double et la panne injectée sont réaffectés par les cas de plafond.
    global STORE, FAIL_AFTER_FIRST_PAGE
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
        check("api/AC-11 — PUT /memory/{id}", client.put("/memory/x1", json={"text": "réécrit"}))

        update = next(k for n, k in calls if n == "update")
        ok = update.get("text") == "réécrit" and "data" not in update
        print(f"{'PASS' if ok else 'FAIL'}  update : clé text, alias data absent : {update}")
        failures += 0 if ok else 1

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

        # `threshold` doit atteindre mem0.search : sans lui le service tourne au
        # plancher par défaut 0.1, c'est-à-dire sans filtrage. `_record` lie les
        # arguments à la vraie signature : ce test échoue si mem0 retire le paramètre.
        calls.clear()
        client.post("/memory/search", json={"query": "q", "agent_id": "A", "limit": 5, "threshold": 0.4})
        ok = calls[0][1].get("threshold") == 0.4
        print(f"{'PASS' if ok else 'FAIL'}  threshold transmis à mem0.search : {calls[0][1].get('threshold')}")
        failures += 0 if ok else 1

        # `explain` doit atteindre mem0.search : c'est la seule voie d'accès au
        # cosinus brut (`score_details.semantic_score`) sur lequel le plugin filtre
        # la pertinence — le `score` renvoyé est le score combiné, que BM25 sature.
        calls.clear()
        client.post("/memory/search", json={"query": "q", "agent_id": "A", "limit": 5, "explain": True})
        ok = calls[0][1].get("explain") is True
        print(f"{'PASS' if ok else 'FAIL'}  explain transmis à mem0.search : {calls[0][1].get('explain')}")
        failures += 0 if ok else 1

        # Non-régression : un client qui ne connaît pas le champ (version antérieure
        # du plugin) reste accepté, et le défaut est False — la réponse est celle
        # d'avant, sans `score_details`.
        calls.clear()
        client.post("/memory/search", json={"query": "q", "agent_id": "A", "limit": 5})
        ok = calls[0][1].get("explain") is False
        print(f"{'PASS' if ok else 'FAIL'}  explain absent → False (compat ascendante) : {calls[0][1].get('explain')}")
        failures += 0 if ok else 1

        def verify(label, got, want):
            """Égalité vérifiée en MONTRANT la valeur observée.

            Même exigence que les cas existants : un rouge doit pouvoir être
            diagnostiqué sur place, sans relancer quoi que ce soit.
            """
            nonlocal failures
            ok = got == want
            print(f"{'PASS' if ok else 'FAIL'}  {label} : {got!r} (attendu {want!r})")
            failures += 0 if ok else 1

        # /memory/all doit rendre TOUTE la scope et trier par `updated_at`
        # décroissant. Le magasin rend 150 lignes ordonnées par id — l'ordre
        # INVERSE de la date : une page fixe en rendrait 100, et un rendu brut
        # les présenterait dans le mauvais ordre.
        resp = client.get("/memory/all?agent_id=P")
        body = resp.json()
        rows = body.get("results") or []
        dated = [m["updated_at"] for m in rows if "updated_at" in m]
        check("api/AC-1 — base de 150 lignes : total réel, tri décroissant, ligne sans date rendue", resp)
        verify("total", body.get("total"), 150)
        verify("len(results)", len(rows), 150)
        verify("updated_at décroissants", all(a >= b for a, b in zip(dated, dated[1:])), True)
        verify("m0149 présent (au-delà des 100 premiers)", any(m["id"] == "m0149" for m in rows), True)
        verify("ligne sans updated_at rendue en dernier", rows[-1]["id"] if rows else None, "m0000")

        # Scope vide : la forme annoncée doit tenir sans ligne (un rendu sans clé
        # `results` casserait `rows()` côté client).
        STORE = _fake_store(0)
        resp = client.get("/memory/all?agent_id=P")
        verify("scope vide : total", resp.json().get("total"), 0)
        verify("scope vide : results", resp.json().get("results"), [])

        # Le plafond résiduel ne se voit qu'AU-DELÀ de la page initiale : 1200
        # lignes la saturent, donc l'escalade doit demander une page PLUS GRANDE.
        # C'est cette assertion qui distingue « aucun plafond » d'« un grand
        # plafond » : un `top_k` figé rend une liste plus courte que le total,
        # et une page unique n'escalade jamais.
        STORE = _fake_store(1200)
        calls.clear()
        resp = client.get("/memory/all?agent_id=P")
        body = resp.json()
        rows = body.get("results") or []
        pages = [k.get("top_k") for n, k in calls if n == "get_all"]
        check("api/AC-5 — base de 1200 lignes : page saturée ⇒ page suivante plus grande", resp)
        verify("total", body.get("total"), 1200)
        verify("len(results)", len(rows), 1200)
        verify("pages demandées", len(pages) >= 2, True)
        verify("top_k strictement croissants", all(a < b for a, b in zip(pages, pages[1:])), True)

        # Page saturée alors qu'il n'y a RIEN au-delà : l'escalade doit s'arrêter
        # après une seule page supplémentaire, jamais boucler.
        STORE = _fake_store(500)
        calls.clear()
        resp = client.get("/memory/all?agent_id=P")
        body = resp.json()
        pages = [k.get("top_k") for n, k in calls if n == "get_all"]
        verify("exactement 500 : total", body.get("total"), 500)
        verify("exactement 500 : len(results)", len(body.get("results") or []), 500)
        verify("exactement 500 : deux requêtes, pas de boucle", len(pages), 2)

        # Panne en PLEINE escalade : la route remonte l'erreur (500) au lieu de
        # rendre la première page — un résultat partiel serait le plafond muet.
        STORE = _fake_store(1200)
        FAIL_AFTER_FIRST_PAGE = True
        calls.clear()
        failing = TestClient(http_server.app, raise_server_exceptions=False)
        resp = failing.get("/memory/all?agent_id=P")
        verify("panne en cours d'escalade : code", resp.status_code, 500)
        verify(
            "panne en cours d'escalade : aucun résultat partiel",
            any(f"m{i:04d}" in resp.text for i in (0, 499, 1199)),
            False,
        )

        STORE = _fake_store(150, legacy=True)
        FAIL_AFTER_FIRST_PAGE = False

        # ------------------------------------------------------------------
        # Chemin RÉEL — S-1 : `/memory/add_procedure` écrit mot pour mot.
        #
        # Les deux critères de la feature se prouvent ici : c'est le seul endroit
        # où le texte stocké est celui que le VRAI `AsyncMemory.add` a produit.
        #
        # `MEM0_TELEMETRY` est coupé le temps du cas : les deux appels de fin de
        # `add()` (détection de seuil d'échelle, notice de premier lancement)
        # interrogent PostHog. Le service, lui, les exécute — la télémétrie est
        # active par défaut —, mais ce fichier promet de ne faire aucun appel
        # réseau. Les deux retournent alors immédiatement.
        # ------------------------------------------------------------------
        steps = "Déployer : 1. tester 2. construire\n3. vérifier le healthcheck"
        canary = LlmCanary()
        store = RealVectorStore()
        db = RealDb()

        class RealMemoryFactory:
            """`from_config` rend l'instance déjà construite : aucune connexion sortante."""

            @classmethod
            def from_config(cls, config):
                return real_memory(canary, store, db)

        with patch("http_server.AsyncMemory", RealMemoryFactory), patch(
            "mem0.memory.telemetry.MEM0_TELEMETRY", False
        ):
            http_server._mem = None
            # `raise_server_exceptions=False` : sans lui, la RÉGRESSION ferait
            # exploser le test sur l'assertion du canari au lieu de laisser
            # observer le 500 du chemin réécrivant (mesuré avant correctif :
            # status 500, journal « Error generating procedural memory summary »).
            real_client = TestClient(http_server.app, raise_server_exceptions=False)
            resp = real_client.post("/memory/add_procedure", json={"steps": steps, "agent_id": "P"})
            http_server._mem = None

        payload = store.payloads[0] if store.payloads else {}
        written = ((resp.json().get("results") or [{}])[0]) if resp.status_code == 200 else {}

        ac1 = (
            resp.status_code == 200
            and payload.get("data") == steps
            and written.get("memory") == steps
            and canary.calls == []
        )
        check("procedure/AC-1 — la route écrit le texte reçu mot pour mot, sans appeler le LLM", resp, extra=ac1)
        verify("AC-1 · payload.data écrit par mem0", payload.get("data"), steps)
        verify("AC-1 · results[0].memory rendu", written.get("memory"), steps)
        verify("AC-1 · appels au LLM", len(canary.calls), 0)
        verify("AC-1 · historique mem0", db.rows[0][0][2] if db.rows else None, steps)

        ac2 = "memory_type" not in payload
        check("procedure/AC-2 — le souvenir écrit ne porte plus memory_type=procedural_memory", resp, extra=ac2)
        verify("AC-2 · clé memory_type absente", "memory_type" in payload, False)
        verify("AC-2 · scope conservé (user_id)", payload.get("user_id"), "moi")
        verify("AC-2 · scope conservé (agent_id)", payload.get("agent_id"), "P")
        verify("AC-2 · role du message", payload.get("role"), "user")

        # ------------------------------------------------------------------
        # api/AC-8 — graphe de proximité sémantique (S-3) : cosinus, seuil,
        # top_k, déduplication et tri par `graph_edges`, puis la route
        # elle-même avec une doublure du lecteur de vecteurs (aucun Qdrant).
        # ------------------------------------------------------------------

        def unit(*pairs: tuple[int, float], dim: int = 12) -> list[float]:
            """Un vecteur creux : les axes non nommés valent zéro."""
            values = [0.0] * dim
            for index, value in pairs:
                values[index] = value
            return values

        def verify_close(label, got, want, tol=1e-9):
            """Égalité flottante vérifiée en montrant la valeur observée."""
            nonlocal failures
            ok = isinstance(got, (int, float)) and abs(got - want) <= tol
            print(f"{'PASS' if ok else 'FAIL'}  {label} : {got!r} (attendu ~{want!r})")
            failures += 0 if ok else 1

        pivot = unit((0, 1.0))
        close = unit((0, 0.8), (1, 0.6))  # cos ≈ 0,8 ≥ 0,75
        below = unit((0, 0.7), (1, 0.7141))  # cos ≈ 0,70 < 0,75

        edges = http_server.graph_edges({"b": close, "a": pivot})
        verify("AC-8 · cosinus ≥ seuil ⇒ UNE arête, source < target", [(e["source"], e["target"]) for e in edges], [("a", "b")])
        verify_close("AC-8 · score = cosinus réel", edges[0]["score"], 0.8, tol=1e-6)
        verify("AC-8 · cosinus < seuil ⇒ aucune arête", http_server.graph_edges({"a": pivot, "c": below}), [])
        verify("AC-8 · moins de deux points ⇒ aucune arête", http_server.graph_edges({"a": pivot}), [])

        # Le top_k est un plafond PAR souvenir : le pivot a 10 voisins
        # au-dessus du seuil, mais les voisins se ressemblent entre eux (cos 1,0)
        # et classent donc tous le pivot APRÈS leurs huit premiers — seuls les 8
        # meilleurs voisins du pivot émettent une arête avec lui.
        crowded = {"pivot": unit((0, 1.0))}
        for index in range(1, 11):
            crowded[f"n{index:02d}"] = unit((0, 0.8), (1, 0.6))
        crowded_edges = http_server.graph_edges(crowded)
        pivot_edges = [e for e in crowded_edges if "pivot" in (e["source"], e["target"])]
        verify("AC-8 · > top_k voisins au-dessus du seuil ⇒ 8 arêtes pour ce souvenir", len(pivot_edges), 8)
        verify(
            "AC-8 · les 8 meilleurs, départagés par id",
            sorted(e["source"] for e in pivot_edges),
            [f"n{index:02d}" for index in range(1, 9)],
        )

        # Tri : score décroissant, puis source, puis target. Deux arêtes de MÊME
        # score (« a–b » et « a–d ») montrent le départage par target.
        tie_b = unit((0, 0.8), (1, 0.6))
        tie_d = unit((0, 0.8), (2, 0.6))
        tie_c = unit((0, 0.9), (1, 0.4))
        tri = http_server.graph_edges({"d": tie_d, "c": tie_c, "b": tie_b, "a": unit((0, 1.0))})
        verify(
            "AC-8 · tri score décroissant puis source puis target",
            [(e["source"], e["target"]) for e in tri],
            [("b", "c"), ("a", "c"), ("a", "b"), ("a", "d")],
        )
        verify("AC-8 · rejoué ⇒ arêtes identiques", http_server.graph_edges({"d": tie_d, "c": tie_c, "b": tie_b, "a": unit((0, 1.0))}), tri)

        # Les DEUX formes de vecteur portent le dense ; un point sans dense est
        # ignoré des arêtes, jamais une exception.
        verify("AC-8 · vecteur nommé : le dense est sous la clé \"\"", http_server.dense_vector({"": [1.0, 0.0], "bm25": object()}), [1.0, 0.0])
        verify("AC-8 · vecteur nu (antérieur à l'hybridation)", http_server.dense_vector([1.0, 0.0]), [1.0, 0.0])
        verify("AC-8 · sans clé \"\" ⇒ pas de dense", http_server.dense_vector({"bm25": object()}), None)
        verify("AC-8 · liste vide ⇒ pas de dense", http_server.dense_vector([]), None)
        verify("AC-8 · deux points sans dense ⇒ aucune arête", http_server.graph_edges({}), [])

        # La route elle-même : doublure du lecteur de vecteurs (le StubMemory
        # n'a pas de vector_store, la route ne doit donc jamais y toucher).
        graph_vectors = {"m-1": pivot, "m-2": close}
        with patch("http_server.read_dense_vectors", lambda m, filters: dict(graph_vectors)):
            http_server._mem = None
            resp = client.get("/memory/graph")
            body = resp.json()
        check("api/AC-8 — GET /memory/graph rend le total, le seuil, le top_k et les arêtes", resp)
        verify("AC-8 · total", body.get("total"), 2)
        verify("AC-8 · threshold", body.get("threshold"), 0.75)
        verify("AC-8 · top_k", body.get("top_k"), 8)
        verify("AC-8 · arêtes", [(e["source"], e["target"]) for e in body.get("edges") or []], [("m-1", "m-2")])

        # Le LECTEUR lui-même : les arguments du scroll sont liés à la VRAIE
        # signature de `QdrantClient.scroll` (motif de `StubMemory._record`) — le
        # doublure ne peut donc pas valider un nom de paramètre inventé. C'est ce
        # que la sonde réelle a pris en défaut (`with_vector` au lieu de
        # `with_vectors` : AssertionError « Unknown arguments »).
        pages = [
            ([types.SimpleNamespace(id="m-1", vector={"": [1.0, 0.0], "bm25": object()})], "page-2"),
            ([types.SimpleNamespace(id="m-2", vector=[1.0, 0.0])], None),
        ]
        scroll_client = StubScrollClient(pages)
        reader = types.SimpleNamespace(vector_store=StubVectorStore(scroll_client))
        read_vectors = http_server.read_dense_vectors(reader, {"user_id": "moi"})
        verify("AC-8 · lecture paginée : deux pages, offset transmis", [c.get("offset") for c in scroll_client.calls], [None, "page-2"])
        verify("AC-8 · les deux formes de vecteur portent le dense", read_vectors, {"m-1": [1.0, 0.0], "m-2": [1.0, 0.0]})
        verify("AC-8 · with_payload/with_vectors demandés", (scroll_client.calls[0].get("with_payload"), scroll_client.calls[0].get("with_vectors")), (False, True))
        verify("AC-8 · limit = GRAPH_PAGE", scroll_client.calls[0].get("limit"), http_server.GRAPH_PAGE)
        verify(
            "AC-8 · filtre Qdrant sur user_id",
            [(c.key, c.match.value) for c in scroll_client.calls[0]["scroll_filter"].must],
            [("user_id", "moi")],
        )

        with patch("http_server.read_dense_vectors", lambda m, filters: {"m-1": pivot}):
            http_server._mem = None
            resp = client.get("/memory/graph")
        verify("AC-8 · 0 ou 1 point ⇒ edges vide", resp.json().get("edges"), [])

        def explode(m, filters):
            raise RuntimeError("Qdrant indisponible (panne injectée)")

        with patch("http_server.read_dense_vectors", explode):
            http_server._mem = None
            failing_graph = TestClient(http_server.app, raise_server_exceptions=False)
            resp = failing_graph.get("/memory/graph")
        verify("AC-8 · échec Qdrant ⇒ 500, jamais une liste partielle", resp.status_code, 500)
        verify("AC-8 · échec Qdrant ⇒ aucun contenu partiel", "edges" in resp.text, False)

        # ------------------------------------------------------------------
        # api/AC-9 / api/AC-10 — PUT /memory/{id} : `tags` présent remplace les
        # étiquettes, absent ne les touche pas (compatibilité du plugin).
        # ------------------------------------------------------------------
        calls.clear()
        client.put("/memory/x1", json={"text": "réécrit", "tags": "a,b"})
        tagged = next(k for n, k in calls if n == "update")
        verify("AC-10 · tags présent ⇒ metadata transmis", tagged.get("metadata"), {"tags": "a,b"})
        verify("AC-10 · texte transmis en text=", tagged.get("text"), "réécrit")

        calls.clear()
        client.put("/memory/x1", json={"text": "sans étiquettes"})
        untagged = next(k for n, k in calls if n == "update")
        verify("AC-10 · tags absent ⇒ AUCUN metadata (compatibilité)", untagged.get("metadata"), None)
        calls.clear()
        client.put("/memory/x1", json={"text": "sans étiquettes", "tags": ""})
        verify("AC-10 · tags \"\" transmis tel quel", next(k for n, k in calls if n == "update").get("metadata"), {"tags": ""})

        # Chemin RÉEL : le payload FINAL, écrit par le vrai AsyncMemory.update.
        canary_update = LlmCanary()
        store_update = RealVectorStore()
        db_update = RealDb()

        class UpdateMemoryFactory:
            """`from_config` rend l'instance déjà construite : aucune connexion sortante."""

            @classmethod
            def from_config(cls, config):
                return real_memory(canary_update, store_update, db_update)

        with patch("http_server.AsyncMemory", UpdateMemoryFactory), patch(
            "mem0.memory.telemetry.MEM0_TELEMETRY", False
        ):
            http_server._mem = None
            update_client = TestClient(http_server.app, raise_server_exceptions=False)
            created = update_client.post(
                "/memory/add",
                json={"text": "texte d'origine", "agent_id": "P", "tags": "a,b", "infer": False},
            )
            memory_id = str(((created.json().get("results") or [{}])[0]).get("id"))
            rewritten = "texte corrigé mot pour mot — **sans** réécriture"
            resp = update_client.put(f"/memory/{memory_id}", json={"text": rewritten, "tags": "c"})
            after_tags = dict(store_update.points[memory_id].payload)
            second = "texte suivant, étiquettes inchangées"
            update_client.put(f"/memory/{memory_id}", json={"text": second})
            after_keep = dict(store_update.points[memory_id].payload)
            http_server._mem = None

        check("api/AC-9 — PUT écrit le texte reçu VERBATIM dans le payload mem0", resp)
        check("api/AC-10 — PUT remplace les étiquettes et conserve le reste du payload", resp, extra=after_tags.get("tags") == "c")
        verify("AC-9 · payload.data = texte reçu", after_tags.get("data"), rewritten)
        verify("AC-9 · aucune réécriture par le LLM", len(canary_update.calls), 0)
        verify("AC-10 · étiquettes remplacées", after_tags.get("tags"), "c")
        verify("AC-10 · tags absent ⇒ étiquettes conservées", (after_keep.get("data"), after_keep.get("tags")), (second, "c"))
        verify(
            "AC-9 · historique : chaque ancienne valeur puis la nouvelle",
            [row[0][1:3] for row in db_update.rows if row[0][3] == "UPDATE"],
            [("texte d'origine", rewritten), (rewritten, second)],
        )
        verify("AC-9 · l'id et la portée survivent à la mise à jour", (after_keep.get("agent_id"), after_keep.get("user_id")), ("P", "moi"))

        print()
        print("Conforme." if failures == 0 else f"{failures} échec(s).")
        return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
