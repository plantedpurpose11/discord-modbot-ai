const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const sharp = require('sharp');
const { publicAddress, parseURL, fetchPublic, request } = require('../src/systems/inspection/fetch');
const { Inspector, htmlEvidence, digest } = require('../src/systems/inspection/scanner');
const { scanAntivirus } = require('../src/systems/inspection/antivirus');
const { defaults } = require('../src/config');
const { AI } = require('../src/systems/ai/dualAI');
const { Moderation } = require('../src/systems/moderation/engine');
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const msg = (content = '', attachments = []) => ({ content, attachments: new Map(attachments.map((a, i) => [i, a])) });
const file = (name, size = 20) => ({ id: 'file1', name, size, url: 'https://cdn.discordapp.com/attachments/1/2/file' });
test('SSRF guard rejects private, reserved, mapped and alternative numeric addresses', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','fe80::1','fc00::1','::ffff:127.0.0.1','224.0.0.1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  for (const url of ['http://2130706433','http://0x7f000001','http://[::ffff:127.0.0.1]']) await assert.rejects(fetchPublic(url, { transport: () => assert.fail('must not connect') }));
  for (const url of ['file:///etc/passwd','ftp://example.com','http://user:pass@example.com','http://example.com:8080']) assert.throws(() => parseURL(url));
});
test('every redirect resolves and pins a public address; mixed DNS answers are blocked', async () => {
  let calls = 0;
  await assert.rejects(fetchPublic('https://public.example', { lookup, transport: async (_url, address) => { calls++; assert.equal(address.address,'93.184.216.34'); return { status: 302, headers: { location: 'http://169.254.169.254/latest' } }; } }), /Non-public/);
  assert.equal(calls, 1);
  await assert.rejects(fetchPublic('https://public.example', { lookup: async () => [...await lookup(), {address:'10.1.1.1',family:4}], transport: () => assert.fail() }), /Non-public/);
  let resolutions = 0;
  await fetchPublic('https://public.example', { lookup: async () => { resolutions++; return lookup(); }, transport: async (_url,address) => { assert.equal(address.address,'93.184.216.34'); return {status:200,headers:{},body:Buffer.from('ok')}; } });
  assert.equal(resolutions, 1);
});
test('redirect loops, too many redirects, and slow DNS are bounded', async () => {
  await assert.rejects(fetchPublic('https://example.com', {lookup, transport: async () => ({status:302,headers:{location:'/'}})}), /loop/);
  await assert.rejects(fetchPublic('https://example.com', {lookup,maxRedirects:1,transport: async url => ({status:302,headers:{location:`${url.href}a`}})}), /Too many/);
  await assert.rejects(fetchPublic('https://example.com', {timeoutMs:5,lookup:()=>new Promise(()=>{})}), /DNS timed out/);
});
test('real HTTP transport bounds chunked bodies, rejects compression and sends no credentials', async () => {
  const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined); if(req.url==='/compressed')res.setHeader('Content-Encoding','gzip');res.write(Buffer.alloc(40));res.end(Buffer.alloc(40));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url=new URL(`http://127.0.0.1:${server.address().port}/`);
    await assert.rejects(request(url,{address:'127.0.0.1',family:4},50,1000),/size limit/);
    await assert.rejects(request(new URL('/compressed',url),{address:'127.0.0.1',family:4},100,1000),/compressed/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('HTML inspection extracts visible text and form targets without scripts',()=>{
 const parsed=htmlEvidence(Buffer.from('<script>steal()</script><p>Verify &amp; claim</p><form action="https://evil.example/pay"></form>'));
 assert.equal(parsed.text,'Verify & claim');assert.deepEqual(parsed.destinations,['https://evil.example/pay']);
});
test('scanner checks redirected domains and never treats failed fetches as clean',async()=>{
 const scanner=new Inspector({fetch:async (_url,opts)=>{opts.onURL(new URL('https://evil.example/path'));assert.fail('policy must stop');}});
 const scan=await scanner.inspect(msg('https://short.example'),{...defaults,blockedDomains:['evil.example']});
 assert.equal(scan.verdict.category,'phishing');
 const failed=await new Inspector({fetch:async()=>{throw new Error('timeout');}}).inspect(msg('https://example.com'),defaults);
 assert.ok(failed.issues.length);assert.equal(failed.verdict,null);
});
test('attachments enforce size, CDN and executable rules before analysis',async()=>{
 let downloads=0;const scanner=new Inspector({fetch:async(url,opts)=>{downloads++;opts.onURL(new URL(url));return {body:Buffer.from('hello'),headers:{}};},antivirus:async()=> 'disabled'});
 assert.equal((await scanner.inspect(msg('',[file('gift.exe')]),defaults)).verdict.category,'dangerous_file');assert.equal(downloads,0);
 assert.ok((await scanner.inspect(msg('',[file('huge.txt',defaults.maxAttachmentBytes+1)]),defaults)).issues.length);assert.equal(downloads,0);
 assert.ok((await scanner.inspect(msg('',[{...file('x.txt'),url:'https://evil.example/x'}]),defaults)).issues.length);
 const unsupported=await scanner.inspect(msg('',[file('x.zip')]),defaults);assert.match(unsupported.issues[0],/unsupported/);
});
test('text files contribute evidence and contained links get inspected',async()=>{
 const urls=[];const scanner=new Inspector({antivirus:async()=> 'clean',fetch:async(url,opts)=>{urls.push(url);opts.onURL(new URL(url));return url.includes('discordapp')?{body:Buffer.from('visit https://public.example/offer'),headers:{}}:{body:Buffer.from('<p>Investment offer</p>'),headers:{'content-type':'text/html'},url,hops:[url]};}});
 const scan=await scanner.inspect(msg('',[file('note.txt')]),defaults);assert.equal(scan.issues.length,0);assert.equal(urls.length,2);assert.match(scan.evidence.join(' '),/Investment offer/);
});
test('images are decoded with limits and prepared for vision; corrupt files go to review',async()=>{
 const bytes=await sharp({create:{width:10,height:10,channels:3,background:'#fff'}}).png().toBuffer();
 const scanner=new Inspector({antivirus:async()=> 'disabled',fetch:async()=>({body:bytes,headers:{}})});
 const scan=await scanner.inspect(msg('',[file('image.png')]),defaults);assert.equal(scan.images.length,1);assert.equal(scan.issues.length,0);assert.match(scan.evidence[0],new RegExp(digest(bytes)));
 scanner.fetch=async()=>({body:bytes.subarray(0,12),headers:{}});assert.ok((await scanner.inspect(msg('',[file('bad.png')]),defaults)).issues.length);
});
test('ClamAV detects infected results and scanner failures remain explicit',async()=>{
 const server=net.createServer(socket=>socket.once('data',()=>socket.end('stream: Test-Signature FOUND\0')));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{assert.equal(await scanAntivirus(Buffer.from('synthetic'),{CLAMAV_HOST:'127.0.0.1',CLAMAV_PORT:server.address().port}),'infected');}finally{await new Promise(resolve=>server.close(resolve));}
 const scanner=new Inspector({fetch:async()=>({body:Buffer.from('x')}),antivirus:async()=>{throw new Error('Antivirus unavailable');}});
 assert.match((await scanner.inspect(msg('',[file('x.txt')]),defaults)).issues[0],/Antivirus unavailable/);
});
test('cloud requests authenticate only provider calls, disable redirects and include images',async()=>{
 let received;const ai=new AI({db:{},redis:{},env:{OLLAMA_URL:'https://ollama.com',OLLAMA_API_KEY:'synthetic-test-key',OLLAMA_MODEL:'text-model',OLLAMA_VISION_MODEL:'vision-model'},http:{post:async(...args)=>{received=args;return{data:{message:{content:'ok'}}};}}});
 assert.equal(await ai.ollama('system','prompt',false,['base64']),'ok');assert.equal(received[0],'https://ollama.com/api/chat');assert.equal(received[1].model,'vision-model');assert.deepEqual(received[1].messages[1].images,['base64']);assert.equal(received[2].headers.Authorization,'Bearer synthetic-test-key');assert.equal(received[2].maxRedirects,0);
 ai.env.OLLAMA_URL='http://example.com';await assert.rejects(ai.ollama('s','p'),/HTTPS/);
});
test('a text-only Claude verdict cannot clear an unavailable image scan',async()=>{
 const ai=new AI({db:{},redis:{},env:{CLAUDE_MODEL:'test'},http:{post:async()=>{throw new Error('down');}},anthropic:{messages:{create:()=>assert.fail('must not drop image evidence')}}});
 assert.equal(await ai.analyze('g','image', {...defaults,claudeEnabled:true},[],['base64']),null);
});
test('media pipeline reviews incomplete scans and gives different attachments distinct case identities',async()=>{
 const rows=[];let hash;let learnedCalls=0;let deletes=0;
 const db={guildSettings:{findUnique:async()=>({settings:{mode:'delete'}})},learningExample:{findUnique:async({where})=>{learnedCalls++;hash=where.guildId_contentHash.contentHash;return {category:'safe'};}},moderationCase:{create:async({data})=>{rows.push({id:String(rows.length),...data});return rows.at(-1);},update:async({data})=>Object.assign(rows.at(-1),data)}};
 const scan={hasMedia:true,images:[],evidence:['file digest'],issues:['unsupported'],verdict:null};
 const moderation=new Moderation({db,redis:{eval:async()=>[1,1]},ai:{},client:{user:{id:'bot'}},inspector:{inspect:async()=>scan}});
 const message={...msg('',[file('one.zip')]),guildId:'g',channelId:'c',id:'m',author:{id:'u'},guild:{members:{fetch:async()=>({permissions:{has:()=>false},roles:{cache:new Map()}})}},mentions:{users:new Map(),roles:new Map()},delete:async()=>{deletes++;}};
 await moderation.process(message);message.attachments=new Map([['new',{...file('two.zip'),id:'file2'}]]);await moderation.process(message,{edited:true});
 assert.equal(rows[0].action,'review');assert.equal(deletes,0);assert.equal(learnedCalls,0);assert.notEqual(rows[0].contentHash,rows[1].contentHash);
 scan.issues=[];await moderation.process(message,{edited:true});assert.ok(hash);assert.equal(learnedCalls,1);
});
test('QR payloads are decoded and their destination is checked against server policy', async()=>{
 const QRCode=require('qrcode'); const png=await QRCode.toBuffer('https://evil.example/claim',{width:300});
 const scanner=new Inspector({antivirus:async()=> 'disabled',fetch:async(url,opts)=>{opts.onURL(new URL(url));return{body:png,headers:{}};}});
 const scan=await scanner.inspect(msg('',[file('qr.png')]),{...defaults,blockedDomains:['evil.example']});
 assert.equal(scan.images.length,1);assert.match(scan.evidence.join(' '),/QR content/);assert.equal(scan.verdict.category,'phishing');
});
test('oversized extracted text cannot be represented as a complete scan',async()=>{
 const scanner=new Inspector({antivirus:async()=> 'disabled',fetch:async()=>({body:Buffer.from('a'.repeat(7000)),headers:{}})});
 assert.match((await scanner.inspect(msg('',[file('long.txt',7000)]),defaults)).issues.join(' '),/text exceeds/);
});
test('changed destination evidence invalidates learned safe decisions and AI caches',async()=>{
 let page='first';let learnedHash;let aiCalls=0;let deleted=0;const cache=new Map();const rows=[];
 const db={guildSettings:{findUnique:async()=>({settings:{mode:'delete'}})},learningExample:{findUnique:async({where})=>where.guildId_contentHash.contentHash===learnedHash?{category:'safe'}:null,findMany:async()=>[]},moderationCase:{create:async({data})=>{rows.push({id:'case',...data});return rows[0];},update:async({data})=>Object.assign(rows[0],data)}};
 const inspector={inspect:async()=>({hasMedia:true,evidence:[page],issues:[],images:[],verdict:null})};
 const ai={analyze:async()=>{aiCalls++;return page==='first'?{category:'safe',confidence:1,reason:'safe',source:'ollama'}:{category:'scam',confidence:1,reason:'changed destination',source:'ollama'};}};
 const redis={eval:async()=>[1,1],get:async key=>cache.get(key),setEx:async(key,_ttl,value)=>cache.set(key,value)};
 const message={...msg('https://example.com'),guildId:'g',channelId:'c',id:'m',author:{id:'u'},guild:{members:{fetch:async()=>({permissions:{has:()=>false},roles:{cache:new Map()}})}},mentions:{users:new Map(),roles:new Map()},delete:async()=>{deleted++;}};
 const moderation=new Moderation({db,redis,ai,inspector,client:{user:{id:'bot'}}});
 await moderation.process(message);learnedHash=digest(JSON.stringify({message:message.content,attachments:[],evidence:['first'],issues:[]}));
 page='second';await moderation.process(message,{edited:true});assert.equal(aiCalls,2);assert.equal(deleted,1);assert.equal(rows[0].category,'scam');
});
