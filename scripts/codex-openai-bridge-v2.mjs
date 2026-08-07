#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const HOST='127.0.0.1', PORT=+(process.env.INKOS_CODEX_BRIDGE_PORT||43127);
const TIMEOUT=+(process.env.INKOS_CODEX_TIMEOUT_MS||300000);
const DEF_MODEL=process.env.INKOS_CODEX_MODEL||'gpt-5.6-terra';
const BIN=process.env.INKOS_CODEX_BIN||(process.platform==='win32'?'codex.cmd':'codex');
const MODELS=['gpt-5.6-terra','gpt-5.6-sol','gpt-5.6-luna'];
const APP_SERVER=process.env.INKOS_CODEX_APP_SERVER!=='0';
const effort=m=>process.env.INKOS_CODEX_REASONING_EFFORT||(m.includes('sol')?'medium':'low');
const compact=s=>String(s||'').replace(/\s+/g,' ').trim().slice(0,1500);

class BridgeError extends Error{constructor(message,code='bridge_error',status=500){super(message);this.code=code;this.status=status}}
function json(res,status,body){const s=JSON.stringify(body);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(s),'Cache-Control':'no-store'});res.end(s)}
async function body(req){const a=[];let n=0;for await(const c of req){n+=c.length;if(n>4*1024*1024)throw new BridgeError('Request too large','request_too_large',413);a.push(c)}try{return JSON.parse(Buffer.concat(a).toString('utf8')||'{}')}catch{throw new BridgeError('Invalid JSON','invalid_json',400)}}
function txt(c){if(typeof c==='string')return c;if(!Array.isArray(c))return'';return c.map(x=>typeof x==='string'?x:(x?.text||x?.content||'')).filter(Boolean).join('\n')}
function messages(b){if(!Array.isArray(b?.messages)||!b.messages.length)throw new BridgeError('messages required','invalid_messages',400);return b.messages.map(m=>({role:m?.role||'user',content:txt(m?.content)})).filter(m=>m.content.trim())}
function prompt(ms){const sys=ms.filter(m=>m.role==='system'),con=ms.filter(m=>m.role!=='system');return[
'You are being used as a text-generation backend for InkOS.',
'Do not inspect files, run commands, browse, or edit files for ordinary writing requests.',
'Answer with only the requested assistant text.',
sys.length?'SYSTEM INSTRUCTIONS:\n'+sys.map((m,i)=>`[system ${i+1}]\n${m.content}`).join('\n\n'):'',
'CONVERSATION:\n'+con.map((m,i)=>`[${m.role} ${i+1}]\n${m.content}`).join('\n\n'),
'Return only the assistant response.'
].filter(Boolean).join('\n\n')}

class AppServer{
 constructor(){this.child=null;this.ready=null;this.id=1;this.pending=new Map();this.turns=new Map();this.byTurn=new Map();this.stderr=''}
 async start(){if(this.ready&&this.child?.exitCode===null)return this.ready;this.ready=this._start();return this.ready}
 async _start(){
  const c=spawn(BIN,['app-server','--stdio'],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:process.platform==='win32',env:{...process.env,NO_COLOR:'1'}});this.child=c;
  readline.createInterface({input:c.stdout}).on('line',l=>this.line(l));
  c.stderr.on('data',d=>this.stderr=(this.stderr+d.toString()).slice(-8000));
  c.on('exit',(code,sig)=>{if(this.child!==c)return;this.child=null;this.ready=null;this.fail(new BridgeError(`app-server exited ${code??'?'}${sig?'/'+sig:''}: ${compact(this.stderr)}`,'app_server_exited',503))});
  c.on('error',e=>this.fail(new BridgeError(`app-server start failed: ${e.message}`,'app_server_start_failed',503)));
  const r=await this.req('initialize',{clientInfo:{name:'inkos_codex_bridge',title:'InkOS Codex Bridge',version:'0.2.0'}},20000);this.note('initialized');return r;
 }
 req(method,params={},ms=TIMEOUT){if(!this.child?.stdin?.writable)return Promise.reject(new BridgeError('app-server unavailable','app_server_unavailable',503));const id=this.id++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new BridgeError(`${method} timed out`,'app_server_timeout',504))},ms);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({method,id,params})+'\n')})}
 note(method,params){if(this.child?.stdin?.writable)this.child.stdin.write(JSON.stringify(params===undefined?{method}:{method,params})+'\n')}
 line(l){let m;try{m=JSON.parse(l)}catch{return}if(m.id!==undefined&&(m.result!==undefined||m.error!==undefined)){const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new BridgeError(m.error.message||'RPC error','app_server_rpc',502)):p.resolve(m.result);return}
  const p=m.params||{};let tid=p.threadId||p.thread?.id;if(!tid&&m.method==='turn/completed'&&p.turn?.id)tid=this.byTurn.get(p.turn.id);const s=tid&&this.turns.get(tid);if(!s)return;
  if(m.method==='item/agentMessage/delta'&&typeof p.delta==='string'){s.text+=p.delta;s.delta?.(p.delta)}
  else if(m.method==='item/completed'&&p.item?.type==='agentMessage'&&typeof p.item.text==='string')s.final=p.item.text;
  else if(m.method==='error')s.err=p.error?.message||p.message||'Codex error';
  else if(m.method==='turn/completed'){const t=p.turn||{};this.turns.delete(tid);if(t.id)this.byTurn.delete(t.id);clearTimeout(s.timer);t.status==='completed'?s.resolve((s.final||s.text||t.items?.find?.(x=>x.type==='agentMessage')?.text||'').trim()):s.reject(new BridgeError(t.error?.message||s.err||`turn ${t.status}`,'turn_failed',502))}
 }
 async generate(model,text,delta,signal){await this.start();const cwd=await mkdtemp(join(tmpdir(),'inkos-codex-app-'));let tid,turnId;try{const a=await this.req('thread/start',{model,cwd,approvalPolicy:'never',sandbox:'readOnly',ephemeral:true,personality:'none'},30000);tid=a?.thread?.id;if(!tid)throw new BridgeError('No thread id','bad_thread',502);
   const output=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.turns.delete(tid);reject(new BridgeError('Codex turn timed out','codex_timeout',504))},TIMEOUT);this.turns.set(tid,{resolve,reject,timer,text:'',final:'',err:'',delta})});
   const abort=()=>{if(tid&&turnId)this.req('turn/interrupt',{threadId:tid,turnId},5000).catch(()=>{})};if(signal?.aborted)throw new BridgeError('Request aborted','request_aborted',499);signal?.addEventListener('abort',abort,{once:true});
   try{const t=await this.req('turn/start',{threadId:tid,input:[{type:'text',text}],model,effort:effort(model),approvalPolicy:'never'},30000);turnId=t?.turn?.id;if(turnId)this.byTurn.set(turnId,tid);return await output}finally{signal?.removeEventListener('abort',abort)}
  }finally{await rm(cwd,{recursive:true,force:true}).catch(()=>{})}}
 fail(e){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e)}this.pending.clear();for(const s of this.turns.values()){clearTimeout(s.timer);s.reject(e)}this.turns.clear();this.byTurn.clear()}
 stop(){if(this.child&&!this.child.killed)this.child.kill()}
}
const app=new AppServer();let failures=0;

async function execFallback(model,text,delta,signal){const cwd=await mkdtemp(join(tmpdir(),'inkos-codex-exec-')),out=join(cwd,'last.txt');try{const args=['exec','--skip-git-repo-check','--ephemeral','--ignore-user-config','--ignore-rules','--color','never','--sandbox','read-only','--output-last-message',out,'--model',model,'-'];const r=await spawnExec(args,text,cwd,signal);let s='';try{s=(await readFile(out,'utf8')).trim()}catch{s=r.stdout.trim()}if(!s)throw new BridgeError(`No Codex output: ${compact(r.stderr)}`,'empty_response',502);delta?.(s);return s}finally{await rm(cwd,{recursive:true,force:true}).catch(()=>{})}}
function spawnExec(args,input,cwd,signal){return new Promise((resolve,reject)=>{const c=spawn(BIN,args,{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:process.platform==='win32',env:{...process.env,NO_COLOR:'1'}});let o='',e='',done=false;const finish=(f,v)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);f(v)};const timer=setTimeout(()=>{c.kill();finish(reject,new BridgeError('Codex exec timed out','codex_timeout',504))},TIMEOUT);const abort=()=>{c.kill();finish(reject,new BridgeError('Request aborted','request_aborted',499))};if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});c.stdout.on('data',d=>o=(o+d).slice(-65536));c.stderr.on('data',d=>e=(e+d).slice(-65536));c.on('error',x=>finish(reject,new BridgeError(x.message,'codex_not_available',503)));c.on('close',code=>code===0?finish(resolve,{stdout:o,stderr:e}):finish(reject,new BridgeError(`Codex exec failed ${code}: ${compact(e)}`,'codex_failed',502)));c.stdin.on('error',()=>{});c.stdin.end(input)})}
async function generate(model,ms,delta,signal){const p=prompt(ms);if(APP_SERVER&&failures<2){try{return await app.generate(model,p,delta,signal)}catch(e){failures++;console.warn(`[inkos-codex-bridge] app-server fallback ${failures}/2: ${compact(e.message||e)}`);app.stop()}}return execFallback(model,p,delta,signal)}

function streamStart(res,id,model,created){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store',Connection:'keep-alive'});res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta:{role:'assistant'},finish_reason:null}]})}\n\n`)}
function streamDelta(res,id,model,created,d){res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta:{content:d},finish_reason:null}]})}\n\n`)}
function streamEnd(res,id,model,created){res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`);res.write('data: [DONE]\n\n');res.end()}
async function chat(req,res,b){const model=typeof b.model==='string'&&b.model.trim()?b.model.trim():DEF_MODEL,ms=messages(b),ctl=new AbortController();req.once('aborted',()=>ctl.abort());const id='chatcmpl-'+randomUUID(),created=Math.floor(Date.now()/1000);if(b.stream){streamStart(res,id,model,created);try{await generate(model,ms,d=>streamDelta(res,id,model,created,d),ctl.signal);streamEnd(res,id,model,created)}catch(e){if(!res.writableEnded)res.destroy(e)}return}const content=await generate(model,ms,null,ctl.signal);json(res,200,{id,object:'chat.completion',created,model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}})}
async function handler(req,res){const u=new URL(req.url||'/',`http://${req.headers.host||HOST}`),p=u.pathname.replace(/\/$/,'')||'/';if(req.method==='GET'&&(p==='/health'||p==='/v1/health'))return json(res,200,{ok:true,service:'inkos-codex-bridge',bridge_version:2,transport:APP_SERVER&&failures<2?'persistent-app-server':'exec-fallback',default_model:DEF_MODEL,effort_policy:'Terra/Luna=low, Sol=medium',models:MODELS});if(req.method==='GET'&&(p==='/models'||p==='/v1/models'))return json(res,200,{object:'list',data:MODELS.map(id=>({id,object:'model',owned_by:'chatgpt-codex'}))});if(req.method==='POST'&&(p==='/chat/completions'||p==='/v1/chat/completions'))return chat(req,res,await body(req));return json(res,404,{error:{message:`Unsupported route: ${req.method} ${p}`,type:'invalid_request_error',code:'route_not_found'}})}
async function check(){const s=await generate(DEF_MODEL,[{role:'user',content:'Reply with exactly CODEX_BRIDGE_OK'}]);if(s.trim()!=='CODEX_BRIDGE_OK')throw new Error('Unexpected: '+compact(s));console.log('CODEX_BRIDGE_OK')}
if(process.argv.includes('--check'))check().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>app.stop());else{const server=http.createServer((req,res)=>handler(req,res).catch(e=>{if(res.headersSent)return res.destroy(e);json(res,e.status||500,{error:{message:e.message||String(e),type:'codex_cli_error',code:e.code||'bridge_error'}})}));server.listen(PORT,HOST,()=>{console.log(`[inkos-codex-bridge] http://${HOST}:${PORT}/v1`);console.log(`[inkos-codex-bridge] default=${DEF_MODEL}; persistent app-server preferred; exec fallback enabled`)});const stop=()=>{app.stop();server.close(()=>process.exit(0))};process.on('SIGINT',stop);process.on('SIGTERM',stop)}