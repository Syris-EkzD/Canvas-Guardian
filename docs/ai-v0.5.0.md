# Conversational Gemini and submission review (v0.5.0 candidate)

This feature is **not enabled unless GEMINI_API_KEY is configured**. It adds chat and drafting to the existing authorized private Telegram bot. No separate service or database is required.

## Capabilities and boundaries

- Send a normal message or use /ai followed by a request. Gemini may list pending/today/week/saved activities, read an assignment and rubric, show announcements or report local monitoring/calendar settings.
- /draft <course ID> <assignment ID> explicitly requests a draft for one Canvas assignment. You can also ask in natural language after discovering the IDs. Revisions reference the saved draft version.
- Drafts are generated using src/gemini-draft-engine.js and shown as full Telegram text. A new revision has a new draft identifier.
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

- Keep Node.js 24. Run npm ci and npm test. The deployment's GEMINI_API_KEY must have access to the configured model. GEMINI_MODEL is optional; the existing default is gemini-3.8-flash.
- Preserve the existing SQLite data/horus.db* state, along with the configured Canvas token, Google credentials and Telegram chat ID. AI tables are created lazily on first use.
- The bot handles /start, /stop, /pause, /resume, /status, /pending, /today, /week, /activities, /announcements, /calendar, /report exactly as before.
- Use /forget to remove recent local AI chat history and drafts and invalidate pending submission approvals. This does not remove Telegram messages, Google API logs or already-completed Canvas submissions.
- Replies are bounded by message and tool-iteration limits. Large drafts and approval content are split to respect Telegram's message size.
- The Gemini API and Canvas submission endpoints are the only new external services/operations. The scheduled monitoring jobs remain independent of Gemini.

## Manual acceptance tests on a **non-graded practice assignment**

Use a test assignment you own and are allowed to submit. Do **not** test a real graded submission.

1. Without GEMINI_API_KEY, check /pending and /status still work and ordinary chat reports the missing optional configuration.
2. With a valid API key, ask "What's due this week?" and verify title, IDs and dates against Canvas; ask follow-up questions.
3. Request /draft <course ID> <assignment ID>. Check the entire draft, explanation and gaps. Request a revision and verify it creates a different draft.
4. Ask Gemini to prepare the revised draft. Confirm that the preview shows the assignment, online_text_entry type, a content excerpt and recommendation, but no Canvas write happens.
5. Tap Review full submission, inspect every chunk, then Cancel. Verify there is no Canvas submission.
6. Prepare it again, review, then Confirm. Verify the Canvas timestamp and body match the approved version. Try tapping Confirm again; it must not submit a second time.
7. For a separate test assignment allowing online_url, stage an HTTP(S) URL, review, confirm, and verify the URL.
8. Try a locked or unsupported submission, an expired preview, and an unauthorized Telegram account. All must fail safely.
9. Simulate a Canvas submission timeout in a mocked test, **not against a real Canvas assignment**; check that the result is "uncertain" and never automatically retried.
10. Verify the existing /report CSV import and systemd monitoring timers still behave as before.

**Known limitation:** No live Gemini, Telegram or Canvas acceptance test is performed in GitHub CI. CI uses isolated mocks. Publishing a v0.5.0 release requires operator validation.
