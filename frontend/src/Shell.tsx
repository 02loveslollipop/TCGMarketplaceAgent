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
import {api,redirectToChat} from './client';
import type {Session} from './contracts';
import type {AppLayoutProps} from '@cloudscape-design/components';
import {ArtifactContent,artifactTitle,type ChatArtifact} from './ChatArtifacts';
import './workspace.css';
import {appearanceOptions,setAppearance,useAppearance} from './appearance';
import type {Appearance} from './appearance';

type Page=AdminSection|'chat'|'security';
export function Shell({admin=false}:{admin?:boolean}) {
  const appearance=useAppearance();
  const [navigationOpen,setNavigationOpen]=useState(true);
  const [chatNavigation,setChatNavigation]=useState<HTMLDivElement|null>(null);
  const [artifact,setArtifact]=useState<ChatArtifact|null>(null),[artifactOpen,setArtifactOpen]=useState(false),[panelSize,setPanelSize]=useState(580);
  const [panelPreferences,setPanelPreferences]=useState<AppLayoutProps.SplitPanelPreferences>({position:'side'});
  function preview(value:ChatArtifact|null){setArtifact(value);setArtifactOpen(!!value);}
  const allowed:Page[]=admin?['overview','accounts','models','roles','security']:['chat','security'];
  const initial=allowed.includes(window.location.hash.slice(1) as Page)?window.location.hash.slice(1) as Page:admin?'overview':'chat';
  const [checkingSession,setCheckingSession]=useState(true);
  const [token,setToken]=useState(''),[user,setUser]=useState<Session|null>(null),[notice,setNotice]=useState(''),[page,setPage]=useState<Page>(initial),[adminSection,setAdminSection]=useState<AdminSection>(initial==='accounts'||initial==='models'||initial==='roles'?initial:'overview');
  useEffect(()=>{
    document.body.classList.add('awsui-visual-refresh');
    const navigate=()=>{const next=window.location.hash.slice(1) as Page;if(allowed.includes(next)){setPage(next);if(next==='overview'||next==='accounts'||next==='models'||next==='roles')setAdminSection(next);}};
    window.addEventListener('hashchange',navigate);return ()=>window.removeEventListener('hashchange',navigate);
  },[admin,user]);
  useEffect(()=>{
    let active=true;
    void api<{access_token:string;user:Session}>('/api/auth/portal-session','').then(result=>{if(active&&result?.access_token&&result.user?.id){setToken(result.access_token);setUser(result.user);}}).catch(()=>{}).finally(()=>{if(active)setCheckingSession(false);});
    return ()=>{active=false;};
  },[]);
  useEffect(()=>{if(admin&&user&&user.role!=='admin')redirectToChat();},[admin,user]);
  function signedIn(access:string,account:Session){setToken(access);setUser(account);setNotice('');void api('/api/auth/portal-session',access,{method:'POST'}).catch(()=>setNotice('Signed in, but the shared portal session could not be saved. Switching portals may require signing in again.'));}
  function navigate(next:Page){setPage(next);if(next==='overview'||next==='accounts'||next==='models'||next==='roles')setAdminSection(next);window.location.hash=next;}
  function clear(){setToken('');setUser(null);setArtifact(null);setArtifactOpen(false);}
  function securityChanged(message:string){setNotice(message);clear();}
  async function signOut(){try{await api('/api/auth/logout',token,{method:'POST'});}catch{setNotice('Signed out locally. Server session invalidation could not be confirmed.');}finally{clear();}}
  if(checkingSession)return <Box padding="l"><StatusIndicator type="loading">Checking your session</StatusIndicator></Box>;
  if(!user)return <Login notice={notice} onLogin={signedIn}/>;
  if(admin&&user.role!=='admin')return <Box padding="l"><StatusIndicator type="loading">Opening chat</StatusIndicator></Box>;
  const Layout=admin?AppLayout:AppLayoutToolbar;
  const chatMode=!admin&&page==='chat';
  const labels:Record<Page,string>={overview:'Overview',accounts:'Accounts',models:'Model policies',roles:'Role access and quotas',chat:'Deck agent',security:'Account security'};
  return <>
    <div id="workspace-top-navigation"><TopNavigation identity={{title:'Pokémon TCG Marketplace',href:admin?'#overview':'#chat',onFollow:event=>{event.preventDefault();navigate(admin?'overview':'chat');}}} utilities={[
      ...(admin||user.role==='admin'?[{type:'button' as const,text:admin?'Open chat':'Admin portal',href:admin?(import.meta.env.VITE_CHAT_WEB_URL||'/'):(import.meta.env.VITE_ADMIN_WEB_URL||'/admin/')}]:[]),
      {type:'menu-dropdown',text:`Appearance: ${appearanceOptions.find(item=>item.value===appearance)!.label}`,items:appearanceOptions.map(item=>({id:item.value,text:item.label})),onItemClick:({detail})=>setAppearance(detail.id as Appearance)},
      {type:'menu-dropdown',text:user.username,iconName:'user-profile',description:user.role==='admin'?'Administrator':'Private workspace',items:[{id:'security',text:'Account security'},{id:'sign-out',text:'Sign out'}],onItemClick:({detail})=>{if(detail.id==='security')navigate('security');if(detail.id==='sign-out')void signOut();}}
    ]} i18nStrings={{overflowMenuTriggerText:'More',overflowMenuTitleText:'More options',overflowMenuBackIconAriaLabel:'Back',overflowMenuDismissIconAriaLabel:'Close menu'}}/></div>
    <Layout notifications={notice?<Flashbar items={[{id:'session-notice',type:'warning',content:notice,dismissible:true,onDismiss:()=>setNotice('')}]}/>:undefined} navigationWidth={chatMode?340:280} navigationOpen={navigationOpen} onNavigationChange={({detail})=>setNavigationOpen(detail.open)} splitPanelOpen={artifactOpen} onSplitPanelToggle={({detail})=>setArtifactOpen(detail.open)} splitPanelSize={panelSize} onSplitPanelResize={({detail})=>setPanelSize(detail.size)} splitPanelPreferences={panelPreferences} onSplitPanelPreferencesChange={({detail})=>setPanelPreferences(detail)} splitPanel={artifact&&page==='chat'?<SplitPanel header={artifactTitle(artifact)} closeBehavior="hide" headerDescription="Review card details, quotations and dated source evidence." i18nStrings={{closeButtonAriaLabel:'Close result preview',openButtonAriaLabel:'Open result preview',resizeHandleAriaLabel:'Resize result preview',preferencesTitle:'Result preview position',preferencesPositionLabel:'Position',preferencesPositionDescription:'Choose where to review the result.',preferencesPositionSide:'Side',preferencesPositionBottom:'Bottom',preferencesConfirm:'Confirm',preferencesCancel:'Cancel'}}><ArtifactContent artifact={artifact}/></SplitPanel>:undefined} ariaLabels={{navigation:'Workspace navigation',navigationToggle:'Open navigation',navigationClose:'Close navigation'}} headerSelector="#workspace-top-navigation" toolsHide contentType="default" navigation={<><div hidden={!chatMode} className="chat-navigation-host" ref={setChatNavigation}/><div hidden={chatMode}><SideNavigation data-testid="workspace-navigation" header={{href:admin?'#overview':'#chat',text:admin?'Administration':'Deck workspace'}} activeHref={`#${page}`} onFollow={event=>{if(!event.detail.external){event.preventDefault();navigate(event.detail.href.slice(1) as Page);}}} items={[
      ...(admin?[{type:'link' as const,text:'Overview',href:'#overview'},{type:'link' as const,text:'Accounts',href:'#accounts'},{type:'link' as const,text:'Model policies',href:'#models'},{type:'link' as const,text:'Role access and quotas',href:'#roles'}]:[{type:'link' as const,text:'Deck agent',href:'#chat'}]),
      {type:'divider'},{type:'link',text:'Account security',href:'#security'}
    ]}/></div></>} breadcrumbs={chatMode?undefined:<BreadcrumbGroup items={[{text:admin?'Administration':'Deck workspace',href:admin?'#overview':'#chat'},{text:labels[page],href:`#${page}`}]} onFollow={event=>{event.preventDefault();navigate(event.detail.href.slice(1) as Page);}}/>} content={<>
      <div className={!admin?'chat-route':undefined} hidden={page==='security'}>{admin?(user.role==='admin'?<ContentLayout><Admin onSessionChange={()=>securityChanged('Your role changed. Sign in again to continue.')} token={token} section={adminSection} onNavigate={navigate}/></ContentLayout>:<Alert type="error">Administrator access required.</Alert>):<Chat token={token} onPreview={preview} navigationContainer={chatNavigation} onConversationSelected={()=>{if(window.matchMedia('(max-width: 688px)').matches)setNavigationOpen(false);}}/>}</div>
      {page==='security'&&<div><ContentLayout><SpaceBetween size="l">
        <Header variant="h1" description="Manage the methods you use to sign in and recover access.">Account security</Header>
        <Container header={<Header variant="h2">Your account</Header>}><KeyValuePairs columns={3} items={[{label:'Username',value:user.username},{label:'Role',value:user.role==='admin'?'Administrator':'User'},{label:'Authenticator app',value:user.totp_enrolled?'Enrolled':'Not enrolled'},{label:'Passkeys and security keys',value:`${user.webauthn_credentials_count} enrolled`}]}/></Container>
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
