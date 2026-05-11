# Primus addendum — email current hatch report

> Tiny firmware change. Paste into the Primus Claude Code session.

## What it does

The LCD gets an **"Email report"** action (menu option or button on the active-hatch card). Pressing it asks the cloud to generate the same XLSX the web download produces and email it to the account holder.

## Endpoint

```
POST /primus/email-report
Authorization: Bearer <api_key>
Content-Type: application/json

{ "hatch_id": "<uuid>" }    // optional — omit to get the most recent active hatch
```

Response on success:
```json
{
  "ok": true,
  "emailed_to": "owner@example.com",
  "hatch_name": "Sussex batch 1"
}
```

Errors:
- `404 no_active_hatch` — user has no active hatch to email (if `hatch_id` was omitted)
- `404 hatch_not_found` — `hatch_id` doesn't belong to this Primus's owner
- `404 user_has_no_email` — the account has no email address on file (shouldn't happen)
- `429 rate_limited` — an email for this hatch was sent in the last 10 minutes

Rate limit is per-hatch, 10 minutes, enforced server-side. Don't retry a 429 immediately; back off.

## Suggested UI

- **Dashboard card 4** (status / countdown) gets a small "📧 Email report" button
- On press: send the POST, show a spinner for ~2s, then replace with a transient toast: "Sent to owner@example.com" (green) or the error message (amber / red)
- After success, disable the button for 10 minutes to match the server rate-limit

The request is idempotent apart from the rate limit — pressing twice in quick succession is fine; the second call returns 429 and nothing bad happens.

## What NOT to do

- Don't build the XLSX on the Primus — the cloud does it, Primus just triggers
- Don't accept a "to:" email address from the device — the cloud always sends to the account owner for security
