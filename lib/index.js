import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { KisekiRuntime, packageRoot, imageAttachment, sessionContext } from './runtime.js'

export const name = 'dsh-kiseki-input'
export const inject = ['tools', 'skills', 'attachments']
export const Config = z.object({
  executablePath: z.string().default(''),
  artifactDirectory: z.string().default(''),
  cuaDriverPath: z.string().default(''),
  cuaSocket: z.string().default(''),
  cancelGraceMs: z.number().min(0).step(1).default(5000)
})
const string = { type: 'string' }, strings = { type: 'array', items: string }
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) })
const files = { type: 'array', items: object({ name: string, content: string }, ['name', 'content']), description: 'UTF-8 files for this call. Refer to them with an exact argv item @file:name.' }
const target = object({ windowId: string, pid: { type: 'integer', minimum: 1 }, title: string })
export const output = {
  schema: { type: 'object' },
  render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }, ...(value.images || []).map(image => ({ type: 'image', attachment: image.attachment }))]
  }
}
function targetArgs(value = {}, cua = false) {
  const args = []
  if (value.windowId !== undefined) args.push(cua ? '--window-id' : '--target-window-id', value.windowId)
  if (value.pid !== undefined) args.push(cua ? '--pid' : '--target-pid', String(value.pid))
  if (value.title !== undefined) {
    if (cua) throw new Error('CUA uses discovered windowId/pid, not native title selectors')
    args.push('--target-title', value.title)
  }
  return args
}
function registerSkill(ctx, skillName, path, description) {
  const raw = readFileSync(path, 'utf8')
  const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
  ctx.skills.register({ name: skillName, description, content, path, source: 'bundled',
    resourceBase: { kind: 'directory', path: resolve(path, '..') }, invocation: { modelInvocable: true, userInvocable: true } })
}
export function apply(ctx, config = {}, deps = {}) {
  const runtime = deps.runtime || new KisekiRuntime(config)
  const attach = deps.imageAttachment || imageAttachment
  registerSkill(ctx, 'dsh-kiseki-input', join(packageRoot, 'assets/dsh-kiseki-input/SKILL.md'), 'Use Kiseki desktop tools in DSH: discover, observe, capture, input, background jobs, and teaching recordings.')
  registerSkill(ctx, 'kiseki-project', join(packageRoot, 'assets/upstream/skills/kiseki-project/SKILL.md'), 'Kiseki operation modes, target selection, exact input timing, coordinates, and verification. In DSH use kiseki_* tools.')
  registerSkill(ctx, 'kiseki-teach-recording', join(packageRoot, 'assets/upstream/skills/kiseki-teach-recording/SKILL.md'), 'Record and inspect Kiseki teaching demonstrations and compile reusable procedures.')
  const register = (toolName, description, parameters, execute) => ctx.tools.register({ name: toolName, description, parameters, output, execute })
  async function withImages(result, paths, execution) {
    result.images = []; result.imageErrors = []
    for (const path of paths) {
      execution?.signal?.throwIfAborted()
      try { result.images.push(await attach(path, ctx.attachments)) }
      catch (error) { result.ok = false; result.imageErrors.push({ path, error: error.message }) }
    }
    return result
  }
  register('kiseki_status', 'Inspect the installed Kiseki executable, native capabilities and operation modes. Does not install/start CUA.', object({}), async (_args, exec) => {
    const results = []
    for (const argv of [['--version'], ['capabilities'], ['modes', '--json']]) results.push(await runtime.run(argv, exec))
    return { ok: results.every(r => r.ok), results }
  })
  register('kiseki_observe', 'Discover or inspect windows and UI structure. Native and CUA window IDs are separate namespaces; preserve snapshots and coordinates.', object({
    operation: { type: 'string', enum: ['targets', 'inspect', 'ui', 'cua-windows', 'cua-state'] }, target,
    args: { ...strings, description: 'Additional exact upstream options, e.g. --provider uia or --max-depth 10.' }
  }, ['operation']), async (args, exec) => {
    const commands = { targets: ['target', 'list'], inspect: ['target', 'inspect'], ui: ['observe', 'ui'], 'cua-windows': ['background', 'cua', 'windows'], 'cua-state': ['background', 'cua', 'state'] }
    return runtime.run([...commands[args.operation], ...targetArgs(args.target, args.operation.startsWith('cua-')), ...(args.args || [])], exec)
  })
  register('kiseki_capture', 'Capture and return an image with native output/coordinate metadata. Choose the same family as the action. BMP is converted to PNG without resizing.', object({
    mode: { type: 'string', enum: ['desktop', 'window', 'background-window', 'isolated-desktop', 'cua'] }, target,
    display: string, args: { ...strings, description: 'Additional capture options; output is managed by this tool.' }
  }, ['mode']), async (args, exec) => {
    const prepared = await runtime.prepare(exec)
    const cua = args.mode === 'cua'
    const path = join(prepared.directory, cua ? 'capture.png' : 'capture.bmp')
    const commands = { desktop: ['screenshot', 'desktop'], window: ['screenshot', 'window'], 'background-window': ['background', 'window', 'screenshot'], 'isolated-desktop': ['background', 'desktop', 'screenshot'], cua: ['background', 'cua', 'state'] }
    const extra = args.args || []
    if (extra.some(v => v === '-o' || v === '--output' || v.startsWith('--output='))) throw new Error('kiseki_capture manages --output; use kiseki_run for a custom output path')
    const argv = [...commands[args.mode], ...targetArgs(args.target, cua)]
    if (args.display) argv.push('--display', args.display)
    argv.push(...extra, '--output', path)
    if (!cua && args.mode !== 'isolated-desktop') argv.push('--json')
    const result = await runtime.run(argv, exec, { prepared })
    result.captureMode = args.mode
    if (!result.ok) return result
    return withImages(result, [path], exec)
  })
  register('kiseki_input', 'Perform exact input in an explicit mode. Pass CLI options as separate args; use files for literal text or paths. Use a sequence for held-key/mouse operations.', object({
    mode: { type: 'string', enum: ['current', 'window', 'isolated-desktop', 'cua'] }, action: string, target, display: string, args: strings, files
  }, ['mode', 'action']), async (args, exec) => {
    const commands = { current: ['input'], window: ['background', 'window'], 'isolated-desktop': ['background', 'desktop'], cua: ['background', 'cua'] }
    if (!/^[a-z][a-z0-9-]*$/u.test(args.action)) throw new Error('action must be one Kiseki subcommand')
    if (args.mode === 'current' && args.target) throw new Error('Current-session input cannot bind a target; select a background mode for targeted input')
    const argv = [...commands[args.mode], args.action, ...targetArgs(args.target, args.mode === 'cua')]
    if (args.display) argv.push('--display', args.display)
    return runtime.run([...argv, ...(args.args || [])], exec, { files: args.files })
  })
  register('kiseki_run', 'Run any Kiseki command with exact argv, without a shell. Preserves all upstream features (macros, teaching, burst capture, CUA raw calls, permissions, daemon). background=true returns a session-owned job; use kiseki_job to inspect/wait/stop it.', object({
    argv: { ...strings, minItems: 1 }, files, stdin: string, background: { type: 'boolean' }, imagePaths: { ...strings, description: 'Images to attach after a foreground command; paths relative to the DSH workspace.' }
  }, ['argv']), async (args, exec) => {
    if (args.background && args.imagePaths?.length) throw new Error('Read background job images with kiseki_image after completion')
    const result = await runtime.run(args.argv, exec, args)
    if (!args.imagePaths?.length) return result
    return withImages(result, args.imagePaths.map(path => resolve(sessionContext(exec).cwd, path)), exec)
  })
  register('kiseki_job', 'Inspect, wait for, or stop a Kiseki background job owned by this DSH session. Status is non-blocking. On Windows, forced cancellation cannot guarantee release of held inputs; inspect state before retrying.', object({
    jobId: string, operation: { type: 'string', enum: ['status', 'wait', 'stop'] }
  }, ['jobId', 'operation']), (args, exec) => runtime.job(args.jobId, args.operation, exec))
  register('kiseki_cua', 'Call any installed CUA Driver tool through Kiseki with full JSON fields: semantic_v2 browser snapshots/actions, capture-bound input, sessions, themes, recording and visual regions. Read the current tool schema with kiseki_run describe. useSession adds this DSH session only when the provider tool accepts session. Refusals are preserved; no retry or backend substitution.', object({
    tool: string,
    arguments: { type: 'object', additionalProperties: true },
    useSession: { type: 'boolean' },
    attachImage: { type: 'boolean', description: 'Save and attach the first image returned by this provider call.' }
  }, ['tool', 'arguments']), async (args, exec) => {
    const request = { ...args.arguments }
    if (args.useSession && request.session === undefined) request.session = sessionContext(exec).cuaSession
    const prepared = await runtime.prepare(exec, [{ name: 'request.json', content: JSON.stringify(request) }])
    const argv = ['background', 'cua', 'call', args.tool, '--file', '@file:request.json']
    const path = join(prepared.directory, 'cua.png')
    if (args.attachImage) argv.push('--output', path)
    const result = await runtime.run(argv, exec, { prepared })
    return args.attachImage && result.ok ? withImages(result, [path], exec) : result
  })
  register('kiseki_image', 'Read a Kiseki image artifact, including BMP, as a DSH image attachment. Does not recapture the desktop.', object({ path: string }, ['path']), (args, exec) => withImages({ ok: true }, [resolve(sessionContext(exec).cwd, args.path)], exec))
  ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent?.session?.id || agent?.session?.header?.id || '')
    if (id) return runtime.disposeSession(id)
  })
  ctx.effect(() => () => runtime.dispose())
  return runtime
}
