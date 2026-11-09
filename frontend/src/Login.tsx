import {useLayoutEffect,useState} from 'react';
import {Alert,Box,Button,Container,Form,FormField,Header,Input,RadioGroup,SpaceBetween} from '@cloudscape-design/components';
import {colorBackgroundLayoutMain,colorTextBodyDefault,fontFamilyBase,fontSizeBodyM,lineHeightBodyM} from '@cloudscape-design/design-tokens';
import {api,apiUrl} from './client';
import type {Session} from './contracts';
import {WebAuthnLogin} from './WebAuthn';
import {Onboarding} from './Onboarding';
import {RecoveryLogin} from './Recovery';
import './login.css';

export function Login({onLogin,notice}:{onLogin:(token:string,user:Session)=>void;notice?:string}) {
  useLayoutEffect(()=>{
    const body=document.body;
    const previous={fontFamily:body.style.fontFamily,fontSize:body.style.fontSize,lineHeight:body.style.lineHeight,color:body.style.color,backgroundColor:body.style.backgroundColor};
    const hadVisualRefresh=body.classList.contains('awsui-visual-refresh');
    // Standalone pages need the same public token baseline as the reference app.
    body.classList.add('awsui-visual-refresh');
    Object.assign(body.style,{fontFamily:fontFamilyBase,fontSize:fontSizeBodyM,lineHeight:lineHeightBodyM,color:colorTextBodyDefault,backgroundColor:colorBackgroundLayoutMain});
    return ()=>{Object.assign(body.style,previous);if(!hadVisualRefresh)body.classList.remove('awsui-visual-refresh');};
  },[]);
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[code,setCode]=useState('');
  const [challenge,setChallenge]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [methods,setMethods]=useState<string[]>([]);
  const [enrollment,setEnrollment]=useState(''),[method,setMethod]=useState('totp'),[recovering,setRecovering]=useState(false);
  async function complete(result:{access_token?:string;challenge_token?:string;methods?:string[];enrollment_token?:string;recovery_reset?:boolean}) {
    setPassword('');
    if(result.enrollment_token){setChallenge('');setCode('');setRecovering(!!result.recovery_reset);setEnrollment(result.enrollment_token);return;}
    if(result.challenge_token){setMethods(result.methods||['totp']);setMethod((result.methods||['totp']).includes('totp')?'totp':'webauthn');setChallenge(result.challenge_token);return;}
    if(!result.access_token)throw new Error('Authentication did not return a session.');
    const user=await api<Session>('/api/auth/session',result.access_token);
    onLogin(result.access_token,user);
  }
  async function submit() {
    if(busy||(challenge?method!=='totp'||!code.trim():!username.trim()||!password))return;
    setBusy(true);setError('');
    try {
      let result:{access_token?:string;challenge_token?:string;methods?:string[]};
      if(challenge) result=await api('/api/auth/totp/challenge','',{method:'POST',body:JSON.stringify({challenge_token:challenge,code})});
      else {
        const response=await fetch(apiUrl('/api/auth/token'),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username,password})});
        const data=await response.json();
        if(!response.ok) throw new Error(data.error?.message||'Login failed.');
        result=data;
      }
      await complete(result);
    } catch(error) {setError((error as Error).message);} finally {setBusy(false);}
  }
  return <main className="login-page">
    <section className="login-visual" aria-label="Pokémon TCG">
      <svg className="login-visual-graph" viewBox="0 0 900 900" fill="none" aria-hidden="true" focusable="false">
        <g stroke="currentColor" strokeWidth="2">
          <path d="M100 160 360 240 640 130 810 350 620 540 760 760 430 700 170 790 100 530 360 460 360 240M100 160 100 530M360 240 620 540 430 700 360 460 100 530M640 130 620 540M360 460 810 350M170 790 430 700"/>
          {[[100,160],[360,240],[640,130],[810,350],[620,540],[760,760],[430,700],[170,790],[100,530],[360,460]].map(([cx,cy])=><circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="15"/>)}
        </g>
      </svg>
      <div className="login-brand"><h1>Pokémon TCG</h1><p>Build your deck through conversation.</p></div>
    </section>
    <section className="login-panel" aria-label="Sign in">
      <div className="login-card"><SpaceBetween size="l">
        {notice&&<Alert type="warning">{notice}</Alert>}
        <Container header={!enrollment?<Header variant="h2" description={challenge?`Password verified for ${username}. Choose a verification method.`:'Enter your account credentials to continue.'}>{challenge?'Verify your sign-in':'Sign in'}</Header>:undefined}>
          {enrollment?<Onboarding recovery={recovering} token={enrollment} onFinish={()=>{setEnrollment('');setChallenge('');setMethods([]);setCode('');setError('');}}/>:<>
          <form data-testid="login-form" onSubmit={event=>{event.preventDefault();void submit();}}>
            <Form actions={(!challenge||method==='totp')?<Button data-testid="login-submit-button" variant="primary" formAction="submit" loading={busy} disabled={busy||(challenge?!code.trim():!username.trim()||!password)}>Sign in</Button>:undefined}>
              <SpaceBetween size="l">
                {!challenge?<>
                  <FormField label="Username"><Input data-testid="login-username-input" autoComplete="username" value={username} disabled={busy} onChange={({detail})=>setUsername(detail.value)}/></FormField>
                  <FormField label="Password"><Input data-testid="login-password-input" type="password" autoComplete="current-password" value={password} disabled={busy} onChange={({detail})=>setPassword(detail.value)}/></FormField>
                </>:<>
                  <FormField label="Verification method"><RadioGroup value={method} onChange={({detail})=>{setMethod(detail.value);setCode('');setError('');}} items={methods.map(value=>({value,disabled:busy,label:value==='totp'?'Authenticator app':value==='webauthn'?'Passkey or security key':'Recover account',description:value==='recovery'?'Reset all verification methods and set up a new one.':undefined}))}/></FormField>
                  {method==='webauthn'&&<WebAuthnLogin challengeToken={challenge} disabled={busy} onBusy={setBusy} onAuthenticated={complete} onRestart={()=>{setChallenge('');setMethods([]);setCode('');setError('');}}/>}
                  {method==='totp'&&<FormField label="Authenticator code" description={methods.includes('webauthn')?'You can use your authenticator app instead.':undefined}><Input data-testid="login-totp-input" autoComplete="one-time-code" value={code} disabled={busy} onChange={({detail})=>setCode(detail.value)}/></FormField>}
                  {method==='recovery'&&<RecoveryLogin expanded onBusy={setBusy} challengeToken={challenge} onAuthenticated={complete}/>}
                  {method!=='webauthn'&&<Button formAction="none" variant="link" disabled={busy} onClick={()=>{setChallenge('');setCode('');setError('');}}>Start sign-in again</Button>}
                </>}
                {error&&<Alert type="error" header="Unable to sign in">{error}</Alert>}
              </SpaceBetween>
            </Form>
          </form>
          </>}
        </Container>
        <Box textAlign="center" color="text-body-secondary">Sign in with your private PoC account.</Box>
      </SpaceBetween></div>
    </section>
  </main>;
}
