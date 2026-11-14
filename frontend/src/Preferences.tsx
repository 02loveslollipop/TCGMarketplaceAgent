import {useEffect,useState} from 'react';
import {Alert,Box,Button,Container,Form,FormField,Header,Input,RadioGroup,Select,SpaceBetween,StatusIndicator} from '@cloudscape-design/components';
import {ApiError,api,useClientTransport,type AuthMode} from './client';
import type {Session,UserPreferences} from './contracts';
import {permits,roleLabel} from './iam';
import {settingsInputAttributes} from './inputSemantics';

const commonCurrencies=['USD','EUR','JPY','COP','GBP','CAD','AUD','CHF','CNY','KRW','BRL','MXN','INR','CLP'];
const currencyNames:Record<string,string>={USD:'US dollar',EUR:'Euro',JPY:'Japanese yen',COP:'Colombian peso',GBP:'Pound sterling',CAD:'Canadian dollar',AUD:'Australian dollar',CHF:'Swiss franc',CNY:'Chinese yuan',KRW:'South Korean won',BRL:'Brazilian real',MXN:'Mexican peso',INR:'Indian rupee',CLP:'Chilean peso'};

export interface PreferencesProps {
  token: string;
  authMode?: AuthMode;
  onUnauthorized?: (error: ApiError) => void;
  session?: Session | null;
}

export function Preferences({token,authMode,onUnauthorized,session}:PreferencesProps) {
  const transport=useClientTransport();
  const effectiveAuthMode=authMode??transport.authMode;
  const effectiveOnUnauthorized=onUnauthorized??transport.onUnauthorized;
  const authOptions=effectiveAuthMode==='api-token'?{authMode:effectiveAuthMode,onUnauthorized:effectiveOnUnauthorized}:undefined;
  const canReadPreferences=!session||permits(session,'agent:preferences:read');
  const canWritePreferences=!session||permits(session,'agent:preferences:write');
  const [ruleset,setRuleset]=useState<UserPreferences['ruleset']>('auto');
  const [format,setFormat]=useState<UserPreferences['format']>('auto');
  const [location,setLocation]=useState(''),[currency,setCurrency]=useState<string|null>(null);
  const [currencies,setCurrencies]=useState(commonCurrencies),[currencyWarning,setCurrencyWarning]=useState('');
  const [loading,setLoading]=useState(true),[loaded,setLoaded]=useState(false),[saving,setSaving]=useState(false);
  const [error,setError]=useState(''),[permissionDenied,setPermissionDenied]=useState(false),[success,setSuccess]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    let active=true;
    if(!canReadPreferences){
      setLoading(false);setLoaded(false);setPermissionDenied(true);
      setError('This API token does not permit agent:preferences:read. Existing principal defaults remain managed server-side.');
      return ()=>{active=false;};
    }
    setLoading(true);
    setPermissionDenied(false);
    void api<UserPreferences>('/api/chat/preferences',token,{},authOptions).then(value=>{
      if(active){setRuleset(value.ruleset);setFormat(value.format);setLocation(value.location||'');setCurrency(value.target_currency||null);setLoaded(true);setError('');setPermissionDenied(false);}
    }).catch(err=>{
      if(!active)return;
      if(err instanceof ApiError&&err.status===403){
        setPermissionDenied(true);
        setError(err.message||'This credential is not permitted to read agent preferences.');
      }else{
        setError((err as Error).message||'Preferences could not be loaded.');
      }
    }).finally(()=>{if(active)setLoading(false);});
    void api<string[]>('/api/chat/currencies',token,{},authOptions).then(value=>{
      if(!Array.isArray(value)||!value.every(code=>typeof code==='string'&&/^[A-Z]{3}$/.test(code)))throw new Error('Unavailable currency list');
      if(active){setCurrencies(value);setCurrencyWarning('');}
    }).catch(()=>{if(active)setCurrencyWarning('The full currency list is unavailable. Common currencies and your saved choice remain available.');});
    return ()=>{active=false;};
    // Session renewal must not overwrite an unsaved preference draft.
  },[retry,canReadPreferences]);
  const options=[{value:'original',label:'Original supplier currencies'},...[...new Set([...currencies,...(currency?[currency]:[])])].sort().map(code=>({value:code,label:currencyNames[code]?`${code} — ${currencyNames[code]}`:code}))];
  async function save(){
    if(!loaded||!canWritePreferences)return;
    setSaving(true);setError('');setSuccess('');
    try{
      await api<UserPreferences>('/api/chat/preferences',token,{method:'PUT',body:JSON.stringify({ruleset,format,location:location.trim(),target_currency:currency})},authOptions);
      setSuccess('Preferences saved. New requests will use these settings.');
    }catch(err){setError((err as Error).message);}finally{setSaving(false);}
  }
  const controlsDisabled=!canWritePreferences;
  return <SpaceBetween size="l">
    <Header variant="h1" description="Set defaults for new requests. Running requests keep the preferences they started with.">Agent preferences</Header>
    {effectiveAuthMode==='api-token'&&session&&<Alert type="info" header="Principal-owned preferences">{`These defaults belong to API principal ${session.username} (${roleLabel(session)}), not a signed-in human operator.`}</Alert>}
    {loaded&&!canWritePreferences&&<Alert type="info" header="Read-only preferences">This API token allows reading preferences but lacks agent:preferences:write to save updates.</Alert>}
    {success&&<Alert type="success" dismissible onDismiss={()=>setSuccess('')}>{success}</Alert>}
    {error&&<Alert type="error" header={permissionDenied?'Preferences permission denied':'Preferences unavailable'} action={!loaded&&!permissionDenied?<Button onClick={()=>setRetry(value=>value+1)}>Retry</Button>:undefined}>{error}</Alert>}
    {loading?<StatusIndicator type="loading">Loading preferences</StatusIndicator>:<Form actions={<Button variant="primary" loading={saving} disabled={!loaded||!canWritePreferences} onClick={()=>void save()}>Save preferences</Button>}>
      <SpaceBetween size="l">
        <Container header={<Header variant="h2" description="Choose the rules to research, or let the agent resolve them and ask when the choice changes the deck.">Deck rules</Header>}>
          <SpaceBetween size="l">
            <FormField label="Ruleset"><RadioGroup value={ruleset} onChange={({detail})=>setRuleset(detail.value as UserPreferences['ruleset'])} items={[
              {value:'auto',label:'Auto',description:'Resolve from the request. Ask when the rulesets would produce different results.',disabled:controlsDisabled},
              {value:'international',label:'International (Play! Pokémon)',disabled:controlsDisabled},
              {value:'japan',label:'Japan (Pokémon Card Game)',disabled:controlsDisabled},
            ]}/></FormField>
            <FormField label="Format"><RadioGroup value={format} onChange={({detail})=>setFormat(detail.value as UserPreferences['format'])} items={[
              {value:'auto',label:'Auto',description:'Use the requested cards and deck context to resolve the format.',disabled:controlsDisabled},
              {value:'standard',label:'Standard',description:'Current rotation and applicable card rules.',disabled:controlsDisabled},
              {value:'expanded',label:'Expanded / Extra',description:'Expanded card pool and applicable banned-card rules.',disabled:controlsDisabled},
            ]}/></FormField>
          </SpaceBetween>
        </Container>
        <Container header={<Header variant="h2" description="Guide price research and choose how buying costs are displayed.">Buying preferences</Header>}>
          <SpaceBetween size="l">
            <FormField label="Shopping location" description="Optional city, region, or country. This guides market research and does not exclude other suppliers or guarantee delivery.">
              <Input value={location} type="search" disabled={controlsDisabled} onChange={({detail})=>setLocation(detail.value)} placeholder="For example, Tokyo, Japan or Medellín, Colombia" name="shopping-location" autoComplete="off" nativeInputAttributes={{...settingsInputAttributes,maxLength:160}}/>
            </FormField>
            <FormField label="Target currency" description="Converted estimates appear first. Original supplier prices and the exchange rate remain available. Fees and unknown shipping are excluded.">
              <Select disabled={controlsDisabled} selectedOption={options.find(option=>option.value===(currency||'original'))!} options={options} filteringType="auto" filteringPlaceholder="Find a currency" filteringAriaLabel="Find a currency" onChange={({detail})=>setCurrency(detail.selectedOption.value==='original'?null:detail.selectedOption.value||null)}/>
            </FormField>
            {currencyWarning&&<Box color="text-status-warning">{currencyWarning}</Box>}
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </Form>}
  </SpaceBetween>;
}
