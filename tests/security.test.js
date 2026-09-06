import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  isPublicIp,
  validateRelayDestination,
  sanitizeOutboundHeaders,
  encodeRelayBody,
  ensureExecutableGet,
  normalizeRelayMethod,
  requireActionToken,
  requestFingerprint,
  assessTokenRecord,
  parsePositiveInt,
  relayRequest,
} from '../api/_lib/security.js';

test('public IPv4 accepted',()=>assert.equal(isPublicIp('8.8.8.8'),true));
test('loopback blocked',()=>assert.equal(isPublicIp('127.0.0.1'),false));
test('RFC1918 10 blocked',()=>assert.equal(isPublicIp('10.0.0.1'),false));
test('RFC1918 172 blocked',()=>assert.equal(isPublicIp('172.16.1.1'),false));
test('RFC1918 192 blocked',()=>assert.equal(isPublicIp('192.168.1.1'),false));
test('link local blocked',()=>assert.equal(isPublicIp('169.254.169.254'),false));
test('CGNAT blocked',()=>assert.equal(isPublicIp('100.64.0.1'),false));
test('docs ranges blocked',()=>assert.equal(isPublicIp('192.0.2.1'),false));
test('IPv6 loopback blocked',()=>assert.equal(isPublicIp('::1'),false));
test('IPv6 ULA blocked',()=>assert.equal(isPublicIp('fd00::1'),false));
test('IPv6 link local blocked',()=>assert.equal(isPublicIp('fe80::1'),false));
test('mapped private IPv4 blocked',()=>assert.equal(isPublicIp('::ffff:10.0.0.1'),false));
test('public IPv6 accepted',()=>assert.equal(isPublicIp('2606:4700:4700::1111'),true));

test('relay rejects http',async()=>await assert.rejects(()=>validateRelayDestination('http://example.com'),/HTTPS only/));
test('relay rejects credentials in URL',async()=>await assert.rejects(()=>validateRelayDestination('https://a:b@example.com'),/Credentials/));
test('relay rejects non-443 port',async()=>await assert.rejects(()=>validateRelayDestination('https://example.com:444'),/port 443/));
test('relay rejects localhost',async()=>await assert.rejects(()=>validateRelayDestination('https://localhost'),/not allowed/));
test('relay rejects private DNS answer',async()=>await assert.rejects(()=>validateRelayDestination('https://example.com',{resolver:async()=>[{address:'10.0.0.1',family:4}]}),/private or reserved/));
test('relay rejects mixed DNS answers',async()=>await assert.rejects(()=>validateRelayDestination('https://example.com',{resolver:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]}),/private or reserved/));
test('relay accepts all-public DNS answers',async()=>assert.equal((await validateRelayDestination('https://example.com',{resolver:async()=>[{address:'8.8.8.8',family:4}]})).host,'example.com'));

test('relay strips unsafe headers',()=>{const h=sanitizeOutboundHeaders({Authorization:'secret',Cookie:'x',Accept:'application/json','X-Api-Key':'bad'});assert.equal(h.authorization,undefined);assert.equal(h.cookie,undefined);assert.equal(h.accept,'application/json')});
test('JSON credential fields blocked',()=>assert.throws(()=>encodeRelayBody('{"password":"x"}','application/json'),/Credential-like/));
test('form credential fields blocked',()=>assert.throws(()=>encodeRelayBody('api_key=x','application/x-www-form-urlencoded'),/Credential-like/));
test('oversized relay body blocked',()=>assert.throws(()=>encodeRelayBody('x'.repeat(LIMITS.relayRequestBytes+1),'text/plain'),/too large/));
test('unsupported relay content type blocked',()=>assert.throws(()=>encodeRelayBody('x','multipart/form-data'),/not supported/));
test('GET-only action blocks prefetch',()=>assert.throws(()=>ensureExecutableGet({method:'GET',headers:{purpose:'prefetch'}}),/Prefetch/));
test('GET-only action blocks POST',()=>assert.throws(()=>ensureExecutableGet({method:'POST',headers:{}}),/must be executed with GET/));
test('relay blocks CONNECT',()=>assert.throws(()=>normalizeRelayMethod('CONNECT'),/not allowed/));
test('action token format validated',()=>assert.equal(requireActionToken('A'.repeat(32)).length,32));
test('short action token rejected',()=>assert.throws(()=>requireActionToken('short'),/valid one-use/));
test('fingerprints stable across key order',()=>assert.equal(requestFingerprint({a:1,b:2}),requestFingerprint({b:2,a:1})));
test('token replay with same request returns stored result',()=>{const a=assessTokenRecord({action_family:'community',client_hash:'c',expires_at:new Date(Date.now()+10000),used_at:new Date(),request_hash:'r',status_code:201,result_json:{ok:true}},{family:'community',client:'c',requestHash:'r'});assert.equal(a.replay,true)});
test('expired token rejected',()=>assert.equal(assessTokenRecord({action_family:'community',client_hash:'c',expires_at:new Date(Date.now()-1000),used_at:null},{family:'community',client:'c',requestHash:'r'}).code,'ACTION_TOKEN_EXPIRED'));
test('parsePositiveInt caps values',()=>assert.equal(parsePositiveInt('999',20,100),100));

test('relay rejects hexadecimal loopback URL normalization',async()=>await assert.rejects(()=>validateRelayDestination('https://0x7f000001'),/private or reserved|not allowed/));
test('relay rejects octal loopback URL normalization',async()=>await assert.rejects(()=>validateRelayDestination('https://0177.0.0.1'),/private or reserved|not allowed/));
test('relay DNS failure is closed',async()=>await assert.rejects(()=>validateRelayDestination('https://example.com',{resolver:async()=>{throw new Error('dns')}}),/could not be resolved/));
const pubResolver=async()=>[{address:'8.8.8.8',family:4}];
test('relay revalidates public-to-private redirect before second request',async()=>{let calls=0;const requestFn=async()=>{calls++;return {status:302,headers:{location:'https://10.0.0.1/private'},body:Buffer.alloc(0),bytes:0}};await assert.rejects(()=>relayRequest('https://example.com',{resolver:pubResolver,requestFn}),/private or reserved/);assert.equal(calls,1)});
test('relay enforces redirect limit',async()=>{let n=0;const requestFn=async()=>({status:302,headers:{location:`https://example.com/r${++n}`},body:Buffer.alloc(0),bytes:0});await assert.rejects(()=>relayRequest('https://example.com',{resolver:pubResolver,requestFn,maxRedirects:2}),/redirect limit/);assert.equal(n,3)});
test('relay timeout is clamped to maximum',async()=>{let observed=0;const requestFn=async(_v,o)=>{observed=o.timeoutMs;return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('ok'),bytes:2}};await relayRequest('https://example.com',{resolver:pubResolver,requestFn,timeoutMs:999999});assert.equal(observed,LIMITS.relayMaxTimeoutMs)});
test('relay response envelope preserves safe text response',async()=>{const requestFn=async()=>({status:201,headers:{'content-type':'application/json','set-cookie':'x=1'},body:Buffer.from('{"ok":true}'),bytes:11});const r=await relayRequest('https://example.com',{resolver:pubResolver,requestFn});assert.equal(r.status,201);assert.equal(r.encoding,'utf-8');assert.equal(r.headers['set-cookie'],undefined)});
test('unused valid token record is executable',()=>{const a=assessTokenRecord({action_family:'community',client_hash:'c',expires_at:new Date(Date.now()+10000),used_at:null},{family:'community',client:'c',requestHash:'r'});assert.equal(a.ok,true);assert.equal(a.replay,false)});
test('expired token record is rejected',()=>{const a=assessTokenRecord({action_family:'community',client_hash:'c',expires_at:new Date(Date.now()-1000),used_at:null},{family:'community',client:'c',requestHash:'r'});assert.equal(a.ok,false);assert.equal(a.code,'ACTION_TOKEN_EXPIRED')});
test('exact used token replay can return stored result',()=>{const a=assessTokenRecord({action_family:'community',client_hash:'c',expires_at:new Date(Date.now()+10000),used_at:new Date(),request_hash:'r',status_code:201,result_json:{ok:true}},{family:'community',client:'c',requestHash:'r'});assert.equal(a.ok,true);assert.equal(a.replay,true);assert.deepEqual(a.result,{ok:true})});
test('different used token replay is rejected',()=>{const a=assessTokenRecord({action_family:'community',client_hash:'c',expires_at:new Date(Date.now()+10000),used_at:new Date(),request_hash:'r1',result_json:{ok:true}},{family:'community',client:'c',requestHash:'r2'});assert.equal(a.ok,false);assert.equal(a.code,'ACTION_TOKEN_USED')});
