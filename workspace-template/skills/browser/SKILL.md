---
name: browser
description: Open sites, fill forms, use appointment pages and dashboards, or read what a page shows through the Playwright MCP. Use when Owner needs to interact with a website.
---

# Browser

Use `mcp__playwright__*` for sites, forms, appointment pages, dashboards and reading what a page shows.
For plain facts, use web search first. It is faster and cheaper.

## Rules
1. The profile keeps sign-ins across chats and restarts. Use Owner's own accounts only. Credentials must come from
   Owner in the same conversation. Never write credentials to memory, the atlas or files.
2. Take screenshots only when Owner needs to see something. Send the saved file with
   `mastan-me-send <path> --caption "<one line>"`. Say sent only after it prints `sent`; never retry an uncertain send.
3. Keep tool output small. Request a snapshot of the relevant part, not a whole page. Read only what answers the request.
4. Close tabs when done. The browser closes after 10 minutes without a tool call and opens again on the next one.
5. Two chats of the same user share a profile. If the profile is locked or already in use, say
   "the browser is busy in another chat, try again in a few minutes". Do not retry in a loop.
