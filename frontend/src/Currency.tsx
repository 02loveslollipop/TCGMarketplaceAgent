import {Alert,Box,KeyValuePairs,Link,SpaceBetween} from '@cloudscape-design/components';
import type {CurrencyConversion} from './contracts';
import {safeHref} from './client';

export function Price({amount,currency,converted,conversion,original=false}:{amount:string;currency:string;converted?:string|null;conversion?:CurrencyConversion;original?:boolean}) {
  const available=conversion?.status==='available'&&converted!==undefined&&converted!==null&&currency!==conversion.target_currency;
  if(!available)return <>{amount} {currency}</>;
  return <SpaceBetween size="xxs">
    <Box fontWeight="bold">{original?`${amount} ${currency}`:`${converted} ${conversion.target_currency}`}</Box>
    <Box color="text-body-secondary" fontSize="body-s">{original?`Estimated equivalent: ${converted} ${conversion.target_currency}`:`Original: ${amount} ${currency}`}</Box>
  </SpaceBetween>;
}
export function ExchangeRateDetails({conversion}:{conversion?:CurrencyConversion}) {
  if(!conversion)return null;
  if(conversion.status==='unavailable')return <Alert type="warning" header="Currency conversion unavailable">{conversion.message||'Original supplier prices are shown. Try again later for a converted estimate.'}</Alert>;
  return <SpaceBetween size="s">
    <KeyValuePairs columns={3} items={Object.entries(conversion.rates||{}).map(([code,rate])=>({label:`1 ${code}`,value:`${Number(rate).toLocaleString('en-US',{maximumSignificantDigits:8})} ${conversion.target_currency}`}))}/>
    <Box color="text-body-secondary" fontSize="body-s">Exchange rates as of {conversion.as_of?new Date(conversion.as_of).toLocaleString():'Unknown'}. {conversion.source&&<Link external href={safeHref(conversion.source.url)}>{conversion.source.title}</Link>}</Box>
    <Box color="text-body-secondary">{conversion.notice}</Box>
  </SpaceBetween>;
}
