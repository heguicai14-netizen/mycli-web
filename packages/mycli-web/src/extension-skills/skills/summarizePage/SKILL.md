---
name: summarizePage
description: Summarize the currently active web page in three concise bullet points.
---

# Instructions

1. Call `readPage` with `mode: 'text'` to get the current page's plain-text content.
2. Identify the three most important points. Discard navigation, ads, and boilerplate.
3. Reply with a markdown bullet list — exactly three bullets — each 8–15 words. Bold the most surprising fact in each bullet.
4. If the page has fewer than three distinct points, return what you can rather than fabricating.

For tone and length conventions, call `readSkillFile` with
`{ skill: 'summarizePage', path: 'references/style.md' }`.
