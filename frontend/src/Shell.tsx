import {useEffect,useState} from 'react';
import {Alert,AppLayout,Box,BreadcrumbGroup,Container,ContentLayout,Header,KeyValuePairs,SideNavigation,SpaceBetween,SplitPanel,TopNavigation,StatusIndicator,Flashbar} from '@cloudscape-design/components';
import AppLayoutToolbar from '@cloudscape-design/components/app-layout-toolbar';
import {Login} from './Login';
import {Chat} from './Chat';
import {Admin} from './Admin';
import type {AdminSection} from './Admin';
import {TotpSettings} from './TotpSettings';
import {WebAuthnSettings} from './WebAuthn';
import {RecoverySettings} from './Recovery';
import {Preferences} from './Preferences';
import {canAdmin,permits,roleLabel} from './iam';
import {api,portalUrl,redirectToChat,registerTokenRefresher,setLatestToken} from './client';
import type {Session} from './contracts';
import type {AppLayoutProps} from '@cloudscape-design/components';
import {ArtifactContent,artifactTitle,type ChatArtifact} from './ChatArtifacts';
import './workspace.css';
import {appearanceOptions,setAppearance,useAppearance} from './appearance';
import type {Appearance} from './appearance';

type Page=AdminSection|'chat'|'security'|'preferences';
export function Shell({admin=false}:{admin?:boolean}) {
  const appearance=useAppearance();
  const [navigationOpen,setNavigationOpen]=useState(true);
  const [chatNavigation,setChatNavigation]=useState<HTMLDivElement|null>(null);
  const [artifact,setArtifact]=useState<ChatArtifact|null>(null),[artifactOpen,setArtifactOpen]=useState(false),[panelSize,setPanelSize]=useState(()=>{try{const size=Number(localStorage.getItem('tcg-result-preview-size'));return size>=280&&size<=1800?size:580;}catch{return 580;}});
  const [panelPreferences,setPanelPreferences]=useState<AppLayoutProps.SplitPanelPreferences>({position:'side'});
  function preview(value:ChatArtifact|null){setArtifact(value);setArtifactOpen(!!value);}
  const allowed:Page[]=admin?['overview','accounts','models','roles','principals','activity','consumption','security']:['chat','preferences','security'];
  const initial=allowed.includes(window.location.hash.slice(1) as Page)?window.location.hash.slice(1) as Page:admin?'overview':'chat';
  const [checkingSession,setCheckingSession]=useState(true);
  const [token,setToken]=useState(''),[user,setUser]=useState<Session|null>(null),[notice,setNotice]=useState(''),[page,setPage]=useState<Page>(initial),[adminSection,setAdminSection]=useState<AdminSection>(initial==='accounts'||initial==='models'||initial==='roles'||initial==='principals'||initial==='activity'||initial==='consumption'?initial:'overview');
  useEffect(()=>{
    document.body.classList.add('awsui-visual-refresh');
    const navigate=()=>{const next=window.location.hash.slice(1) as Page;if(allowed.includes(next)){setPage(next);if(next==='overview'||next==='accounts'||next==='models'||next==='roles'||next==='principals'||next==='activity'||next==='consumption')setAdminSection(next);}};
    window.addEventListener('hashchange',navigate);return ()=>window.removeEventListener('hashchange',navigate);
  },[admin,user]);
  useEffect(()=>{
    registerTokenRefresher(async () => {
      try {
        const res = await api<{ access_token: string; user?: Session; session?: Session }>('/api/auth/portal-session', '', { method: 'GET' });
        if (res?.access_token) {
          setToken(res.access_token);
          setLatestToken(res.access_token);
          const s = res.session || res.user;
          if (s?.id) setUser(s);
          return res.access_token;
        }
      } catch {
        // ignore
      }
      return null;
    });
  },[]);
  useEffect(()=>{
    setLatestToken(token);
    if (!token) return;
    const interval = setInterval(() => {
      void api<{ access_token: string; user?: Session; session?: Session }>('/api/auth/portal-session', '', { method: 'GET' })
        .then(res => {
          if (res?.access_token) {
            setToken(res.access_token);
            setLatestToken(res.access_token);
            const s = res.session || res.user;
            if (s?.id) setUser(s);
          }
        })
        .catch(() => {});
    }, 10 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void api<{ access_token: string; user?: Session; session?: Session }>('/api/auth/portal-session', '', { method: 'GET' })
          .then(res => {
            if (res?.access_token) {
              setToken(res.access_token);
              setLatestToken(res.access_token);
              const s = res.session || res.user;
              if (s?.id) setUser(s);
            }
          })
          .catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  },[token]);
  useEffect(()=>{
    let active=true;
    void api<{access_token:string;user:Session;session:Session}>('/api/auth/portal-session','').then(result=>{
      if(active&&result?.access_token){
        setToken(result.access_token);
        setLatestToken(result.access_token);
        const s = result.session || result.user;
        if (s?.id) setUser(s);
      }
    }).catch(()=>{}).finally(()=>{if(active)setCheckingSession(false);});
    return ()=>{active=false;};
  },[]);
  useEffect(()=>{if(admin&&user&&!canAdmin(user))redirectToChat();},[admin,user]);
  async function signedIn(access:string,account:Session){
    setToken(access);setNotice('');
    try{await api('/api/auth/portal-session',access,{method:'POST'});}
    catch{setNotice('Signed in, but the shared portal session could not be saved. Switching portals may require signing in again.');}
    setUser(account);
  }
  function navigate(next:Page){setPage(next);if(next==='overview'||next==='accounts'||next==='models'||next==='roles'||next==='principals'||next==='activity'||next==='consumption')setAdminSection(next);window.location.hash=next;}
  function clear(){setToken('');setLatestToken('');setUser(null);setArtifact(null);setArtifactOpen(false);}
  function securityChanged(message:string){setNotice(message);clear();}
  async function signOut(){try{await api('/api/auth/logout',token,{method:'POST'});}catch{setNotice('Signed out locally. Server session invalidation could not be confirmed.');}finally{clear();}}
  if(checkingSession)return <Box padding="l"><StatusIndicator type="loading">Checking your session</StatusIndicator></Box>;
  if(!user)return <Login notice={notice} onLogin={signedIn}/>;
  if(admin&&!canAdmin(user))return <Box padding="l"><StatusIndicator type="loading">Opening chat</StatusIndicator></Box>;
  const Layout=admin?AppLayout:AppLayoutToolbar;
  const chatMode=!admin&&page==='chat';
  const labels:Record<Page,string>={overview:'Overview',accounts:'Accounts',models:'Model policies',roles:'IAM roles and policies',principals:'API principals',consumption:'Consumption',activity:'Activity and legality',chat:'Deck agent',preferences:'Agent preferences',security:'Account security'};
  return <>
    <div id="workspace-top-navigation"><TopNavigation identity={{title:'Pokémon TCG Marketplace',href:admin?'#overview':'#chat',onFollow:event=>{event.preventDefault();navigate(admin?'overview':'chat');}}} utilities={[
      ...(admin||canAdmin(user)?[{type:'button' as const,text:admin?'Open chat':'Admin portal',href:admin?(import.meta.env.VITE_CHAT_WEB_URL||'/'):(import.meta.env.VITE_ADMIN_WEB_URL||'/admin/')}]:[]),
      {type:'menu-dropdown',text:`Appearance: ${appearanceOptions.find(item=>item.value===appearance)!.label}`,items:appearanceOptions.map(item=>({id:item.value,text:item.label})),onItemClick:({detail})=>setAppearance(detail.id as Appearance)},
      {type:'menu-dropdown',text:user.username,iconName:'user-profile',description:roleLabel(user),items:[{id:'preferences',text:'Agent preferences'},{id:'security',text:'Account security'},{id:'sign-out',text:'Sign out'}],onItemClick:({detail})=>{if(detail.id==='preferences'){if(admin)window.location.assign(`${portalUrl('chat')}#preferences`);else navigate('preferences');}if(detail.id==='security')navigate('security');if(detail.id==='sign-out')void signOut();}}
    ]} i18nStrings={{overflowMenuTriggerText:'More',overflowMenuTitleText:'More options',overflowMenuBackIconAriaLabel:'Back',overflowMenuDismissIconAriaLabel:'Close menu'}}/></div>
    <Layout notifications={notice?<Flashbar items={[{id:'session-notice',type:'warning',content:notice,dismissible:true,onDismiss:()=>setNotice('')}]}/>:undefined} navigationWidth={chatMode?340:280} navigationOpen={navigationOpen} onNavigationChange={({detail})=>setNavigationOpen(detail.open)} splitPanelOpen={artifactOpen} onSplitPanelToggle={({detail})=>setArtifactOpen(detail.open)} splitPanelSize={panelSize} onSplitPanelResize={({detail})=>{setPanelSize(detail.size);try{localStorage.setItem('tcg-result-preview-size',String(detail.size));}catch{/* Resizing works even when browser storage is unavailable. */}}} splitPanelPreferences={panelPreferences} onSplitPanelPreferencesChange={({detail})=>setPanelPreferences(detail)} splitPanel={artifact&&page==='chat'?<SplitPanel header={artifactTitle(artifact)} closeBehavior="hide" headerDescription="Review card details, quotations and dated source evidence." i18nStrings={{closeButtonAriaLabel:'Close result preview',openButtonAriaLabel:'Open result preview',resizeHandleAriaLabel:'Resize result preview',resizeHandleTooltipText:'Drag to resize the preview and chat, or use the arrow keys',preferencesTitle:'Result preview position',preferencesPositionLabel:'Position',preferencesPositionDescription:'Choose where to review the result.',preferencesPositionSide:'Side',preferencesPositionBottom:'Bottom',preferencesConfirm:'Confirm',preferencesCancel:'Cancel'}}><ArtifactContent artifact={artifact}/></SplitPanel>:undefined} ariaLabels={{navigation:'Workspace navigation',navigationToggle:'Open navigation',navigationClose:'Close navigation'}} headerSelector="#workspace-top-navigation" toolsHide contentType="default" navigation={<><div hidden={!chatMode} className="chat-navigation-host" ref={setChatNavigation}/><div hidden={chatMode}><SideNavigation data-testid="workspace-navigation" header={{href:admin?'#overview':'#chat',text:admin?'Administration':'Deck workspace'}} activeHref={`#${page}`} onFollow={event=>{if(!event.detail.external){event.preventDefault();navigate(event.detail.href.slice(1) as Page);}}} items={[
      ...(admin?[{type:'link' as const,text:'Overview',href:'#overview'},{type:'link' as const,text:'Consumption',href:'#consumption'},{type:'link' as const,text:'Accounts',href:'#accounts'},{type:'link' as const,text:'Model policies',href:'#models'},{type:'link' as const,text:'IAM roles and policies',href:'#roles'},{type:'link' as const,text:'API principals',href:'#principals'},{type:'link' as const,text:'Activity and legality',href:'#activity'}].filter(item=>item.href==='#overview'||permits(user,({'#accounts':'admin:accounts:read','#models':'admin:models:read','#roles':'iam:roles:read','#principals':'iam:principals:read','#activity':'admin:activity:read','#consumption':'admin:usage:read'} as Record<string,string>)[item.href])):[{type:'link' as const,text:'Deck agent',href:'#chat'},{type:'link' as const,text:'Agent preferences',href:'#preferences'}]),
      {type:'divider'},{type:'link',text:'Account security',href:'#security'}
    ]}/></div></>} breadcrumbs={chatMode?undefined:<BreadcrumbGroup items={[{text:admin?'Administration':'Deck workspace',href:admin?'#overview':'#chat'},{text:labels[page],href:`#${page}`}]} onFollow={event=>{event.preventDefault();navigate(event.detail.href.slice(1) as Page);}}/>} content={<>
      <div className={!admin?'chat-route':undefined} hidden={page==='security'||page==='preferences'}>{admin?(canAdmin(user)?<ContentLayout><Admin onSessionChange={()=>securityChanged('Your role changed. Sign in again to continue.')} token={token} session={user} section={adminSection} onNavigate={navigate}/></ContentLayout>:<Alert type="error">Administrator access required.</Alert>):<Chat token={token} onPreview={preview} navigationContainer={chatNavigation} onConversationSelected={()=>{if(window.matchMedia('(max-width: 688px)').matches)setNavigationOpen(false);}}/>}</div>
      {page==='preferences'&&<div><ContentLayout><Preferences token={token}/></ContentLayout></div>}
      {page==='security'&&<div><ContentLayout><SpaceBetween size="l">
        <Header variant="h1" description="Manage the methods you use to sign in and recover access.">Account security</Header>
        <Container header={<Header variant="h2">Your account</Header>}><KeyValuePairs columns={3} items={[{label:'Username',value:user.username},{label:'Role',value:roleLabel(user)},{label:'Authenticator app',value:user.totp_enrolled?'Enrolled':'Not enrolled'},{label:'Passkeys and security keys',value:`${user.webauthn_credentials_count} enrolled`}]}/></Container>
        <SpaceBetween size="l">
          <TotpSettings embedded token={token} enrolled={user.totp_enrolled} onEnrollment={()=>securityChanged('Authenticator app updated. Sign in again to continue.')}/>
          <WebAuthnSettings embedded token={token} onChange={()=>securityChanged('Authenticator settings updated. Sign in again to continue.')}/>
          <RecoverySettings token={token} onFinish={()=>securityChanged('Recovery codes updated. Sign in again to continue.')}/>
        </SpaceBetween>
        <Box color="text-body-secondary">Keep a recovery method available before changing your sign-in methods.</Box>
      </SpaceBetween></ContentLayout></div>}
    </>}/>
  </>;
}
