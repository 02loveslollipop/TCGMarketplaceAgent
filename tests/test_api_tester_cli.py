import subprocess
import io
from unittest.mock import Mock
import pytest
from scripts import api_tester


TOKEN = 'synthetic-private-launch-token'


@pytest.mark.parametrize('mode',['parameter','stdin'])
def test_launcher_passes_token_only_through_exec_stdin(monkeypatch,capsys,mode):
    calls=[]
    def docker(*args,**kwargs):
        calls.append((args,kwargs))
        output='new-container-id' if args[0]=='create' else ''
        return subprocess.CompletedProcess(args,0,stdout=output)
    response=Mock(status=200)
    response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
    monkeypatch.setattr(api_tester,'docker',docker)
    monkeypatch.setattr(api_tester,'build_opener',lambda *_:Mock(open=Mock(return_value=response)))
    monkeypatch.setattr(api_tester.sys,'stdin',io.StringIO(TOKEN+'\n'))
    secret=['--token',TOKEN] if mode=='parameter' else ['--token-stdin']
    assert api_tester.main(['up',*secret,'--no-build'])==0
    assert all(TOKEN not in str(args) for args,_ in calls)
    assert all(TOKEN not in str(kwargs.get('env','')) for _,kwargs in calls)
    assert next(kwargs for args,kwargs in calls if args[0]=='exec')['input']==TOKEN
    create=next(args for args,_ in calls if args[0]=='create')
    assert '127.0.0.1:8090:8080' in create
    assert '--read-only' in create
    assert '--tmpfs' in create
    assert TOKEN not in capsys.readouterr().out


def test_launcher_cleans_up_only_its_new_container_on_start_failure(monkeypatch,capsys):
    def docker(*args,**_):
        if args[0]=='start':raise subprocess.CalledProcessError(1,args,stderr='do not echo')
        return subprocess.CompletedProcess(args,0,stdout='new-container-id' if args[0]=='create' else '')
    cleanup=Mock()
    monkeypatch.setattr(api_tester,'docker',docker)
    monkeypatch.setattr(api_tester.subprocess,'run',cleanup)
    assert api_tester.main(['up','--token',TOKEN,'--no-build'])==1
    assert cleanup.call_args.args[0]==['docker','rm','-f','new-container-id']
    assert 'do not echo' not in capsys.readouterr().err


def test_launcher_refuses_existing_container_or_unrelated_removal(monkeypatch):
    runner=Mock(return_value=subprocess.CompletedProcess([],0,stdout='existing-container'))
    monkeypatch.setattr(api_tester,'docker',runner)
    assert api_tester.main(['up','--token',TOKEN,'--no-build'])==1
    assert not any(call.args[0] in {'build','create','rm'} for call in runner.call_args_list)
    runner.reset_mock()
    assert api_tester.main(['down'])==1
    assert len(runner.call_args_list)==1


@pytest.mark.parametrize('arguments',[
    ['--token','invalid token'],['--token',''],['--token','non-ascii-é'],
])
def test_invalid_tokens_do_not_reach_docker(monkeypatch,arguments):
    runner=Mock();monkeypatch.setattr(api_tester,'docker',runner)
    assert api_tester.main(['up',*arguments])==1
    runner.assert_not_called()


@pytest.mark.parametrize('selectors,auth,chat',[
    ([],api_tester.AUTH_URL,api_tester.CHAT_URL),
    (['--default'],api_tester.AUTH_URL,api_tester.CHAT_URL),
    (['--auth-url','http://auth:8000','--chat-url','http://orchestrator:8000'],
     'http://auth:8000','http://orchestrator:8000'),
])
def test_default_and_custom_api_selection(monkeypatch,selectors,auth,chat):
    launch=Mock();monkeypatch.setattr(api_tester,'launch',launch)
    assert api_tester.main(['up','--token',TOKEN,*selectors])==0
    args=launch.call_args.args[0]
    assert args.auth_url==auth
    assert args.chat_url==chat


@pytest.mark.parametrize('custom_flag',['--auth-url','--chat-url'])
def test_default_rejects_conflicting_custom_api_urls(monkeypatch,custom_flag):
    launch=Mock();monkeypatch.setattr(api_tester,'launch',launch)
    with pytest.raises(SystemExit) as error:
        api_tester.main(['up','--token',TOKEN,'--default',custom_flag,'http://custom:8000'])
    assert error.value.code==2
    launch.assert_not_called()
