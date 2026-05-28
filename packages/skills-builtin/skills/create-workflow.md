---
name: create-workflow
description: Design and save a multi-step workflow — a DAG that chains skills, prompts, and tools into a reusable, schedulable pipeline.
triggers:
  - create a workflow
  - create a flow
  - build a workflow
  - build a pipeline
  - chain skills
  - automate this
  - set up a flow
  - workflow that
allowed-tools:
  - workflow_create
  - workflow_validate
  - workflow_list
  - workflow_get
  - workflow_run
---

Use this skill when the user wants a reusable, multi-step pipeline — e.g. "create a flow that fetches Dow Jones news, analyzes it, checks my watchlist, then emails me a digest." A workflow is a DAG: each step runs a **skill**, a free-form **prompt**, a **tool**, or a nested **workflow**, and each step's output pipes into the next.

## Pattern

1. **Clarify the goal** — the steps, their order, any inputs, and a trigger (on-demand, a schedule, on a file change, or after another workflow). Keep questions to a minimum; infer sensible defaults.

2. **Map steps to actions:**
   - Prefer a **named skill** when one already fits a step (`workflow_list` shows skills indirectly; the system prompt lists skills). Otherwise use a **prompt** step.
   - Use a **tool** step for a concrete action — sending a message, calling an API, writing a file. For "email/notify me", use a connected tool (e.g. a Gmail MCP tool) if available; otherwise set `delivery: { channel: inbox }` so the result lands in `~/.moxxy/inbox/`.
   - Express ordering and parallelism with `needs`: steps whose `needs` are all satisfied run **in parallel**. Fan-in by listing several ids in `needs`.

3. **Call `workflow_create`** with a one- or two-sentence `intent` describing the whole pipeline. It drafts the YAML, validates it (schema + DAG + conditions), writes it to `~/.moxxy/workflows/`, and registers it. Pass `scope: "project"` ONLY if the user asked to scope it to this repo.

4. **Show and offer to run** — summarize the steps and triggers. Offer `workflow_run` for a smoke test. The user can also manage flows from the `/workflows` modal (list, enable/disable, run).

## Templating (reference earlier results)

- `{{ steps.<id>.output }}` — a prior step's output
- `{{ inputs.<name>}}` — a declared input
- `{{ trigger }}`, `{{ now }}`

## Conditions (`when:`)

A step runs only if its `when` is true. Grammar: `<ref> contains "x"`, `<ref> == "x"`, `<ref> != "x"`, `<ref> is empty`, `<ref> is not empty`, joined by `and` / `or`. Example: `when: '{{ steps.check.output }} contains "ALERT"'`.

## Example shape

```yaml
name: stock-market-digest
description: Weekday mornings — Dow Jones news → sentiment → watchlist → email.
on:
  schedule: { cron: "0 8 * * 1-5", timeZone: "America/New_York" }
steps:
  - id: fetch_news
    skill: web-research
    input: "Fetch today's market-moving headlines from Dow Jones / WSJ."
  - id: analyze
    needs: [fetch_news]
    prompt: "Analyze sentiment & notable movers:\n{{ steps.fetch_news.output }}"
  - id: email
    needs: [analyze]
    when: '{{ steps.analyze.output }} is not empty'
    tool: gmail_send
    args: { to: "me", subject: "Daily Market Digest", body: "{{ steps.analyze.output }}" }
```

## Tips

- A workflow with no `on:` block is on-demand only (run it with `workflow_run` or `/workflows run <name>`).
- Set `onError: continue` on a non-critical step so one failure doesn't abort the whole pipeline; use `retries: N` for flaky steps.
- To edit by hand instead, tell the user to run `/workflows new <name>` for a starter file, or `/workflows edit <name>` to find the path.
