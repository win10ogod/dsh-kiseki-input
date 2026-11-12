---
name: dsh-kiseki-input
description: Use Kiseki Input through native DSH tools for desktop observation, screenshots, exact input, background operation, and teaching workflows.
---

# Kiseki desktop tools for DSH

Use `kiseki_status` to discover the packaged executable and actual host capabilities, then `kiseki_observe` to discover the intended target. The plugin executes Kiseki directly with argv, without shell command construction or MCP. On Windows DSH it uses the Windows build, independently of whether development occurred in WSL. The optional CUA provider still has its own runtime prerequisites.

## Observe → act → verify

1. Discover current targets: `kiseki_observe({operation:"targets"})`. For CUA, use `cua-windows` after its setup/status workflow.
2. Observe structure: `kiseki_observe({operation:"ui",target:{windowId:"..."},args:["--provider","uia"]})`. Use `inspect` for native receiver/geometry data, or `cua-state` for CUA snapshots.
3. Capture pixels when needed: `kiseki_capture({mode:"background-window",target:{windowId:"..."}})`. Choose `desktop`, `window`, `isolated-desktop`, or `cua` when that matches the intended operation. CUA capture uses `state --output` and requires the discovered PID and window ID.
4. Act in the selected mode. Example: `kiseki_input({mode:"window",action:"text",target:{windowId:"..."},args:["--text","literal text"]})`. For Unicode, large text, a path or a sequence use `files:[{name:"input.txt",content:"..."}]` and `args:["--file","@file:input.txt"]`. `@file:` is expanded only when it occupies the entire argument.
5. Verify the actual application change in the same target and mode. A zero exit code confirms command completion, not that the application has finished responding.

Keep host, session, target, snapshot ID/element token, screenshot dimensions and coordinate transform together. Native window IDs and CUA IDs are different namespaces. A whole-window screenshot is not automatically in client coordinates. If DSH normalizes an attached image, use its originalDimensions and the source capture metadata when mapping pixels. Never silently change background operations to current-session input.

## Full upstream functionality

`kiseki_run({argv:["background","cua","status"]})` accepts every existing Kiseki command and option. Read help through `kiseki_run({argv:["input","mouse","--help"]})`. Preserve the exact requested timing, points, snapshot fields and provider options. For CUA raw calls use `argv:["background","cua","call",toolName,"--file","@file:request.json"]` with a JSON input file. Each DSH session receives its own `KISEKI_CUA_SESSION`; raw CUA requests must set their explicit `session` field to the `cuaSession` returned by plugin tools when required by that provider.

Sequences: create a complete JSON file, call `macro validate`, then `input sequence` or `macro run`. Keep down/up pairs, held modifiers and related motion in one sequence. Separate raw-down commands intentionally leave inputs held. `files` are stored under the returned artifactDirectory; upstream relative paths inside their contents remain relative to the DSH workspace, not to the input file.

For burst capture and macros, read resulting files with `kiseki_image`, or pass `imagePaths` to a foreground `kiseki_run`. Screenshot attachment failures return `ok:false` with imageErrors while preserving command results and the original image. No automatic downsampling is performed by this plugin; DSH's own attachment normalization still applies.

## Current CUA tools

Use `kiseki_cua({tool:"get_browser_state",arguments:{target_id:"RETURNED_TARGET",tab_id:"RETURNED_TAB",snapshot_format:"semantic_v2"},useSession:true})` for a bound browser snapshot. Preserve continuation, query/scope refs and declared action kinds. Bind PID/window first and prepare a browser only when needed. Read the installed schema with `kiseki_run({argv:["background","cua","describe","get_browser_state"]})`.

For native capture-bound input, forward the exact capture_id and delivery_mode in arguments; never strip either after a refusal. `parse_visual_regions` takes the retained capture ID and options. Keep the same explicit session with useSession:true through capture, parsing and input: Driver accepts this session metadata outside the perception tool's portable schema. Perception is optional and may report not_installed. `attachImage:true` on kiseki_cua saves and returns the provider's first image. Keep the same daemon endpoint throughout the workflow.

Use the current set_agent_cursor_theme, session and recording schemas rather than reconstructing deprecated style commands. Full provider JSON is preserved. `providerRefused:true` or `ok:false` is a failure; `effect:submitted` or `unverifiable` is not confirmation that the app changed.

## Long-running work

Use `background:true` on `kiseki_run` for long-running processes such as an explicitly requested daemon. It returns a jobId immediately. `kiseki_job` supports `status`, `wait` and `stop`; job access is scoped to the originating DSH session. `status` does not wait. Cancellation of a foreground call or a `wait` stops the owned CLI process; cancellation on Windows is forced termination, so native input cleanup is not guaranteed. Inspect the target before retrying a possibly completed action. Plugin disposal stops its running CLI processes; separately detached upstream daemons/recorders retain their native lifecycle and must be stopped using their documented commands.

Model instructions and state are never injected into user history by this plugin. It only registers tools and skills. Consult the bundled `kiseki-project` and `kiseki-teach-recording` skills for native mode semantics, coordinate rules and recorder lifecycle. Their CLI examples translate directly into the argv array of `kiseki_run`; locate installed help/resources relative to those skills. Status-only discovery does not install or start CUA. Use CUA setup only when that workflow is needed.
