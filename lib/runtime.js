import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

export const packageRoot = fileURLToPath(new URL('../', import.meta.url))
export function bundledExecutable(platform = process.platform, arch = process.arch) {
  return join(packageRoot, 'runtime', `${platform}-${arch}`, 'bin', platform === 'win32' ? 'kiseki.exe' : 'kiseki')
}
export function sessionContext(execution) {
  const session = execution?.agent?.session
  const id = String(session?.id || session?.header?.id || '')
  if (!id) throw new Error('Kiseki requires an active DSH agent session')
  return { id, cwd: resolve(session.header?.cwd || process.cwd()), cuaSession: `dsh-${createHash('sha256').update(id).digest('hex').slice(0, 24)}` }
}
export function parseOutput(stdout) {
  try { return JSON.parse(stdout) } catch { return null }
}
export function providerRefused(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return value.isError === true || value.is_error === true || value.ok === false ||
    ['refused', 'failed', 'error'].includes(value.effect) || ['refused', 'failed', 'error'].includes(value.status) ||
    providerRefused(value.structuredContent) || providerRefused(value.structured_content)
}
export class KisekiRuntime {
  constructor(config = {}) {
    this.executable = config.executablePath ? resolve(config.executablePath) : bundledExecutable()
    this.artifactDirectory = resolve(config.artifactDirectory || join(tmpdir(), 'dsh-kiseki-input'))
    this.cancelGraceMs = config.cancelGraceMs ?? 5000
    this.cuaEnv = {
      ...(config.cuaDriverPath ? { KISEKI_CUA_DRIVER: resolve(config.cuaDriverPath) } : {}),
      ...(config.cuaSocket ? { KISEKI_CUA_SOCKET: config.cuaSocket } : {})
    }
    this.jobs = new Map()
    this.disposed = false
  }
  async prepare(execution, files = []) {
    if (this.disposed) throw new Error('Kiseki plugin has been disposed')
    execution?.signal?.throwIfAborted()
    await access(this.executable, constants.F_OK)
    const session = sessionContext(execution)
    const directory = join(this.artifactDirectory, session.cuaSession, randomUUID())
    await mkdir(directory, { recursive: true })
    const paths = new Map()
    for (const file of files) {
      if (!file.name || /[\\/\0]/u.test(file.name) || ['.', '..'].includes(file.name) || paths.has(file.name)) throw new Error('Input file names must be unique plain file names')
      const path = join(directory, file.name)
      await writeFile(path, file.content, 'utf8')
      paths.set(file.name, path)
    }
    return { ...session, directory, paths }
  }
  substitute(value, prepared) {
    if (!value.startsWith('@file:')) return value
    const name = value.slice(6)
    if (!prepared.paths.has(name)) throw new Error(`Missing input file: ${name}`)
    return prepared.paths.get(name)
  }
  async run(argv, execution, options = {}) {
    if (!Array.isArray(argv) || !argv.length || argv.some(v => typeof v !== 'string' || v.includes('\0'))) throw new Error('argv must be a non-empty array of strings without NUL')
    const prepared = options.prepared || await this.prepare(execution, options.files)
    const args = argv.map(v => this.substitute(v, prepared))
    execution?.signal?.throwIfAborted()
    if (this.disposed) throw new Error('Kiseki plugin has been disposed')
    const id = randomUUID()
    const child = spawn(this.executable, args, {
      cwd: prepared.cwd, shell: false, windowsHide: true,
      env: { ...process.env, ...this.cuaEnv, KISEKI_CUA_SESSION: prepared.cuaSession },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const job = { id, owner: prepared.id, child, argv: args, cwd: prepared.cwd, cuaSession: prepared.cuaSession,
      directory: prepared.directory, stdout: '', stderr: '', state: 'running', exitCode: null, signal: null, aborted: false, forcedTermination: false }
    this.jobs.set(id, job)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', text => { job.stdout += text })
    child.stderr.on('data', text => { job.stderr += text })
    let timer
    const abort = () => {
      if (job.state !== 'running' || job.aborted) return
      job.aborted = true
      // Node terminates Windows processes forcibly; do not claim native input cleanup.
      job.forcedTermination = process.platform === 'win32'
      child.kill('SIGTERM')
      timer = setTimeout(() => { if (job.state === 'running') { job.forcedTermination = true; child.kill('SIGKILL') } }, this.cancelGraceMs)
      timer.unref()
    }
    job.stop = abort
    job.done = new Promise(resolveDone => {
      child.on('error', error => { job.error = error.message })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        execution?.signal?.removeEventListener('abort', abort)
        job.exitCode = code; job.signal = signal; job.state = 'exited'
        resolveDone(this.snapshot(job))
      })
    })
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') job.error = error.message })
    child.stdin.end(options.stdin ?? '')
    if (!options.background) {
      execution?.signal?.addEventListener('abort', abort, { once: true })
      if (execution?.signal?.aborted) abort()
      const result = await job.done
      this.jobs.delete(id)
      return result
    }
    // A start failure must not be reported as a successfully started background job.
    await new Promise(resolveStart => { child.once('spawn', resolveStart); child.once('error', resolveStart) })
    if (execution?.signal?.aborted) { abort(); await job.done; this.jobs.delete(id); execution.signal.throwIfAborted() }
    return this.snapshot(job)
  }
  snapshot(job) {
    const data = parseOutput(job.stdout)
    const refused = providerRefused(data)
    return { ok: !job.error && !job.aborted && !refused && (job.state === 'running' || job.exitCode === 0), jobId: job.id,
      state: job.state, executable: this.executable, argv: job.argv, cwd: job.cwd, cuaSession: job.cuaSession,
      artifactDirectory: job.directory, exitCode: job.exitCode, signal: job.signal, aborted: job.aborted,
      forcedTermination: job.forcedTermination, error: job.error || null, stdout: job.stdout, stderr: job.stderr,
      providerRefused: refused, data }
  }
  async job(id, operation, execution) {
    const job = this.jobs.get(id)
    if (!job || job.owner !== sessionContext(execution).id) throw new Error('Job not found in this DSH session')
    if (operation === 'stop') { job.stop(); return job.done }
    if (operation === 'wait') {
      const abort = () => job.stop()
      execution?.signal?.throwIfAborted()
      execution?.signal?.addEventListener('abort', abort, { once: true })
      try { return await job.done } finally { execution?.signal?.removeEventListener('abort', abort) }
    }
    return this.snapshot(job)
  }
  async dispose() {
    this.disposed = true
    for (const job of this.jobs.values()) job.stop()
    await Promise.all([...this.jobs.values()].map(job => job.done))
    this.jobs.clear()
  }
  async disposeSession(id) {
    const jobs = [...this.jobs.values()].filter(job => job.owner === id)
    for (const job of jobs) job.stop()
    await Promise.all(jobs.map(job => job.done))
    for (const job of jobs) this.jobs.delete(job.id)
  }
}

// Kiseki writes uncompressed 32-bit BMP; native Windows capture also uses 24-bit BMP.
export function bmpToPng(buffer) {
  if (buffer.length < 54 || buffer.toString('ascii', 0, 2) !== 'BM') throw new Error('Invalid BMP header')
  const offset = buffer.readUInt32LE(10), dib = buffer.readUInt32LE(14)
  const width = buffer.readInt32LE(18), signedHeight = buffer.readInt32LE(22), height = Math.abs(signedHeight)
  const depth = buffer.readUInt16LE(28), compression = buffer.readUInt32LE(30)
  if (dib < 40 || width <= 0 || !height || ![24, 32].includes(depth) || compression !== 0 || buffer.readUInt16LE(26) !== 1) throw new Error('Unsupported BMP layout; original capture is retained')
  const stride = Math.ceil(width * depth / 32) * 4
  if (offset < 14 + dib || !Number.isSafeInteger(stride * height) || offset + stride * height > buffer.length) throw new Error('Truncated BMP pixels')
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    const row = offset + (signedHeight < 0 ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const src = row + x * (depth / 8), dst = (y * width + x) * 4
      png.data[dst] = buffer[src + 2]; png.data[dst + 1] = buffer[src + 1]; png.data[dst + 2] = buffer[src]; png.data[dst + 3] = 255
    }
  }
  return { data: PNG.sync.write(png), width, height }
}
export async function imageAttachment(path, attachments) {
  let data = await readFile(path), mediaType, dimensions = null
  if (data.toString('ascii', 0, 2) === 'BM') {
    const converted = bmpToPng(data); data = converted.data; dimensions = { width: converted.width, height: converted.height }; mediaType = 'image/png'
  } else if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mediaType = 'image/png'
  else if (data[0] === 255 && data[1] === 216) mediaType = 'image/jpeg'
  else if (data.toString('ascii', 0, 3) === 'GIF') mediaType = 'image/gif'
  else if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') mediaType = 'image/webp'
  else throw new Error(`Unsupported image format: ${path}`)
  const attachment = await attachments.saveImage({ data, mediaType, name: mediaType === 'image/png' ? basename(path).replace(/\.bmp$/iu, '.png') : basename(path) })
  return { path, sourceDimensions: dimensions, attachment }
}
