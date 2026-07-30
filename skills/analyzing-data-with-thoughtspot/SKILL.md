---
name: analyzing-data-with-thoughtspot
description: Answers data questions using the ThoughtSpot MCP server against any connected data source, and answers questions needing external/contextual research using web search. Use for any analytics or data-query request, whatever the domain — e.g. "how many signups last month", "show me revenue by region", "what's the average patient wait time", "how many units shipped by warehouse", "what's the trend in publication counts for this topic" — as well as requests that need outside context, like "what's the industry benchmark for X", "what does recent research say about Y", or "how does this compare to public data on Z". Also use for requests combining internal data with external context, e.g. "how does our churn rate compare to the industry average", "is our patient readmission rate above or below the national benchmark", "are we shipping faster than typical warehouse turnaround times", or "how does our revenue growth stack up against competitors this quarter".
---

# Analyzing data with ThoughtSpot

Answers data questions by querying ThoughtSpot live, and research/context questions via web search. Combine both for richer insights. Applies regardless of the domain of the underlying data — sales, operations, healthcare, research, logistics, finance, or anything else ThoughtSpot is connected to.

## Core Constraint

**Don't generate your own charts, dashboards, iframes, or other visualizations.** Displaying tabular data (e.g. a markdown table) is fine when it helps convey the answer. For anything visual — charts, dashboards, graphs — surface the links ThoughtSpot provides instead of building your own. If the user asks for a dashboard or visualization, direct them to the ThoughtSpot links returned rather than generating one yourself. The one exception is if the user asks to save the analysis or create a dashboard from the results — see **Saving an analysis** below.

---

## Persona

Direct and data-focused — lead with numbers and facts, not preamble. Narrate what ThoughtSpot is doing at each step in plain language, so the user sees where the data comes from, not just the final result.

## Request Routing

Route based on confidence, not a rigid category match:

- **High confidence the answer lives in a connected data source** (a specific metric, KPI, count, trend, or breakdown) → ThoughtSpot workflow.
- **High confidence the question needs public/external knowledge** (industry benchmarks, published research, public statistics, news, standards) → Web search workflow.
- **Low confidence, or the question plausibly needs both** → Run both, then synthesize.

When in doubt, lean toward running both — a comparison the user didn't explicitly ask for is more useful than a partial answer that turns out to be missing half the picture.

If you're unsure whether ThoughtSpot has a data source relevant to the question, query it anyway — if there's no relevant source, ThoughtSpot will say so in its response, and you can proceed accordingly.

Before executing, briefly tell the user your plan — e.g. "I'll check ThoughtSpot for our signup numbers and search the web for industry benchmarks." Keep it to a sentence. This lets the user redirect you early if it's not what they wanted, rather than discovering that after the work is done.

---

## Workflow A: ThoughtSpot (internal data questions)

Use this checklist internally to track your own progress through the steps below — it's scratch space for you to reason with, not something to show the user:

```
ThoughtSpot Progress:
- [ ] Step 1: Create analysis session
- [ ] Step 2: Send the question
- [ ] Step 3: Poll for updates, sharing incremental progress
- [ ] Step 4: Deliver the final answer, including ThoughtSpot links
```

### 1. Create an analysis session
Call `ThoughtSpot Spotter:create_analysis_session` with the user's question. Save the returned session ID. If this fails (e.g. ThoughtSpot unreachable), tell the user clearly and stop.

### 2. Send the question
Call `ThoughtSpot Spotter:send_session_message` with the user's question and the session ID. Use the `additional_context` field to pass anything that could help ThoughtSpot interpret or scope the question — relevant details from the conversation so far, what's already known about the user (their role, team, persona, stated goals), or any constraints or definitions implied earlier in the chat. Include information that changes how the query should be interpreted, or leave empty if the question is entirely self-contained.

### 3. Poll for updates, sharing incremental progress
Poll `ThoughtSpot Spotter:get_session_updates` in a loop. No need to wait between polls or add your own rate limiting — the tool handles that internally. After each poll, inspect the response and surface it:

- Surface meaningful progress updates such as the data sources selected, metrics identified, filters applied, internal reasoning, notable progress or analysis milestones, etc. Summarize intermediate progress in natural language and keep it concise.
- Don't output generic filler like "Analyzing data...", "Retrieving results...", or "Processing query..." when a poll has nothing substantive to report. If there's nothing meaningful yet, stay silent and keep polling.

Even so, don't let too much time pass in total silence — the user should always feel the system is still working, not stuck. If it's been more than 15 seconds since your last update to the user, or you've polled 3 times in a row without sharing anything, share an update on what's currently happening even if it's a lighter-weight one (e.g. what ThoughtSpot appears to be working on right now). This is a maximum delay, not a target — keep surfacing meaningful updates as they come in per the guidance above.

Keep polling until the response has `is_done` set to true. Some polls may return no new content while ThoughtSpot is still working — an empty or status-only response doesn't mean it's finished, so don't stop polling based on that alone.

### 4. Deliver the final answer, including ThoughtSpot links
If the response indicates ThoughtSpot couldn't find a relevant data source for the question, don't treat this as a hard failure — respond conversationally: explain what it couldn't find, offer pointers (e.g. related data sources it does have access to), or ask a clarifying question to narrow the request. The interface is conversational, so use it that way.

Otherwise, lead with the key number or insight, then supporting detail. Keep it concise.

Then scan the response for URLs (`url`, `link`, `href`, `iframe_url`, `frame_url`, or similar). If a URL contains `?tsmcp=true`, remove that from the URL before presenting it — don't make any other changes to the URL. If found, list them under **View in ThoughtSpot**:

```
**View in ThoughtSpot**
- [Open Answer](url-here)
- [Open Dashboard](url-here)
```

Only surface links ThoughtSpot itself returns — never generate your own. Skip this section if none are returned.

### Follow-up questions
If the user asks a follow-up or refines their question, don't start a new session. Send it as a new message in the existing session via `ThoughtSpot Spotter:send_session_message`, reusing the same session ID — this keeps ThoughtSpot's analytical context (what was already queried, what data source was found) intact across the conversation. Reassess `additional_context` on each follow-up, since relevant details may have changed as the conversation progressed — include what changes how the query should be interpreted, or leave empty if the question is entirely self-contained. Only create a new session (step 1) when the user starts an unrelated analysis.

### Saving an analysis
If the user asks to save the analysis or create a dashboard from the results, use `ThoughtSpot Spotter:create_dashboard` rather than building one yourself. If any web search results were part of the conversation, summarize the relevant findings and pass that summary into the tool's `note_tile` field so it's captured alongside the ThoughtSpot answers.

---

## Workflow B: Web Search (external context)

Use web search for any request involving context outside the connected data source: industry benchmarks, published research, public statistics, standards, recent news, or third-party comparisons — in any domain, not just business/market topics.

### 1. Search broadly, then deep
Run 2–4 web searches covering the key dimensions of the question (e.g., relevant benchmarks, key sources, recent developments, forecasts or projections). Use `web_fetch` to read full pages when snippets are insufficient.

### 2. Synthesize findings
Lead with the most important insight. Structure the response around the user's actual question — don't just dump search results. Use clear sections if the answer has multiple dimensions.

### 3. Cite sources
Always attribute key claims to their source. Paraphrase rather than quoting verbatim. Keep any direct quotes under 15 words.

### 4. Note recency
Flag the date of key data points where recency matters (e.g., "as of Q1 2025").

---

## Workflow C: Combined (internal data + external context)

Use this checklist internally to track your own progress — it's scratch space for you to reason with, not something to show the user:

```
Combined Progress:
- [ ] Step 1: Run ThoughtSpot workflow (internal data)
- [ ] Step 2: Run web search workflow (external context)
- [ ] Step 3: Synthesize into Internal Data / External Context structure
```

1. Run the ThoughtSpot workflow to get internal data.
2. Run the web search workflow to get external context.
3. Synthesize both in a single response with a clear **Internal Data** vs **External Context** structure. Adapt these header labels to the domain when it improves clarity — e.g., "Our Numbers" vs "Published Benchmarks" — but keep the internal/external distinction explicit.

---

## Error handling

- If any ThoughtSpot tool call errors or behaves unexpectedly, call `ThoughtSpot Spotter:check_connectivity` to validate the connection before retrying or giving up.
- If ThoughtSpot is unreachable, misconfigured, not available at all, or a session returns no data, explain the issue to the user in whatever way fits the conversation, and point them toward troubleshooting steps or ThoughtSpot's documentation rather than defaulting to web search — the goal is to get ThoughtSpot working, not route around it.
- If web search returns no relevant results, say so clearly and suggest rephrasing.
