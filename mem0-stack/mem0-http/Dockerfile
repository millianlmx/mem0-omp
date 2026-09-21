FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY memory_config.py http_server.py test_api.py .

# mem0 2.x a cassé l'API de 1.x sans renommer les méthodes : from_config est
# redevenu synchrone, et search/get_all refusent user_id/agent_id au premier
# niveau. Le serveur cible 2.x — d'où la borne majeure, qui évite qu'un
# `docker compose build` rapatrie une 3.x incompatible sans prévenir.
# httpx est requis par fastapi.testclient, utilisé par test_api.py.
# `fastembed` est installé explicitement, PAS via `mem0ai[extras]` : cet extra
# rapatrie torch, les wheels CUDA nvidia, transformers, langchain-community et
# boto3 — plusieurs gigaoctets dont l'encodeur BM25 n'a aucun besoin (fastembed
# tourne sur onnxruntime). C'est de lui que dépend l'encodeur creux de mem0
# (SparseTextEmbedding("Qdrant/bm25"), chargé paresseusement dans
# vector_stores/qdrant.py) : sans lui, mem0 loggue « BM25 keyword search disabled »
# et écrit tous les points dense-only, donc la recherche hybride est inerte.
RUN uv pip install --system --no-cache \
      "mem0ai>=2.0,<3.0" fastembed qdrant-client openai fastapi "uvicorn[standard]" httpx

# Modèle BM25 cuit dans l'image plutôt que téléchargé au premier search.
RUN python -c "from fastembed import SparseTextEmbedding; SparseTextEmbedding(model_name='Qdrant/bm25')"

# Vérifie au build que le serveur est conforme à la version de mem0 réellement
# résolue. Une rupture d'API fait échouer le build, pas la première requête.
RUN python test_api.py

# Le serveur tourne sous un uid non nul : il accepte du JSON arbitraire et du
# texte venant du LLM, et l'API Qdrant publiée sur 127.0.0.1 est authentifiée
# depuis S-2. uid/gid fixés à 10001 pour être prédictibles et vérifiables par
# `id` (pas de `--uid` implicite décidé par la base).
# Le `chown` du cache fastembed est OBLIGATOIRE : le modèle BM25 y est cuit en
# root, et son chargement en non-root journalise sinon « Ignoring corrupted
# tree cache file /tmp/fastembed_cache/models--Qdrant--bm25/...: Permission
# denied » à chaque démarrage (l'embedding creux sort quand même, le cache est
# simplement corrompu). /tmp est en 1777, donc uvicorn n'a besoin de rien d'autre.
RUN useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin mem0 \
 && chown -R mem0:mem0 /app /tmp/fastembed_cache
USER mem0

CMD ["python", "http_server.py"]
