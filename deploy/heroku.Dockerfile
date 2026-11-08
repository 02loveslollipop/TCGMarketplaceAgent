FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml ./
COPY services ./services
COPY shared ./shared
COPY scripts ./scripts
RUN pip install . && useradd --uid 1000 --create-home app
COPY deploy/heroku-entrypoint.sh /app/entrypoint.sh
USER 1000:1000
CMD ["sh", "/app/entrypoint.sh"]
