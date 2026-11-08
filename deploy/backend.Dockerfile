FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml ./
RUN pip install . && useradd --uid 1000 --create-home app
COPY services ./services
COPY shared ./shared
COPY scripts ./scripts
USER 1000:1000
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2)"
CMD ["uvicorn","services.orchestrator.main:app","--host","0.0.0.0","--port","8000","--no-access-log","--no-proxy-headers"]
