import {useSyncExternalStore} from 'react';
import {applyMode,Mode} from '@cloudscape-design/global-styles';
export type Appearance='light'|'dark'|'dark-blue';
export const appearanceOptions=[{value:'light',label:'Light'},{value:'dark',label:'Dark'},{value:'dark-blue',label:'Dark blue'}];
const key='tcg-marketplace-appearance';
const valid=(value:string|null):Appearance=>value==='dark'||value==='dark-blue'?value:'light';
function saved():Appearance{try{return valid(localStorage.getItem(key));}catch{return 'light';}}
let current=saved();
function apply(){applyMode(current==='light'?Mode.Light:Mode.Dark);document.body.dataset.colorTheme=current;}
export function initializeAppearance(){apply();}
export function setAppearance(value:Appearance){current=value;apply();try{localStorage.setItem(key,value);}catch{/* The choice still applies if storage is unavailable. */}window.dispatchEvent(new Event('tcg-appearance'));}
function subscribe(listener:()=>void){
 const storage=(event:StorageEvent)=>{if(event.key===key){current=valid(event.newValue);apply();listener();}};
 window.addEventListener('tcg-appearance',listener);window.addEventListener('storage',storage);
 return ()=>{window.removeEventListener('tcg-appearance',listener);window.removeEventListener('storage',storage);};
}
export function useAppearance(){return useSyncExternalStore(subscribe,()=>current);}
