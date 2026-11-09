import {useState} from 'react';
import {ExpandableSection,FormField,Input,SpaceBetween} from '@cloudscape-design/components';
import {QRCodeSVG} from 'qrcode.react';

export function TotpSetup({secret,uri}:{secret:string;uri:string}) {
  const [expanded,setExpanded]=useState(false);
  return <SpaceBetween size="m">
    <div>Scan this QR code with your authenticator app, then enter the current code below.</div>
    <QRCodeSVG value={uri} size={224} level="M" marginSize={4} role="img" aria-label="Authenticator setup QR code"/>
    <ExpandableSection headerText="Can't scan the QR code?" expanded={expanded} onChange={({detail})=>setExpanded(detail.expanded)}>
      {expanded&&<FormField label="Setup key" description="Enter this key manually in your authenticator app.">
        <Input name="authenticator-setup-key" autoComplete="off" value={secret} readOnly/>
      </FormField>}
    </ExpandableSection>
  </SpaceBetween>;
}
