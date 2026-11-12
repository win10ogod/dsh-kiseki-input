import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { realpath, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
const packagePath=resolve(process.argv[2])
const require=createRequire(await realpath(process.env.DSH_RUNTIME_PACKAGE))
const load=async name=>import(pathToFileURL(require.resolve(name)).href)
const {Context}=await load('@deepseek-ai/cordis')
const ctx=new Context(),dir=fileURLToPath(new URL('../artifacts/installed-check/',import.meta.url))
await mkdir(dir,{recursive:true})
const report={package:JSON.parse(await readFile(join(packagePath,'package.json'),'utf8')),checks:[]}
try {
  for(const name of ['@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-skill']) await ctx.plugin((await load(name)).default)
  await ctx.plugin((await load('@deepseek-ai/dsh-attachment-local')).default,{dshHome:join(dir,'home')})
  await ctx.plugin(await import(pathToFileURL(join(packagePath,'lib/index.js')).href),{artifactDirectory:join(dir,'artifacts')})
  report.tools=ctx.tools.schemas().map(t=>t.name)
  report.skills=(await ctx.skills.list()).map(s=>s.name)
  assert.equal(report.tools.length,8);assert.equal(report.skills.length,3)
  for(const args of [{argv:['--version']},{argv:['background','cua','browser','state','--help']},{argv:['background','cua','driver','--','--version']},{argv:['background','cua','recording','--','status']}]) {
    const result=await ctx.tools.execute({callId:randomUUID(),name:'kiseki_run',arguments:args,agent:{session:{id:'installed-plugin-check',header:{cwd:packagePath}}},signal:new AbortController().signal})
    assert.equal(result.isError,false);assert.equal(result.value.ok,true,JSON.stringify(result))
    report.checks.push({args,result:result.value})
  }
  report.ok=true
} catch(error) {report.ok=false;report.error=error.stack;process.exitCode=1}
finally {await ctx.fiber.dispose();await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2))}
console.log(JSON.stringify({ok:report.ok,version:report.package.version,tools:report.tools,skills:report.skills,error:report.error},null,2))
