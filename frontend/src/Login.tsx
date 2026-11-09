import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Alert,Box,Button,Container,ContentLayout,Form,FormField,Header,Input,Link,RadioGroup,SpaceBetween} from '@cloudscape-design/components';
import {colorBackgroundHomeHeader,colorTextHomeHeaderDefault,colorBackgroundLayoutMain,colorTextBodyDefault,fontFamilyBase,fontSizeBodyM,lineHeightBodyM} from '@cloudscape-design/design-tokens';
import {api,apiUrl} from './client';
import type {Session} from './contracts';
import {WebAuthnLogin} from './WebAuthn';
import {Onboarding} from './Onboarding';
import {RecoveryLogin} from './Recovery';
import './login.css';

type LoginResult={access_token?:string;challenge_token?:string;methods?:string[];enrollment_token?:string;recovery_reset?:boolean};
const recoveryHash='#account-recovery';

export function Login({onLogin,notice}:{onLogin:(token:string,user:Session)=>void;notice?:string}) {
  useLayoutEffect(()=>{
    const body=document.body;
    const previous={fontFamily:body.style.fontFamily,fontSize:body.style.fontSize,lineHeight:body.style.lineHeight,color:body.style.color,backgroundColor:body.style.backgroundColor};
    const hadVisualRefresh=body.classList.contains('awsui-visual-refresh');
    body.classList.add('awsui-visual-refresh');
    Object.assign(body.style,{fontFamily:fontFamilyBase,fontSize:fontSizeBodyM,lineHeight:lineHeightBodyM,color:colorTextBodyDefault,backgroundColor:colorBackgroundLayoutMain});
    return ()=>{Object.assign(body.style,previous);if(!hadVisualRefresh)body.classList.remove('awsui-visual-refresh');};
  },[]);
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[code,setCode]=useState('');
  const [challenge,setChallenge]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [methods,setMethods]=useState<string[]>([]),[method,setMethod]=useState('totp');
  const [enrollment,setEnrollment]=useState(''),[recovering,setRecovering]=useState(false);
  const [recoveryRoute,setRecoveryRoute]=useState(window.location.hash===recoveryHash);
  useEffect(()=>{
    const syncRoute=()=>{setRecoveryRoute(window.location.hash===recoveryHash);setCode('');setError('');};
    window.addEventListener('hashchange',syncRoute);window.addEventListener('popstate',syncRoute);
    return ()=>{window.removeEventListener('hashchange',syncRoute);window.removeEventListener('popstate',syncRoute);};
  },[]);
  function navigateRecovery(recovery:boolean,replace=false){
    const url=window.location.pathname+window.location.search+(recovery?recoveryHash:'');
    if(replace)window.history.replaceState(null,'',url);else window.history.pushState(null,'',url);
    setRecoveryRoute(recovery);setCode('');setError('');
  }
  function restart(){setChallenge('');setMethods([]);setCode('');setError('');navigateRecovery(false,true);}
  async function complete(result:LoginResult) {
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
      let result:LoginResult;
      if(challenge)result=await api('/api/auth/totp/challenge','',{method:'POST',body:JSON.stringify({challenge_token:challenge,code})});
      else {
        const response=await fetch(apiUrl('/api/auth/token'),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username,password})});
        const data=await response.json();
        if(!response.ok)throw new Error(data.error?.message||'Login failed.');
        result=data;
      }
      await complete(result);
    }catch(error){setError((error as Error).message);}finally{setBusy(false);}
  }
  const pageHeading=useRef<HTMLSpanElement>(null);
  const recoveryPage=recoveryRoute&&!!challenge&&methods.includes('recovery')&&!enrollment;
  useEffect(()=>{if(challenge)pageHeading.current?.focus();},[recoveryPage,!!challenge]);
  const title=challenge?'Verify your sign-in':recoveryRoute?'Sign in to recover':'Sign in';
  return <main className="login-page">
    <ContentLayout defaultPadding headerVariant="high-contrast" maxContentWidth={500} headerBackgroundStyle={colorBackgroundHomeHeader} header={
      <div className="login-hero" style={{color:colorTextHomeHeaderDefault}}>
        <Box variant="h1" fontSize="display-l" fontWeight="bold" padding="n" textAlign="center">Pokémon TCG</Box>
        <Box variant="p" fontSize="heading-m" textAlign="center">Build your deck through conversation.</Box>
      </div>
    }>
      <div className="login-card"><SpaceBetween size="l">
        {notice&&<Alert type="warning">{notice}</Alert>}
        {recoveryPage?<>
          <Container header={<Header variant="h2" description={`Password verified for ${username}. Use a saved recovery code to reset your two-factor authentication.`}><span ref={pageHeading} tabIndex={-1}>Recover account</span></Header>}>
            <RecoveryLogin inline onBusy={setBusy} challengeToken={challenge} onAuthenticated={complete}/>
          </Container>
          <Box textAlign="center"><Link href="#" onFollow={event=>{event.preventDefault();if(!busy)navigateRecovery(false);}}>Back to verification</Link></Box>
        </>:<>
          <Container header={!enrollment?<Header variant="h2" description={challenge?`Password verified for ${username}. Choose a verification method.`:recoveryRoute?'Verify your password before recovering your account.':'Enter your account credentials to continue.'}><span ref={pageHeading} tabIndex={-1}>{title}</span></Header>:undefined}>
            {enrollment?<Onboarding recovery={recovering} token={enrollment} onFinish={()=>{setEnrollment('');restart();}}/>:
              <form data-testid="login-form" onSubmit={event=>{event.preventDefault();void submit();}}>
                <Form actions={(!challenge||method==='totp')?<Button data-testid="login-submit-button" variant="primary" formAction="submit" loading={busy} disabled={busy||(challenge?!code.trim():!username.trim()||!password)}>Sign in</Button>:undefined}>
                  <SpaceBetween size="l">
                    {!challenge?<>
                      <FormField label="Username"><Input data-testid="login-username-input" autoComplete="username" value={username} disabled={busy} onChange={({detail})=>setUsername(detail.value)}/></FormField>
                      <FormField label="Password"><Input data-testid="login-password-input" type="password" autoComplete="current-password" value={password} disabled={busy} onChange={({detail})=>setPassword(detail.value)}/></FormField>
                    </>:<>
                      <FormField label="Verification method"><RadioGroup value={method} onChange={({detail})=>{setMethod(detail.value);setCode('');setError('');}} items={methods.filter(value=>value==='totp'||value==='webauthn').map(value=>({value,disabled:busy,label:value==='totp'?'Authenticator app':'Passkey or security key'}))}/></FormField>
                      {method==='webauthn'&&<WebAuthnLogin challengeToken={challenge} disabled={busy} onBusy={setBusy} onAuthenticated={complete} onRestart={restart}/>}
                      {method==='totp'&&<FormField label="Authenticator code" description="Enter the code from your authenticator app."><Input data-testid="login-totp-input" autoComplete="one-time-code" value={code} disabled={busy} onChange={({detail})=>setCode(detail.value)}/></FormField>}
                      {method!=='webauthn'&&<Button formAction="none" variant="link" disabled={busy} onClick={restart}>Start sign-in again</Button>}
                    </>}
                    {error&&<Alert type="error" header="Unable to sign in">{error}</Alert>}
                  </SpaceBetween>
                </Form>
              </form>}
          </Container>
          {challenge&&methods.includes('recovery')&&!enrollment&&<Box textAlign="center"><Link data-testid="account-recovery-link" href={recoveryHash} onFollow={event=>{event.preventDefault();if(!busy)navigateRecovery(true);}}>Can't use your authenticator?</Link></Box>}
        </>}
        <Box textAlign="center" color="text-body-secondary">Sign in with your private PoC account.</Box>
      </SpaceBetween></div>
    </ContentLayout>
  </main>;
}
