"""Contract/evidence assertions, never brittle comparisons with model prose."""
import os
import pytest
from scripts.agent_testing import SMOKE,EXTENDED

pytestmark=[pytest.mark.live_agent,pytest.mark.asyncio(loop_scope='session')]
CASES=EXTENDED if os.getenv('TCG_LIVE_SUITE')=='extended' else SMOKE

@pytest.mark.parametrize('scenario',CASES,ids=lambda s:s.name)
async def test_live_agent_answer(live_agent,scenario):
    report=await live_agent.run(scenario)
    assert report['status']=='passed'
