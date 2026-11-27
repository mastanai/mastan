---
name: fact-check
description: Fact-check a claim, a news item, or a TikTok, X or other social post from a link. Reconstructs the context, extracts the claims actually made, and verifies them against current primary sources with links. Use when the owner asks whether something is true, real, official or current.
---

# Fact check

Keep fact-checks in the chat. Aim to deliver a verdict first within about 2 minutes; if evidence is still missing,
say what is unverified rather than delaying for a perfect reconstruction.

## Procedure

For a plain claim or news item with no post, skip steps 1 to 3: state the claim exactly, then verify it as in step 5.

1. **Pin down the post.** Try web fetch or search first. If the platform hides the post, open it with the browser
   (skill `browser`), without signing in. Record the canonical URL, author, time, caption or post text and
   the type of attached media. Done when the exact post is unambiguous.
   Before using recovered metadata, resolve the supplied link's current redirects and confirm the recovered video
   or post ID and author both match that target. Apply this to saved HTML, cached page data and subtitle metadata
   too. A mismatch is another post: discard that data and recover the target again. If either ID or author cannot
   be confirmed, treat the metadata as unverified and do not use it as evidence for this post. Files from another
   job folder are not evidence unless the owner explicitly refers to that earlier work.
2. **Reconstruct the context before judging.** On X, separate a reply from the post it quotes and follow the link to
   the original. Look at nearby posts by the same author only when they explain the same teaser or event. On TikTok,
   find the matching video object in the page metadata (for example `__UNIVERSAL_DATA_FOR_REHYDRATION__`). Done when
   the author's own words, quoted material and surrounding speculation can be told apart.
3. **Extract only claims that are really there.** On TikTok, read `video.subtitleInfos` and fetch the matching WebVTT
   when it exists. On X, look at representative video frames, visible text and any subtitle track the media exposes.
   Automatic subtitles are imperfect: song lyrics, ambience or unrelated speech are not evidence. With no usable
   transcript, limit the analysis to the caption and visible text and say so. Every extracted claim traces to
   something visible or transcribed.
4. **Separate claim types:** explicit factual claims, implied interpretations, and jokes, hype or atmosphere. A party
   clip, a reaction, a vague time hint, an emoji or a playful reply is not an announcement unless the text or a
   linked source states the product, the action and the timing.
5. **Verify each material claim with current primary sources:** official documentation, release notes, status
   pages, repository data, first-party pages. Search results and other posts help find evidence but don't replace
   it. Never write "officially available", "confirmed" or similar unless a live source you actually retrieved says
   so. Each claim ends confirmed, qualified, contradicted or unverified.
   Always check whether a real recent event matches the claim, using news agencies and official statements.
   Separate evidence that the event happened from evidence that this footage shows it: place, date and source may
   differ. Old or unrelated footage does not by itself disprove a real event.
6. **Same-author posts are context, not proof.** Quote their exact wording and date and explain whether they narrow
   the meaning. When replies argue about what something means, keep the ambiguity visible.
7. **Answer verdict first.** Then what the post actually shows, what stronger evidence exists, and what it means in
   practice. Use calibrated words: confirmed, likely, possible, unsupported, contradicted. Link the strongest
   primary sources. The reader should see both what is real and what the post overstates.
8. Close every tab you opened.
