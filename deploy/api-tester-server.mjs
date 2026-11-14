import http from 'node:http';
import https from 'node:https';
import {readFileSync,unlinkSync,createReadStream,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function apiBase(value) {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid API base URL.');
  return url;
}

export function createTesterServer({root,authUrl,chatUrl,origin,tokenFile}) {
  const auth=apiBase(authUrl),chat=apiBase(chatUrl);
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
  return http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(!req.url.startsWith('/')||req.url.startsWith('//')){send(400,{detail:'Invalid request target.'});return;}
    const path=new URL(req.url,'http://localhost').pathname;
    // Health checks contain no credentials and also run on the container's internal port.
    if(path==='/health'&&req.method==='GET'){send(200,{status:'ok'});return;}
    // Same-origin only, including Host validation to reject DNS rebinding.
    if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site'){
      send(403,{detail:'Use the local API tester origin.'});return;
    }
    if(path==='/api-test/bootstrap'){
      if(req.method!=='POST'){send(405,{detail:'POST required.'});return;}
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json'){send(403,{detail:'Same-origin JSON request required.'});return;}
      try{
        const token=readFileSync(tokenFile,'utf8');
        unlinkSync(tokenFile); // One consumer; never retain the token in server state.
        send(200,{token});
      }catch{send(204,null);}
      return;
    }
    let base,suffix;
    if(path==='/api/auth/session'&&req.method==='GET'){base=auth;suffix='/session';}
    else if(path.startsWith('/api/chat/')){base=chat;suffix=path.slice('/api/chat'.length);}
    else if(path.startsWith('/api/')){send(404,{detail:'Only agent-testing endpoints are available.'});return;}
    if(base){
      const target=new URL(base);
      target.pathname=base.pathname.replace(/\/$/,'')+suffix;
      target.search=new URL(req.url,origin).search;
      const headers={};
      for(const key of ['authorization','content-type','accept'])if(req.headers[key])headers[key]=req.headers[key];
      // No cookies, redirects, access logs or ambient server credentials.
      const upstream=(target.protocol==='https:'?https:http).request(target,{method:req.method,headers},response=>{
        if(res.destroyed){response.destroy();return;}
        const outgoing={};
        for(const key of ['content-type','retry-after','x-request-id'])if(response.headers[key])outgoing[key]=response.headers[key];
        res.writeHead(response.statusCode,outgoing);
        response.on('error',()=>res.destroy());
        response.pipe(res);
      });
      upstream.setTimeout(180000,()=>upstream.destroy());
      upstream.on('error',()=>{if(!res.headersSent)send(502,{detail:'The configured API service is unavailable.'});else res.destroy();});
      res.on('close',()=>upstream.destroy());
      req.on('aborted',()=>upstream.destroy());
      req.pipe(upstream);return;
    }
    if(!['GET','HEAD'].includes(req.method)){send(405,{detail:'Method not allowed.'});return;}
    if(path==='/'){res.writeHead(302,{Location:'/api-test/'});res.end();return;}
    const relative=path==='/api-test/'||path==='/api-test/index.html'?'api-test/index.html':/^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)?path.slice(1):null;
    if(!relative){send(404,{detail:'Not found.'});return;}
    const file=join(root,relative);
    try{
      if(!statSync(file).isFile())throw new Error();
      const extension=file.slice(file.lastIndexOf('.'));
      res.writeHead(200,{'Content-Type':mime[extension]||'application/octet-stream'});
      if(req.method==='HEAD')res.end();else createReadStream(file).on('error',()=>res.destroy()).pipe(res);
    }catch{send(404,{detail:'Not found.'});}
  });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||8080);
  const server=createTesterServer({
    root:resolve('public'),authUrl:process.env.AUTH_URL,chatUrl:process.env.CHAT_URL,
    origin:process.env.PUBLIC_ORIGIN,tokenFile:process.env.API_TEST_TOKEN_FILE||'/run/api-tester/token',
  });
  server.listen(port,'0.0.0.0',()=>console.log('API tester is ready.'));
  process.on('SIGTERM',()=>{server.close();server.closeAllConnections();});
}
