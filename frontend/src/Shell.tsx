import {useState} from 'react';
import {Alert,AppLayout,Box,Button,ContentLayout,Header,Link,SpaceBetween} from '@cloudscape-design/components';
import {Login} from './Login';
import {Chat} from './Chat';
import {Admin} from './Admin';
import {TotpSettings} from './TotpSettings';
import {WebAuthnSettings} from './WebAuthn';
import {RecoverySettings} from './Recovery';
import {api} from './client';
import type {Session} from './contracts';

export function Shell({admin=false}:{admin?:boolean}) {
  const [token,setToken]=useState(''),[user,setUser]=useState<Session|null>(null),[notice,setNotice]=useState('');
  function clear(){setToken('');setUser(null);}
  async function signOut(){try{await api('/api/auth/logout',token,{method:'POST'});}catch{setNotice('Signed out locally. Server session invalidation could not be confirmed.');}finally{clear();}}
  if(!user)return <Login notice={notice} onLogin={(token,user)=>{setToken(token);setUser(user);setNotice('');}}/>;
  return <AppLayout navigationHide toolsHide content={<ContentLayout header={<Header variant="h1" actions={<SpaceBetween direction="horizontal" size="s"><Link data-testid="portal-switch-link" href={admin?(import.meta.env.VITE_CHAT_WEB_URL || '/'): (import.meta.env.VITE_ADMIN_WEB_URL || '/admin/')}>{admin?'Chat':'Admin portal'}</Link><Button data-testid="logout-button" onClick={()=>void signOut()}>Sign out</Button></SpaceBetween>}>Pokémon TCG · Private PoC</Header>}>
    <SpaceBetween size="l">
      <Box>Signed in as {user.username}</Box>
      {admin?(user.role==='admin'?<Admin token={token}/>:<Alert type="error">Administrator access required.</Alert>):<Chat token={token}/>}
      <TotpSettings token={token} enrolled={user.totp_enrolled} onEnrollment={clear}/>
      <WebAuthnSettings token={token} onChange={()=>{setNotice('Authenticator settings updated. Sign in again to continue.');clear();}}/>
      <RecoverySettings token={token} onFinish={()=>{setNotice('Recovery codes updated. Sign in again to continue.');clear();}}/>
    </SpaceBetween>
  </ContentLayout>}/>;
}
