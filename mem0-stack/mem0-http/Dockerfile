FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY memory_config.py http_server.py .

RUN uv pip install --system --no-cache mem0ai qdrant-client openai fastapi "uvicorn[standard]"

# Un seul process, qui tourne en continu : OMP parle en HTTP direct.
CMD ["python", "http_server.py"]
