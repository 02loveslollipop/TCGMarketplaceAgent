from fastapi.testclient import TestClient
from shared.api import application
from shared.runtime import secret_file


def test_cors_allows_only_configured_origins(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://chat.example.com,https://admin.example.com")
    client = TestClient(application("test"))
    headers = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"}
    good = client.options("/health", headers={**headers, "Origin": "https://chat.example.com"})
    assert good.status_code == 200
    assert good.headers["access-control-allow-origin"] == "https://chat.example.com"
    bad = client.options("/health", headers={**headers, "Origin": "https://evil.example.com"})
    assert bad.status_code == 400
    assert "access-control-allow-origin" not in bad.headers


def test_secret_can_be_loaded_from_environment_or_file(monkeypatch, tmp_path):
    path = tmp_path / "secret"
    path.write_text("from file\n")
    monkeypatch.setenv("EXAMPLE_SECRET_FILE", str(path))
    assert secret_file("EXAMPLE_SECRET_FILE", "/missing") == "from file"
    monkeypatch.setenv("EXAMPLE_SECRET", "from environment\n")
    assert secret_file("EXAMPLE_SECRET_FILE", "/missing") == "from environment"
