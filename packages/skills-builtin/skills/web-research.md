---
name: web-research
description: Research a topic on the web — pick the lightest browser tier that gets the answer.
triggers: ["look up", "research", "find on the web", "browse to", "open page", "scrape", "fetch url"]
allowed-tools: [web_fetch, browser_session]
---

# Web research

Pick the lightest tier that still answers the question.

## Tier 1 — `web_fetch` (default)

Use for: single static page, public docs, RSS, JSON endpoints, well-known cached pages, anything where the answer is in the initial HTML server response.

```
web_fetch({ url, format: "markdown" })
```

`format: "text"` is fine for prose, `"markdown"` keeps headings + links + lists, `"raw"` returns the body untouched (for JSON or HTML you need to parse). Pass `selector: "main"` or `selector: "#content"` to extract a single block from a noisy page.

Heuristic: try `web_fetch` first. If the result is empty, looks like a JS shell ("loading...", "you need to enable javascript"), or the page clearly needs interaction (login, cookies, modals, infinite scroll), escalate to Tier 2.

## Tier 2 — `browser_session` (Playwright)

Use for: JS-heavy SPAs, pages that require clicks/fills, pages with anti-bot detection that browser fingerprinting bypasses, screenshots, anything stateful across multiple actions.

```
browser_session({ action: { kind: "goto", url, waitUntil: "networkidle" } })
browser_session({ action: { kind: "text", selector: "main" } })   // or no selector for whole body
browser_session({ action: { kind: "click", selector: "button.show-more" } })
browser_session({ action: { kind: "fill", selector: "input[name=q]", value: "query" } })
browser_session({ action: { kind: "screenshot", fullPage: true } })
```

Calls within a turn share the same page — `goto` then `click` then `text` is the common pattern.

`browser_session` requires Playwright installed in the moxxy install dir. If you get an "init" error mentioning playwright, instruct the user to:
```
npm i playwright && npx playwright install
```
Then retry, or fall back to `web_fetch` if the page works without JS.

## Don't

- Don't loop `web_fetch` calls scraping a paginated site — for that you want a small script or `browser_session` with explicit `click`s.
- Don't `eval` arbitrary user JS via `browser_session.eval` for "convenience." Use `text` / `click` / `fill` instead; `eval` should be the last resort when you genuinely need to read computed state.
- Don't fetch the same URL repeatedly within a turn — cache the result mentally and re-quote it.
- Don't request `screenshot` unless the user explicitly asked for one. Image bytes inflate the context.

## Report back

After the research is done, summarize concisely. Quote source URLs inline (the response already includes the resolved URL from `web_fetch` and `browser_session.url`). If multiple sources contradicted, say so.
