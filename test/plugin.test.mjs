import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { KisekiRuntime, bmpToPng } from '../lib/runtime.js'
import { apply, output } from '../lib/index.js'
const exec = (id = 'test-session') => ({ agent: { session: { id, header: { cwd: process.cwd() } } }, signal: new AbortController().signal })

test('argv, Unicode, files and >1MB output survive without shell interpolation/truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiseki-test-'))
  const runtime = new KisekiRuntime({ executablePath: process.execPath, artifactDirectory: dir })
  try {
    const literal = '中文 "$HOME"; $(touch pwned) `literal` \\ end'
    const result = await runtime.run(['-e', 'process.stdout.write(JSON.stringify({arg:process.argv[1],file:require("fs").readFileSync(process.argv[2],"utf8"),long:"x".repeat(1100000)}))', literal, '@file:text.txt'], exec(), { files: [{ name: 'text.txt', content: literal }] })
    assert.equal(result.ok, true); assert.equal(result.data.arg, literal); assert.equal(result.data.file, literal); assert.equal(result.data.long.length, 1100000)
  } finally { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) }
})
test('nonzero status preserves stderr and exit code', async () => {
  const r = new KisekiRuntime({ executablePath: process.execPath })
  const result = await r.run(['-e', 'process.stderr.write("backend failed");process.exit(7)'], exec())
  assert.equal(result.ok, false); assert.equal(result.exitCode, 7); assert.equal(result.stderr, 'backend failed')
  await r.dispose()
})
test('background jobs are session-owned and stop reaches process exit', async () => {
  const r = new KisekiRuntime({ executablePath: process.execPath, cancelGraceMs: 100 })
  try {
    const job = await r.run(['-e', 'setInterval(()=>{},1000)'], exec(), { background: true })
    assert.equal(job.state, 'running')
    await assert.rejects(r.job(job.jobId, 'status', exec('other')), /not found/)
    const done = await r.job(job.jobId, 'stop', exec())
    assert.equal(done.state, 'exited'); assert.equal(done.aborted, true); assert.equal(done.ok, false)
  } finally { await r.dispose() }
})
test('foreground cancellation settles and prevents subsequent spawn', async () => {
  const r = new KisekiRuntime({ executablePath: process.execPath, cancelGraceMs: 100 })
  const controller = new AbortController(), context = { ...exec(), signal: controller.signal }
  const pending = r.run(['-e', 'setInterval(()=>{},1000)'], context)
  setTimeout(() => controller.abort(), 150)
  const result = await pending
  assert.equal(result.aborted, true); assert.equal(result.state, 'exited')
  await assert.rejects(r.run(['--version'], context))
  await r.dispose()
})
test('BMP conversion preserves dimensions, orientation and colors', () => {
  for (const signedHeight of [-2, 2]) {
    const bmp = Buffer.alloc(70)
    bmp.write('BM'); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(2, 18); bmp.writeInt32LE(signedHeight, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(32, 28)
    const top = Buffer.from([0,0,255,0, 0,255,0,0]), bottom = Buffer.from([255,0,0,0, 255,255,255,0])
    ;(signedHeight < 0 ? top : bottom).copy(bmp, 54); (signedHeight < 0 ? bottom : top).copy(bmp, 62)
    const decoded = PNG.sync.read(bmpToPng(bmp).data)
    assert.equal(decoded.width, 2); assert.equal(decoded.height, 2)
    assert.deepEqual([...decoded.data], [255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255])
    assert.throws(() => bmpToPng(bmp.subarray(0, 60)), /Truncated/)
  }
})
test('plugin tools preserve exact input options and register durable image rendering', async () => {
  const tools = new Map(), skills = [], calls = []
  const runtime = { run: async (argv, e, opts) => { calls.push({ argv, opts }); return { ok: true } }, dispose: async () => {} }
  apply({ tools: { register: t => tools.set(t.name, t) }, skills: { register: s => skills.push(s) }, attachments: {}, on() {}, effect() {} }, {}, { runtime })
  assert.equal(tools.size, 8); assert.equal(skills.length, 3)
  const args = ['--x','1920','--y','1080','--hold-ms','123456','--click-count','3']
  await tools.get('kiseki_input').execute({ mode:'window', action:'mouse', target:{windowId:'0x123'}, args }, exec())
  assert.deepEqual(calls[0].argv, ['background','window','mouse','--target-window-id','0x123',...args])
  const ref = { id: 'test-ref' }
  assert.deepEqual(output.render({}, { images: [{ attachment: ref }] })[1], { type:'image', attachment:ref })
  await assert.rejects(tools.get('kiseki_input').execute({mode:'current',action:'text',target:{windowId:'123'}},exec()), /cannot bind/)
})
test('invalid explicit executable does not silently select bundled executable', async () => {
  const r = new KisekiRuntime({ executablePath: join(tmpdir(), 'does-not-exist-kiseki-abc123') })
  await assert.rejects(r.run(['--version'], exec()), /ENOENT/)
})
test('agent disposal stops only its own jobs', async () => {
  const r = new KisekiRuntime({ executablePath: process.execPath, cancelGraceMs: 100 })
  try {
    const a = await r.run(['-e', 'setInterval(()=>{},1000)'], exec('a'), { background: true })
    const b = await r.run(['-e', 'setInterval(()=>{},1000)'], exec('b'), { background: true })
    await r.disposeSession('a')
    await assert.rejects(r.job(a.jobId, 'status', exec('a')), /not found/)
    assert.equal((await r.job(b.jobId, 'status', exec('b'))).state, 'running')
  } finally { await r.dispose() }
})

test('modern CUA refusals remain failures even with exit code zero', async () => {
  const r = new KisekiRuntime({ executablePath: process.execPath })
  try {
    const payload = { structuredContent: { effect:'refused', code:'capture_not_found', detail:'capture expired' } }
    const result = await r.run(['-e', 'process.stdout.write(process.argv[1])', JSON.stringify(payload)], exec())
    assert.equal(result.exitCode, 0); assert.equal(result.ok, false); assert.equal(result.providerRefused, true)
    assert.deepEqual(result.data, payload)
    const partial = await r.run(['-e', 'process.stdout.write(JSON.stringify({effect:"unverifiable",detail:"readback unavailable"}))'], exec())
    assert.equal(partial.ok, true); assert.equal(partial.data.effect, 'unverifiable')
  } finally { await r.dispose() }
})
test('CUA tool passes semantic snapshots, capture and future fields without changing explicit session', async () => {
  const tools = new Map(); let written, called
  const runtime = {
    prepare: async (_exec, files) => { written=JSON.parse(files[0].content);return {directory:tmpdir()} },
    run: async argv => { called=argv;return {ok:true} }, dispose:async()=>{}
  }
  apply({tools:{register:t=>tools.set(t.name,t)},skills:{register(){}},attachments:{},on(){},effect(){}},{},{runtime})
  const args={session:'explicit',target_id:'bt-1',tab_id:'tab-2',snapshot_format:'semantic_v2',continuation:'bc-next',max_nodes:999999,future_field:{capture_id:'cap-1'}}
  await tools.get('kiseki_cua').execute({tool:'get_browser_state',arguments:args,useSession:true},exec())
  assert.deepEqual(written,args)
  assert.deepEqual(called,['background','cua','call','get_browser_state','--file','@file:request.json'])
  await tools.get('kiseki_cua').execute({tool:'parse_visual_regions',arguments:{capture_id:'cap-1'}},exec())
  assert.deepEqual(written,{capture_id:'cap-1'})
})
