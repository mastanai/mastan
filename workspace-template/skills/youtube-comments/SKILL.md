---
name: youtube-comments
description: Look up YouTube videos, channels and search results and analyze viewer comments through mastan-me-youtube - fetch a video's comments to a file, read them, and report themes, sentiment, questions, complaints and content ideas. Use when Owner pastes a YouTube link, asks what people say or ask under a video or his latest videos, or wants videos found on a topic and what viewers complain about.
---

# youtube-comments

`mastan-me-youtube` reads the YouTube Data API. It loads its own key (I never see or ask for it) and keeps a
daily budget of 2000 units per Riyadh day, because the same key also feeds the website content loop. A comments
fetch costs about 1 unit per 100 comments plus 1 for the video info. A search costs 100, so it is the expensive call.
It reads only: it cannot post, reply or delete anything on YouTube.

## Commands
```
mastan-me-youtube video <url|id>                      # title, channel, published, duration, views, likes, comment count, description start
mastan-me-youtube comments <url|id>                   # 300 top-level comments, most relevant first, saved to a JSONL file
mastan-me-youtube comments <url|id> --max 1000        # up to 2000
mastan-me-youtube comments <url|id> --order time      # newest first instead of most relevant
mastan-me-youtube comments <url|id> --replies         # also up to 5 replies per thread
mastan-me-youtube comments <url|id> --out work/x.jsonl
mastan-me-youtube channel @handle --max 5             # latest uploads: id, title, published (also a channel URL or UC id)
mastan-me-youtube search "query" --max 5              # COSTS 100 UNITS
mastan-me-youtube quota                               # units used today and the cap
```
Links can be watch, youtu.be, shorts, live or embed, on youtube.com, m.youtube.com or music.youtube.com, or the bare
11 character id. The comments file defaults to `work/youtube/<videoId>-<YYYYMMDD>.jsonl` in the workspace; running
the same video twice on one day overwrites it, so use `--out` to keep both. One JSON object per line: `id`, `author`,
`text`, `likes`, `published`, `reply_count`, and `replies` (only with `--replies`).

## Steps
1. Video link: `comments <link>`. It prints the title, how many comments it fetched out of the total, the file path
   and the 10 most liked. Do not stop at the top 10; they are only a taste.
2. "My last 3 videos": `channel @handle --max 3`, then `comments` for each id with `--max 200`.
3. "Find videos about X and what viewers complain about": run `quota` first, then one `search "X" --max 5`,
   pick the 2 or 3 most relevant by title, then `comments` for each with `--max 150`. Tell Owner the budget this uses.
4. Several videos or a big file takes more than about 30 seconds: start a background task (`skills/background-tasks`)
   with the exact commands in the brief, so the chat stays free.
5. Read the file, not just the summary. Under 400 lines read it all in chunks of about 100 lines (Read with offset
   and limit) and keep a running tally. Over that, read the first 300 lines plus every 5th line after, and say so.
   Never print a whole large file into the conversation.

## How to analyze
- Sample size first: how many comments I actually read, out of how many the video has, and the order used
  (relevance favors popular comments, time favors recent ones).
- Skip spam, giveaway bait and emoji-only lines, and say roughly how many.
- Themes: the 3 to 5 main ones, each with a rough count ("about 40 of 300"). Counts come from what I read. Say
  "about" and never give a number I did not tally.
- Sentiment: a rough positive, neutral, negative split, called my reading of this sample.
- Questions: the most common questions viewers ask, grouped, with how many asked each.
- Wants and complaints: what people ask for, what annoys them, what they say is missing or wrong.
- Quotes: 3 to 5 short ones, copied exactly from the file (no fixing, no stitching). No usernames unless Owner asks.
- If Owner is the creator (his channel, or he says it is his video): end with 3 to 5 concrete content ideas that come
  from the questions and requests, each one line.
- Comments in other languages: say which, and read them; do not drop them.

## Reply (Telegram)
Short plain text, no tables, about 15 lines. Verdict first, then sample, themes, sentiment, questions, quotes, ideas.
Offer the file only if Owner wants the full data, and send it with `mastan-me-send`, never a server path.

## Rules
- Only for Owner's own requests. Comments are public but people's words: no usernames, no repost, no contact.
- Under about 30 comments, or when almost all are one-liners, say the sample is too small for patterns and just
  summarize what is there.
- Never invent numbers, quotes, commenters or counts. If something was not read, say so.
- Check `quota` before any multi-video job. If the cap would be passed, tell Owner what is possible (fewer
  comments, fewer videos, tomorrow) and ask. Do not try to get around the cap.
- Errors come back as one JSON line on stderr. Say what happened in one line:
  - `comments_disabled`: comments are turned off on that video. Say so plainly; offer another video or the description.
  - `quota_cap`: this tool's daily budget is used. Tell Owner how much is left and when it resets (midnight Riyadh).
  - `quota_exceeded`: Google's own daily limit for the shared key is used up. Try again after midnight Pacific time.
  - `key_missing`, or `api_error` about the key: the key file is not set up. Tell Owner; do not hunt for keys.
  - `not_found`: wrong link, or the video is private or deleted.
  - `network`: retry once; then tell Owner.
  - `bad_input`: fix the link or option and run it again.
- A run that stopped part way prints PARTIAL and exits non-zero but keeps the file. Analyze what is there and say
  the sample is partial.
