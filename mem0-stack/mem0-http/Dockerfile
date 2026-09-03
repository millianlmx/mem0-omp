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

CMD ["python", "http_server.py"]
