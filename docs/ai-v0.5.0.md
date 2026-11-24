# Conversational AI and submission review (v0.5.0 candidate)

Gemini is the only implemented AI provider and remains the default. This feature is **not enabled unless GEMINI_API_KEY is configured**. It adds chat and drafting to the existing authorized private Telegram bot. No separate service or database is required.

## Canvas access and security policy

Canvas Guardian is **read-only by default**. Canvas activity, assignment, rubric, and announcement retrieval use read operations. Draft generation and revision produce local working text; they do not modify Canvas.

The only v0.5.0 Canvas-write exception is a narrowly scoped, explicitly human-authorized submission of:

- `online_text_entry`
- `online_url`

No other Canvas modifications or deletions are permitted. Guardian must not create, edit, or delete Canvas courses or assignments, upload files, answer quizzes, submit external-tool or group work, or perform resubmissions. Unsupported work must be completed manually in Canvas.

Gemini cannot authorize or execute a Canvas submission. It has no Canvas-submit tool. The backend alone stages and executes the exact reviewed snapshot after the authorized Telegram user explicitly confirms it:

1. The user explicitly asks Guardian to prepare a supported submission.
2. Guardian fetches the exact assignment and stages an immutable snapshot containing its course ID, assignment ID, submission type, and exact payload.
3. Guardian sends a preview and then the complete exact payload for review. The Confirm button is not presented until full review delivery succeeds.
4. Only a separate confirmation from the configured Telegram sender in the authorized chat can consume the approval and invoke the backend submission executor.

At both staging and immediately before the POST, the backend fetches the single Canvas assignment with `include[]=can_submit` and requires **`can_submit === true`**. Missing, false, or non-boolean values fail closed. It also revalidates the assignment identity, publication/lock state, allowed submission type, group status, and existing submission state. The final POST uses the stored reviewed payload, not model-supplied replacement content.

Approvals are chat-bound, assignment-bound, content-snapshot-bound, expire after 15 minutes, and are atomically consumed once. A new preview invalidates earlier staged/reviewed previews. An ambiguous POST outcome is marked uncertain and **must never trigger an automatic retry**; the operator must inspect Canvas directly.

This implementation and its automated tests do not authorize or perform a Canvas submission. Any future live submission acceptance test requires separate maintainer authorization for the specific non-graded practice assignment and exact test payload.

## Capabilities and boundaries

- Send a normal message or use /ai followed by a request. AI may list pending/today/week/saved activities, read an assignment and rubric, show announcements, or report local monitoring/calendar settings. An explicit natural-language setting request only stages a proposal: the change is **not applied** until the authorized Telegram user presses its separate Confirm setting change button. Proposals expire after 15 minutes and cannot be replayed. /forget cancels pending proposals. Existing explicit /start, /stop, /pause, /resume and /calendar commands retain their behavior.
- /draft <course ID> <assignment ID> explicitly requests a draft for one Canvas assignment. You can also ask in natural language after discovering the IDs. Revisions reference the saved draft version.
- Drafts are generated through the common AI provider interface (currently implemented by the Gemini adapter), validated by src/gemini-draft-engine.js, and shown as full Telegram text. A new revision has a new draft identifier.
- Ask Gemini to *prepare* that saved text draft for submission, or to prepare an HTTP(S) URL. The preview is stored locally. **Gemini has no submit function** and cannot approve a submission.
- Canvas submission types currently supported: online_text_entry and online_url only. Files, quiz questions, external-tool activities, group submissions and resubmissions must be completed manually in Canvas.
- Canvas credentials never enter Gemini's prompt. The model may receive requested assignment instructions, rubrics, activity names, due dates, announced text, saved draft excerpts, and chat history. Check Google's data policies and institution requirements before using this feature.

## Submission approval

1. Guardian fetches the latest assignment and rejects unpublished, locked, already-submitted, or unsupported submissions.
2. A private Telegram preview explicitly identifies the assignment, submission type, proposed content length, excerpt, and assessment/recommendation. This is **not** a submission.
3. Tap **Review full submission**. Guardian sends the *entire exact content* as one or more Telegram messages. Only then is the **Confirm Canvas submission** button presented.
4. A confirmation is tied to a single stored version, chat ID, assignment and type, expires after 15 minutes, and is consumed once. The backend fetches the assignment again before calling the Canvas API.
5. On a confirmed response, Guardian reports Canvas's submission timestamp. If the POST outcome is ambiguous, Guardian does **not retry**; inspect Canvas directly before any further action.

Any new submission preview cancels previously staged or reviewed previews. User revisions do not modify existing staged content. An old preview must never be used for a newer draft.

## Local setup and behavior

- Keep Node.js 24. Run npm ci and npm test. Set AI_PROVIDER=gemini (or omit it), GEMINI_API_KEY, and optionally AI_MODEL. AI_MODEL takes precedence over the existing GEMINI_MODEL; the default is gemini-3.8-flash. Empty AI_MODEL uses the fallback. Other AI_PROVIDER values deliberately fail until an adapter is actually implemented.
- Preserve the existing SQLite data/horus.db* state, along with the configured Canvas token, Google credentials and Telegram chat ID. AI tables are created lazily on first use.
- The bot retains /start, /stop, /pause, /resume, /status, /pending, /today, /week, /activities, /announcements, /calendar, and /report. Conversational commands include /ai, /draft, and /forget.
- Use /forget to remove recent local AI chat history and drafts and invalidate pending submission approvals. This does not remove Telegram messages, Google API logs or already-completed Canvas submissions.
- Replies are bounded by message and tool-iteration limits. Large drafts and approval content are split to respect Telegram's message size. Chat and drafting share a two-method provider interface (`chat` and `draft`); the Gemini adapter owns SDK requests and translation. Adding a different provider later requires an adapter, configuration/credentials, and live acceptance tests, not a change to Canvas or Telegram authorization code.
- The Gemini API and Canvas submission endpoints are the only new external services/operations. The scheduled monitoring jobs remain independent of Gemini.

## Manual acceptance tests on a **non-graded practice assignment**

Use a non-graded practice assignment only after separate maintainer authorization for the specific live test. This implementation assignment does **not** authorize any Canvas write. Do **not** test a real graded submission.

1. Without GEMINI_API_KEY, check /pending and /status still work and ordinary chat reports the missing optional configuration.
2. With a valid API key, ask "What's due this week?" and verify title, IDs and dates against Canvas; ask follow-up questions.
3. Request /draft <course ID> <assignment ID>. Check the entire draft, explanation and gaps. Request a revision and verify it creates a different draft.
4. Ask Gemini to prepare the revised draft. Confirm that the preview shows the assignment, online_text_entry type, a content excerpt and recommendation, but no Canvas write happens.
5. Tap Review full submission, inspect every chunk, then Cancel. Verify there is no Canvas submission.
6. **Only after separate explicit maintainer authorization for this exact test**, prepare it again, review, then Confirm. Verify the Canvas timestamp and body match the approved version. Try tapping Confirm again; it must not submit a second time. Without that authorization, leave this step NOT RUN.
7. For a separate test assignment allowing online_url, **only after separate explicit maintainer authorization**, stage an HTTP(S) URL, review, confirm, and verify the URL. Otherwise leave this step NOT RUN.
8. Try a locked or unsupported submission, an expired preview, and an unauthorized Telegram account. All must fail safely. Request a monitoring or Calendar change in natural language; verify the setting stays unchanged until your separate Telegram button confirmation. Test cancel, expiry, unauthorized sender, and a repeated click.
9. Simulate a Canvas submission timeout in a mocked test, **not against a real Canvas assignment**; check that the result is "uncertain" and never automatically retried.
10. Verify the existing /report CSV import and systemd monitoring timers still behave as before.

**Known limitations:** No live Gemini, Telegram or Canvas acceptance test is performed in GitHub CI. CI uses isolated mocks. Natural-language action authorization uses a deliberately conservative phrase check of the user's current message; ambiguous phrasings can require an explicit rewording. Neither OpenAI nor self-hosted models have adapters or validated tool/JSON semantics yet. Publishing a v0.5.0 release requires operator validation.
