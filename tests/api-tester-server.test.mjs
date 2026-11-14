import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createTesterServer} from '../deploy/api-tester-server.mjs';

const origin='http://127.0.0.1:8090';
async function fixture(t,upstreamHandler=(_req,res)=>res.end('{}')){
  const dir=mkdtempSync(join(tmpdir(),'api-tester-'));
  mkdirSync(join(dir,'api-test'));mkdirSync(join(dir,'assets'));
  writeFileSync(join(dir,'api-test/index.html'),'<html>API tester</html>');
  writeFileSync(join(dir,'assets/app.js'),'console.log("test")');
  const tokenFile=join(dir,'token');writeFileSync(tokenFile,'synthetic-launch-token');
  const upstream=http.createServer(upstreamHandler).listen(0,'127.0.0.1');await once(upstream,'listening');
  const base=`http://127.0.0.1:${upstream.address().port}`;
  const server=createTesterServer({root:dir,authUrl:base+'/api/auth',chatUrl:base+'/api/chat',origin,tokenFile}).listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.close();server.closeAllConnections();upstream.close();upstream.closeAllConnections();rmSync(dir,{recursive:true,force:true});});
  const request=(path,options={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:options.method||'GET',headers:{Host:'127.0.0.1:8090',...options.headers}},res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });req.on('error',reject);req.end(options.body);
  });
  return {request,tokenFile,port:server.address().port};
}

test('bootstrap is same-origin POST only, single-use and uncached',async t=>{
  const {request,tokenFile}=await fixture(t);
  assert.equal((await request('/api-test/bootstrap')).status,405);
  assert.equal((await request('/api-test/bootstrap',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'}})).status,403);
  assert.equal((await request('/api-test/bootstrap',{method:'POST'})).status,403);
  assert.equal((await request('/api-test/bootstrap',{method:'POST',headers:{Origin:origin,Host:'evil.example','Content-Type':'application/json'}})).status,403);
  assert.equal(existsSync(tokenFile),true);
  const options={method:'POST',headers:{Origin:origin,'Content-Type':'application/json'}};
  const [a,b]=await Promise.all([request('/api-test/bootstrap',options),request('/api-test/bootstrap',options)]);
  assert.deepEqual([a.status,b.status].sort(),[200,204]);
  const response=[a,b].find(r=>r.status===200);
  assert.equal(JSON.parse(response.body).token,'synthetic-launch-token');
  assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(existsSync(tokenFile),false);
});

test('proxy preserves bearer, body, query and SSE while removing cookies and redirects',async t=>{
  const calls=[];
  const {request}=await fixture(t,(req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      calls.push({url:req.url,headers:req.headers,body});
      res.writeHead(200,{'Content-Type':'text/event-stream','Set-Cookie':'portal=must-not-reach-browser'});
      res.write('event: progress\ndata: {"message":"Working"}\n\n');
      setImmediate(()=>res.end('event: done\ndata: {"status":"complete"}\n\n'));
    });
  });
  const response=await request('/api/chat/executions?test=1',{method:'POST',headers:{Authorization:'Bearer synthetic-client-token',Cookie:'portal=human-cookie','Content-Type':'application/json',Origin:origin},body:'{"text":"test"}'});
  assert.equal(response.status,200);assert.match(response.body,/event: done/);
  assert.equal(response.headers['set-cookie'],undefined);
  assert.equal(calls[0].url,'/api/chat/executions?test=1');
  assert.equal(calls[0].body,'{"text":"test"}');
  assert.equal(calls[0].headers.authorization,'Bearer synthetic-client-token');
  assert.equal(calls[0].headers.cookie,undefined);
  assert.equal((await request('/api/auth/session')).status,200);
  assert.equal(calls[1].url,'/api/auth/session');
  assert.equal(calls[1].headers.authorization,undefined); // No server-side credential fallback.
  assert.equal((await request('/api/auth/logout',{method:'POST'})).status,404);
  assert.equal((await request('/api/admin/accounts')).status,404);
});

test('serves only tester assets, protects paths and permits the internal health check',async t=>{
  const {request}=await fixture(t);
  assert.equal((await request('/')).headers.location,'/api-test/');
  assert.match((await request('/api-test/')).body,/API tester/);
  assert.match((await request('/assets/app.js')).headers['content-type'],/javascript/);
  assert.equal((await request('/admin/')).status,404);
  assert.equal((await request('/assets/../token')).status,404);
  assert.equal((await request('/token')).status,404);
  assert.equal((await request('http://[invalid')).status,400);
  assert.equal((await request('/health',{headers:{Host:'127.0.0.1:8080'}})).status,200);
});

test('does not follow upstream redirects or forward their Location header',async t=>{
  const {request}=await fixture(t,(_req,res)=>{res.writeHead(302,{Location:'https://other.example/'});res.end();});
  const response=await request('/api/auth/session',{headers:{Authorization:'Bearer synthetic-token'}});
  assert.equal(response.status,302);
  assert.equal(response.headers.location,undefined);
});

test('closes the upstream SSE request when its browser disconnects',async t=>{
  let disconnected;
  const closed=new Promise(resolve=>{disconnected=resolve;});
  const {port}=await fixture(t,(_req,res)=>{
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write('event: progress\ndata: {}\n\n');
    res.on('close',disconnected);
  });
  await new Promise((resolve,reject)=>{
    const request=http.get({hostname:'127.0.0.1',port,path:'/api/chat/executions/example',headers:{Host:'127.0.0.1:8090'}},response=>{
      response.once('data',()=>{response.destroy();resolve();});
    });request.on('error',reject);
  });
  await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Upstream remained connected')),2000);timer.unref();})]);
});
