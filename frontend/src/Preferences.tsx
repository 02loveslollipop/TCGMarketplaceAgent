import {useEffect,useState} from 'react';
import {Alert,Box,Button,Container,Form,FormField,Header,Input,RadioGroup,Select,SpaceBetween,StatusIndicator} from '@cloudscape-design/components';
import {api} from './client';
import type {UserPreferences} from './contracts';
import {settingsInputAttributes} from './inputSemantics';

const commonCurrencies=['USD','EUR','JPY','COP','GBP','CAD','AUD','CHF','CNY','KRW','BRL','MXN','INR','CLP'];
const currencyNames:Record<string,string>={USD:'US dollar',EUR:'Euro',JPY:'Japanese yen',COP:'Colombian peso',GBP:'Pound sterling',CAD:'Canadian dollar',AUD:'Australian dollar',CHF:'Swiss franc',CNY:'Chinese yuan',KRW:'South Korean won',BRL:'Brazilian real',MXN:'Mexican peso',INR:'Indian rupee',CLP:'Chilean peso'};
export function Preferences({token}:{token:string}) {
  const [ruleset,setRuleset]=useState<UserPreferences['ruleset']>('auto');
  const [format,setFormat]=useState<UserPreferences['format']>('auto');
  const [location,setLocation]=useState(''),[currency,setCurrency]=useState<string|null>(null);
  const [currencies,setCurrencies]=useState(commonCurrencies),[currencyWarning,setCurrencyWarning]=useState('');
  const [loading,setLoading]=useState(true),[loaded,setLoaded]=useState(false),[saving,setSaving]=useState(false);
  const [error,setError]=useState(''),[success,setSuccess]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    let active=true;
    setLoading(true);
    void api<UserPreferences>('/api/chat/preferences',token).then(value=>{
      if(active){setRuleset(value.ruleset);setFormat(value.format);setLocation(value.location||'');setCurrency(value.target_currency||null);setLoaded(true);setError('');}
    }).catch(error=>{if(active)setError(error.message||'Preferences could not be loaded.');}).finally(()=>{if(active)setLoading(false);});
    void api<string[]>('/api/chat/currencies',token).then(value=>{
      if(!Array.isArray(value)||!value.every(code=>typeof code==='string'&&/^[A-Z]{3}$/.test(code)))throw new Error('Unavailable currency list');
      if(active){setCurrencies(value);setCurrencyWarning('');}
    }).catch(()=>{if(active)setCurrencyWarning('The full currency list is unavailable. Common currencies and your saved choice remain available.');});
    return ()=>{active=false;};
    // Session renewal must not overwrite an unsaved preference draft.
  },[retry]);
  const options=[{value:'original',label:'Original supplier currencies'},...[...new Set([...currencies,...(currency?[currency]:[])])].sort().map(code=>({value:code,label:currencyNames[code]?`${code} — ${currencyNames[code]}`:code}))];
  async function save(){
    setSaving(true);setError('');setSuccess('');
    try{
      await api<UserPreferences>('/api/chat/preferences',token,{method:'PUT',body:JSON.stringify({ruleset,format,location:location.trim(),target_currency:currency})});
      setSuccess('Preferences saved. New requests will use these settings.');
    }catch(error){setError((error as Error).message);}finally{setSaving(false);}
  }
  return <SpaceBetween size="l">
    <Header variant="h1" description="Set defaults for new requests. Running requests keep the preferences they started with.">Agent preferences</Header>
    {success&&<Alert type="success" dismissible onDismiss={()=>setSuccess('')}>{success}</Alert>}
    {error&&<Alert type="error" header="Preferences unavailable" action={!loaded?<Button onClick={()=>setRetry(value=>value+1)}>Retry</Button>:undefined}>{error}</Alert>}
    {loading?<StatusIndicator type="loading">Loading preferences</StatusIndicator>:<Form actions={<Button variant="primary" loading={saving} disabled={!loaded} onClick={()=>void save()}>Save preferences</Button>}>
      <SpaceBetween size="l">
        <Container header={<Header variant="h2" description="Choose the rules to research, or let the agent resolve them and ask when the choice changes the deck.">Deck rules</Header>}>
          <SpaceBetween size="l">
            <FormField label="Ruleset"><RadioGroup value={ruleset} onChange={({detail})=>setRuleset(detail.value as UserPreferences['ruleset'])} items={[
              {value:'auto',label:'Auto',description:'Resolve from the request. Ask when the rulesets would produce different results.'},
              {value:'international',label:'International (Play! Pokémon)'},
              {value:'japan',label:'Japan (Pokémon Card Game)'},
            ]}/></FormField>
            <FormField label="Format"><RadioGroup value={format} onChange={({detail})=>setFormat(detail.value as UserPreferences['format'])} items={[
              {value:'auto',label:'Auto',description:'Use the requested cards and deck context to resolve the format.'},
              {value:'standard',label:'Standard',description:'Current rotation and applicable card rules.'},
              {value:'expanded',label:'Expanded / Extra',description:'Expanded card pool and applicable banned-card rules.'},
            ]}/></FormField>
          </SpaceBetween>
        </Container>
        <Container header={<Header variant="h2" description="Guide price research and choose how buying costs are displayed.">Buying preferences</Header>}>
          <SpaceBetween size="l">
            <FormField label="Shopping location" description="Optional city, region, or country. This guides market research and does not exclude other suppliers or guarantee delivery.">
              <Input value={location} type="search" onChange={({detail})=>setLocation(detail.value)} placeholder="For example, Tokyo, Japan or Medellín, Colombia" name="shopping-location" autoComplete="off" nativeInputAttributes={{...settingsInputAttributes,maxLength:160}}/>
            </FormField>
            <FormField label="Target currency" description="Converted estimates appear first. Original supplier prices and the exchange rate remain available. Fees and unknown shipping are excluded.">
              <Select selectedOption={options.find(option=>option.value===(currency||'original'))!} options={options} filteringType="auto" filteringPlaceholder="Find a currency" filteringAriaLabel="Find a currency" onChange={({detail})=>setCurrency(detail.selectedOption.value==='original'?null:detail.selectedOption.value||null)}/>
            </FormField>
            {currencyWarning&&<Box color="text-status-warning">{currencyWarning}</Box>}
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </Form>}
  </SpaceBetween>;
}
