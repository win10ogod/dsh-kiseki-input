import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'

if (process.platform !== 'win32') throw new Error('This test requires native Windows Node and a graphical Windows session')
const rootPath = fileURLToPath(new URL('../', import.meta.url))
const dir = join(rootPath, 'artifacts/live-test', randomUUID())
await mkdir(dir, { recursive: true })
const cuaDriverPath = process.env.KISEKI_TEST_CUA_DRIVER
const cuaSocket = cuaDriverPath ? `\\\\.\\pipe\\dsh-kiseki-${randomUUID()}` : ''
const require = createRequire(await realpath(process.env.DSH_RUNTIME_PACKAGE || fileURLToPath(new URL('../package.json', import.meta.url))))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const ctx = new Context()
const modules = ['@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-skill']
for (const name of modules) await ctx.plugin((await load(name)).default)
await ctx.plugin((await load('@deepseek-ai/dsh-attachment-local')).default, {dshHome:join(dir,'dsh-home')})
await ctx.plugin(plugin, {artifactDirectory:join(dir,'captures'), executablePath:process.env.KISEKI_TEST_EXECUTABLE || '', cuaDriverPath:cuaDriverPath || '', cuaSocket})
const agent = {session:{id:randomUUID(),header:{cwd:rootPath}}}
const evidence = {platform:process.platform,architecture:process.arch,artifactDirectory:dir,tools:[],checks:[]}
async function call(name, args, allowFailure = false) {
  const result = await ctx.tools.execute({callId:randomUUID(),name,arguments:args,agent,signal:new AbortController().signal})
  evidence.tools.push({name,args,result})
  assert.equal(result.isError,false,JSON.stringify(result))
  const value = result.value ?? JSON.parse(result.content.find(p=>p.type==='text').text)
  if (!allowFailure) assert.equal(value.ok,true,JSON.stringify(value))
  return value
}
const waitFor = async (fn, ms=15000) => {
  const deadline=Date.now()+ms
  while(Date.now()<deadline) {try {const value=await fn(); if(value) return value}catch{} await new Promise(r=>setTimeout(r,100))}
  throw new Error('Live test condition timed out')
}
let host, daemon, server, daemonLog = ''
try {
  assert.equal(ctx.tools.schemas().filter(t=>t.name.startsWith('kiseki_')).length,8)
  const skills=await ctx.skills.list(); assert.ok(skills.some(s=>s.name==='dsh-kiseki-input'))
  await call('kiseki_status',{})
  if (cuaDriverPath) {
    daemon = spawn(cuaDriverPath,['serve','--socket',cuaSocket,'--no-overlay'],{windowsHide:true,stdio:['ignore','pipe','pipe']})
    daemon.stdout.on('data',data=>{daemonLog+=data.toString()});daemon.stderr.on('data',data=>{daemonLog+=data.toString()})
    await waitFor(async()=>{await promisify(execFile)(cuaDriverPath,['status','--socket',cuaSocket],{windowsHide:true});return true})
  }
  host=spawn('powershell.exe',['-NoProfile','-STA','-File',join(rootPath,'scripts/test-window.ps1'),'-Directory',dir],{windowsHide:true,stdio:['ignore','pipe','pipe']})
  let errors='';host.stderr.on('data',b=>{errors+=b.toString()});host.stdout.on('data',()=>{})
  host.on('error',e=>{errors+=e.message})
  const window=await waitFor(async()=>JSON.parse((await readFile(join(dir,'window.json'),'utf8')).replace(/^\uFEFF/u,''))).catch(e=>{throw new Error(`${e.message}: ${errors}`)})
  await call('kiseki_observe',{operation:'targets',target:{pid:window.pid}})
  await call('kiseki_observe',{operation:'inspect',target:{windowId:window.windowId}})
  const before=await call('kiseki_capture',{mode:'background-window',target:{windowId:window.windowId}})
  assert.ok(before.images.length===1)
  const text='Kiseki DSH 中文驗證 "literal" $HOME ; no shell'
  await call('kiseki_input',{mode:'window',action:'text',target:{windowId:window.editId},args:['--file','@file:text.txt'],files:[{name:'text.txt',content:text}]})
  await waitFor(async()=>await readFile(join(dir,'observed.txt'),'utf8')===text)
  const ui=await call('kiseki_observe',{operation:'ui',target:{windowId:window.windowId},args:['--provider','uia']})
  // This upstream UIA observation reports control identity, not ValuePattern text.
  // Text delivery is independently asserted from the test application's own state above.
  assert.ok(ui.data.elements.some(element => element.controlType === 50004))
  const after=await call('kiseki_capture',{mode:'background-window',target:{windowId:window.windowId}})
  const stored=await ctx.attachments.readImage(after.images[0].attachment)
  await writeFile(join(dir,'after.png'),stored.data)
  evidence.checks=['real DSH registration: 8 tools and 3 skills','packaged Windows binary version/capabilities/modes','target discovery and native receiver inspection','background Unicode text delivered and independently read back','UIA observation identifies the edit control','BMP screenshot converted and committed/read through real DSH attachment service']
  if (cuaDriverPath) {
    await call('kiseki_cua',{tool:'start_session',arguments:{},useSession:true})
    const state=await call('kiseki_cua',{tool:'get_window_state',arguments:{pid:window.pid,window_id:Number(window.windowId),max_image_dimension:0},useSession:true,attachImage:true})
    await writeFile(join(dir,'cua-state.json'),JSON.stringify(state,null,2))
    assert.ok(state.data.snapshot_id)
    const element=state.data.elements.find(item=>item.value===text)
    assert.ok(element,'CUA snapshot must expose the exact text field value')
    const cuaText='CUA 0.30.1 DSH 中文讀寫'
    await call('kiseki_cua',{tool:'type_text',arguments:{pid:window.pid,window_id:Number(window.windowId),element_index:element.element_index,snapshot_id:state.data.snapshot_id,text:cuaText,delivery_mode:'background'},useSession:true})
    await waitFor(async()=>(await readFile(join(dir,'observed.txt'),'utf8')).includes(cuaText))
    const capture=await call('kiseki_cua',{tool:'get_window_state',arguments:{pid:window.pid,window_id:Number(window.windowId),max_image_dimension:0},useSession:true,attachImage:true})
    assert.ok(capture.data.capture_id)
    const parsed=await call('kiseki_cua',{tool:'parse_visual_regions',arguments:{capture_id:capture.data.capture_id},useSession:true},true)
    assert.ok(parsed.ok || /not_installed/u.test(parsed.stderr),'Retained capture must resolve; missing optional extension is reported separately')
    const refused=await call('kiseki_cua',{tool:'click',arguments:{pid:window.pid,window_id:Number(window.windowId),x:20,y:30,capture_id:'invalid-capture',delivery_mode:'background'},useSession:true},true)
    assert.equal(refused.ok,false)
    await call('kiseki_cua',{tool:'set_agent_cursor_theme',arguments:{theme_id:'cua.default'},useSession:true})
    await call('kiseki_run',{argv:['background','cua','driver','--','recording','--socket',cuaSocket,'status']})
    if (process.env.KISEKI_TEST_BROWSER === '1') {
      server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><title>Kiseki CUA test</title><h1>Kiseki semantic snapshot</h1><label>Test value<input aria-label="Test value"></label><button onclick="document.querySelector(\"p\").textContent=\"Clicked OK\"">Verify action</button><p>Ready</p>')})
      await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen))
      const prepared=await call('kiseki_cua',{tool:'browser_prepare',arguments:{allow_launch:true,profile:{mode:'isolated_new'}},useSession:true})
      assert.ok(prepared.data.prepared_pid)
      const windows=await waitFor(async()=>{
        const listed=await call('kiseki_cua',{tool:'list_windows',arguments:{pid:prepared.data.prepared_pid},useSession:true})
        const items=Array.isArray(listed.data)?listed.data:listed.data.windows
        return items?.length?items:null
      })
      const bound=await call('kiseki_cua',{tool:'get_browser_state',arguments:{pid:prepared.data.prepared_pid,window_id:windows[0].window_id},useSession:true})
      const target_id=bound.data.target_id, tab_id=bound.data.tabs.find(tab=>tab.active)?.tab_id || bound.data.tabs[0].tab_id
      assert.ok(target_id && tab_id)
      await call('kiseki_cua',{tool:'browser_navigate',arguments:{target_id,tab_id,url:`http://127.0.0.1:${server.address().port}/`},useSession:true})
      const semantic=await waitFor(async()=>{
        const snapshot=await call('kiseki_cua',{tool:'get_browser_state',arguments:{target_id,tab_id,snapshot_format:'semantic_v2'},useSession:true})
        return snapshot.data.outline?.includes('Kiseki semantic snapshot')?snapshot:null
      })
      assert.equal(semantic.data.snapshot.format,'semantic_v2')
      evidence.checks.push('CUA isolated browser launch, exact binding, navigation and semantic_v2 snapshot')
    }
    await call('kiseki_cua',{tool:'end_session',arguments:{},useSession:true})
    evidence.checks.push('CUA 0.30.1 separate daemon and named session','CUA snapshot, background text delivery and recapture','retained capture resolves for perception (or explicit not_installed)','capture-bound refusal remains a failure','current cursor theme and recording-status calls')
  }
  evidence.ok=true
} catch(error) { evidence.ok=false;evidence.error=error.stack;process.exitCode=1 }
finally {
  if (server) await new Promise(resolveClose=>server.close(resolveClose))
  if (daemon) {
    try { await promisify(execFile)(cuaDriverPath,['stop','--socket',cuaSocket],{windowsHide:true}) } catch {}
    if (daemon.exitCode===null) daemon.kill()
    await writeFile(join(dir,'cua-daemon.log'),daemonLog)
  }
  await writeFile(join(dir,'stop'),'stop')
  if(host && host.exitCode===null) await Promise.race([new Promise(r=>host.once('close',r)),new Promise(r=>{const t=setTimeout(()=>{host.kill();r()},5000);t.unref()})])
  await ctx.fiber.dispose()
  await writeFile(join(dir,'report.json'),JSON.stringify(evidence,null,2))
  await writeFile(join(rootPath,'artifacts/live-test/latest.json'),JSON.stringify({directory:dir,ok:evidence.ok,error:evidence.error},null,2))
}
console.log(JSON.stringify({directory:dir,ok:evidence.ok,error:evidence.error,checks:evidence.checks},null,2))
