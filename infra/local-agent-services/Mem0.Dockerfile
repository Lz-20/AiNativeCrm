# Local verification image; context is the reviewed upstream checkout.
# git revision: abb81c88e1f738a8117d8293530fbc31a5ef8fd9
FROM python:3.12.12-slim
WORKDIR /upstream
COPY pyproject.toml README.md LICENSE ./
COPY mem0 ./mem0
COPY server/requirements.txt /tmp/server-requirements.txt
ENV PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir . -r /tmp/server-requirements.txt fastembed==0.7.3
# Download real ONNX weights during provisioning, not the first CRM write.
ENV FASTEMBED_CACHE_PATH=/opt/embeddings HF_HUB_DISABLE_TELEMETRY=1 MEM0_TELEMETRY=false OMP_NUM_THREADS=1
RUN python -c 'from fastembed import TextEmbedding; TextEmbedding(model_name="BAAI/bge-small-zh-v1.5", threads=1)'
WORKDIR /app
COPY server /app
CMD ["sh", "-ec", "alembic upgrade head && exec uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1"]
