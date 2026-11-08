import pytest
from shared.repository import NotFound, redact


def test_account_models_history_execution_and_checkpoint_persist(repo):
    user = repo.add_user("one", "test-hash")
    assert repo.user(username="one").id == user.id
    repo.save_model("m", label="model", provider="openai", api_id="verified-api-id", enabled=True)
    assert repo.models(enabled_only=True)[0].id == "m"
    chat = repo.new_conversation(user.id, "Test")
    repo.add_message(chat.id, user.id, "user", {"text":"Find card"})
    execution = repo.new_execution(chat.id, user.id, "m")
    repo.checkpoint(execution.id, user.id, {"node":"clarify"}, "waiting")
    repo.event(execution.id, user.id, "progress", {"step":"search"})
    assert repo.history(chat.id, user.id)[0].content["text"] == "Find card"
    assert repo.execution(execution.id, user.id).checkpoint == {"node":"clarify"}
    assert repo.events(execution.id, user.id)[0].kind == "progress"
    assert repo.claim_execution(execution.id, user.id)
    assert not repo.claim_execution(execution.id, user.id)


def test_history_and_resume_owner_isolation(repo):
    chat = repo.new_conversation("owner", "private")
    execution = repo.new_execution(chat.id, "owner", "m")
    with pytest.raises(NotFound):
        repo.history(chat.id, "other")
    with pytest.raises(NotFound):
        repo.execution(execution.id, "other")
    with pytest.raises(NotFound):
        repo.checkpoint(execution.id, "other", {}, "complete")
    assert repo.conversations("other") == []


def test_redaction_recursive_and_disabled_models(repo):
    assert redact({"password":"abc", "nested":[{"api_key":"bad", "message":"Bearer hello.abc"}]}) == {"password":"[REDACTED]", "nested":[{"api_key":"[REDACTED]", "message":"[REDACTED]"}]}
    repo.save_model("off", label="off", provider="openai", api_id="off", enabled=False)
    assert repo.models(enabled_only=True) == []
