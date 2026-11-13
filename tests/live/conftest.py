"""Explicit opt-in: ordinary pytest never spends provider tokens."""
import os
from pathlib import Path
import pytest
import pytest_asyncio
from scripts.agent_testing import LiveAgentClient,CHAT_URL,AUTH_URL


def pytest_collection_modifyitems(items):
    if os.getenv('TCG_LIVE_TESTS')!='1':
        for item in items:
            if '/live/' in str(item.path):item.add_marker(pytest.mark.skip(reason='Set TCG_LIVE_TESTS=1 to run paid live integration tests.'))


@pytest_asyncio.fixture(scope='session',loop_scope='session')
async def live_agent():
    token=os.getenv('TCG_CI_API_TOKEN','')
    if not token and os.getenv('TCG_TEST_TOKEN_FILE'):token=Path(os.environ['TCG_TEST_TOKEN_FILE']).read_text().strip()
    if not token:pytest.fail('TCG_CI_API_TOKEN is missing; live tests cannot pass without credentials.',pytrace=False)
    client=LiveAgentClient(token,model=os.getenv('TCG_TEST_MODEL','gpt-6-luna'),
        artifact_dir=os.getenv('TCG_TEST_ARTIFACTS','.runtime/live-agent-tests'),
        run_label=os.getenv('GITHUB_RUN_ID','local'),max_tokens=int(os.getenv('TCG_TEST_MAX_TOKENS','600000')),
        deadline=int(os.getenv('TCG_TEST_DEADLINE','600')),
        chat_url=os.getenv('TCG_TEST_CHAT_URL',CHAT_URL),auth_url=os.getenv('TCG_TEST_AUTH_URL',AUTH_URL))
    try:
        await client.prepare()
        yield client
    finally:await client.restore()
