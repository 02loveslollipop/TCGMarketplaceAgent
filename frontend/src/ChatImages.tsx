import {useMemo} from 'react';
import {FileTokenGroup} from '@cloudscape-design/components';
import type {ImageContext} from './contracts';
export const MAX_IMAGES=3,MAX_IMAGE_BYTES=2*1024*1024;
export const IMAGE_TYPES=['image/png','image/jpeg','image/webp'];
export function readImage(file:File):Promise<ImageContext>{
  if(!IMAGE_TYPES.includes(file.type))return Promise.reject(new Error('Use PNG, JPEG or WebP images.'));
  if(!file.size||file.size>MAX_IMAGE_BYTES)return Promise.reject(new Error('Each image must be at most 2 MiB.'));
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('The image could not be read. Try attaching it again.'));reader.onload=()=>resolve({name:(file.name||'Pasted image').slice(0,160),media_type:file.type,data_url:String(reader.result)});reader.readAsDataURL(file);});
}
export function imageFile(image:ImageContext){
  const bytes=Uint8Array.from(atob(image.data_url.split(',')[1]),character=>character.charCodeAt(0));
  return new File([bytes],image.name,{type:image.media_type});
}
export function ImageAttachments({images,onRemove,disabled}:{images:ImageContext[];onRemove:(index:number)=>void;disabled:boolean}){
  const files=useMemo(()=>images.map(image=>({file:imageFile(image)})),[images]);
  return <FileTokenGroup items={files} showFileThumbnail showFileSize readOnly={disabled} alignment="horizontal" onDismiss={({detail})=>onRemove(detail.fileIndex)} i18nStrings={{removeFileAriaLabel:(_,name)=>`Remove ${name}`,errorIconAriaLabel:'Image error',warningIconAriaLabel:'Image warning'}}/>;
}
export function SentImages({images}:{images:ImageContext[]}){
  return images.length?<div className="chat-image-context" aria-label="Attached image context">{images.map((image,index)=><figure key={`${index}-${image.name}`}><img src={image.data_url} alt={`Image context: ${image.name}`}/><figcaption>{image.name}</figcaption></figure>)}</div>:null;
}
