FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY memory_config.py http_server.py test_api.py .

# mem0 2.x a cassé l'API de 1.x sans renommer les méthodes : from_config est
# redevenu synchrone, et search/get_all refusent user_id/agent_id au premier
# niveau. Le serveur cible 2.x — d'où la borne majeure, qui évite qu'un
# `docker compose build` rapatrie une 3.x incompatible sans prévenir.
# httpx est requis par fastapi.testclient, utilisé par test_api.py.
RUN uv pip install --system --no-cache \
      "mem0ai>=2.0,<3.0" qdrant-client openai fastapi "uvicorn[standard]" httpx

# Vérifie au build que le serveur est conforme à la version de mem0 réellement
# résolue. Une rupture d'API fait échouer le build, pas la première requête.
RUN python test_api.py

CMD ["python", "http_server.py"]
