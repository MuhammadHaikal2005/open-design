# Personal fork: long-running BYOK reasoning

This personal fork consolidates the maxout2 output-limit patch and the later
local compaction/activity fixes. The fixes were developed from `d465086` and
integrated with the fork's main at `53231d40`. They do not modify the upstream
repository. No model-server changes are required.

## What is included

- Settings' Max tokens reaches the run request, OpenCode model output limit and
  `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` in the child process.
- An optional provider profile separates generation and summary budgets, reserves
  compaction space and retains recent history.
- The matched profile installs a bundled, standalone OpenCode plugin. It observes
  real reasoning, answer and tool-argument deltas, emitting a content-free stderr
  activity notice at most every ten seconds. Existing daemon activity handling
  resets the inactivity watchdog on those notices.
- Compaction requests disable tools and use `chat_template_kwargs.enable_thinking:
  false`. A complete, nonempty summary is required before history can be replaced.
  One invalid summary is retried; two produce a non-retryable 422 error.
- BYOK runs get a 30-minute genuine-silence allowance. This is not a total runtime
  limit. Other runtimes retain their existing timeout policies.

No API keys, user conversations, private server addresses or generated projects
belong in this repository.

## Enable the existing profile

Follow the root `AGENTS.md` **Daemon data directory contract** for the active
daemon data root. The daemon reads `byok-token-profile.json` there; if absent,
it accepts the existing `qwen27b-token-profile.json` for maxout2 compatibility.
The generic filename takes precedence. Do not copy secrets into either file.

Example content (replace the model and endpoint with the saved provider values):

```json
{
  "model": "qwen3.8-27b",
  "baseUrl": "http://127.0.0.1:18020/v1",
  "context": 131072,
  "maxOutput": 65536,
  "summaryOutput": 16384,
  "headroom": 20000,
  "retainRecent": 8192
}
```

This deployment profile applies to both UI and CLI runs through the same daemon
launch path. Only an exact model and normalized endpoint match activates it.
Other providers retain their saved output settings and receive no plugin. The
profile requires an OpenAI-compatible chat-completions server that supports the
Qwen no-thinking template option. It is not a universal provider configuration.

The example's compaction trigger is approximately 45,536 input tokens:
131,072 minus 65,536 reserved output minus 20,000 headroom. That is about 35% of
the full context window. The summary has its own 16,384-token cap; the 8,192
retained-history budget is separate. Summaries target 600–1,200 words and should
usually be much shorter than their cap. These defaults intentionally preserve
the existing experiment's generation allowance.

The daemon validates budgets before launch, including room for the summary plus
retained history below the next compaction trigger. Oversized tool results or
inaccurate provider token accounting can still exceed the reserve; the profile
is not a guarantee against arbitrarily large single requests.

## Persistence and limits

The plugin source is included in the daemon build, then written atomically to a
content-versioned file under the daemon-owned BYOK runtime home. Its file URL is
injected into OpenCode's run configuration, so no manual installed-bundle patch,
hard-coded user path or separately installed plugin is needed. Rebuilding from
this branch retains the behavior. Loading an official upstream build does not.

The watchdog cannot observe work during server-side queueing or prefill before
tokens arrive. Empty keepalives do not prove model progress and do not produce
activity notices. Repetitive output still counts as generation; this mechanism
does not assess the quality of reasoning. Cancellation still reaches the stream.

## Validation

Use Node 24 and the package manager pinned in `package.json`. Run `pnpm guard`,
`pnpm typecheck`, the daemon's BYOK regression suites, the web run-isolation suite,
and the daemon build. Tests cover endpoint isolation, budget validation, legacy
profile migration, standalone plugin execution, byte preservation, split stream
chunks, private-content exclusion, throttling, cancellation, invalid summaries,
upstream errors and genuine-silence behavior.

The optional bundled-CLI integration test uses a local mock server and temporary
runtime homes, never the live model or conversation. See its test-file header for
the `OD_TEST_OPENCODE_BIN` opt-in. It exercises real automatic compaction and
checks that an invalid summary cannot advance to the next generation request.

Installing a rebuilt desktop application and restarting an active experiment are
separate operations. Keep the running installation unchanged while validating
this source branch.
