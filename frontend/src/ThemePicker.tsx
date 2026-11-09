import {FormField,Select} from '@cloudscape-design/components';
import {colorTextHomeHeaderDefault} from '@cloudscape-design/design-tokens';
import {appearanceOptions,setAppearance,useAppearance} from './appearance';
import type {Appearance} from './appearance';
export function ThemePicker(){
 const appearance=useAppearance();
 return <FormField label={<span style={{color:colorTextHomeHeaderDefault}}>Appearance</span>}><Select data-testid="appearance-select" options={appearanceOptions} selectedOption={appearanceOptions.find(item=>item.value===appearance)!} onChange={({detail})=>setAppearance(detail.selectedOption.value as Appearance)}/></FormField>;
}
