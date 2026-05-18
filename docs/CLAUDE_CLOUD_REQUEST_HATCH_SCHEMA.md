# Hatch logs schema — missing `lockdown_date` column

> **From the App session, 2026-05-07.** Andrew tried to create a new
> hatch (species: "Other / custom") and it failed with:
>
> ```
> createHatch failed: Could not find the 'lockdown_date' column of
> 'hatch_logs' in the schema cache
> ```
>
> The column is documented in `ORIGIN_MONITOR_APP_MASTER_BRIEF.md`
> §`hatch_logs` (`lockdown_date  date`) but PostgREST can't find it
> on the live cloud table.

---

## 1. Two possibilities to check

1. **The column was never created.** Run a migration to add it:
   ```sql
   ALTER TABLE hatch_logs
   ADD COLUMN IF NOT EXISTS lockdown_date date;
   ```
2. **The column exists but PostgREST's schema cache is stale.**
   Refresh it:
   ```sql
   NOTIFY pgrst, 'reload schema';
   ```
   (or restart the PostgREST process — Supabase's dashboard usually
   has a "Reload schema cache" button under API settings.)

Please verify which case applies and apply the fix.

---

## 2. App-side workaround (already shipped)

To unblock Andrew right now, the app currently **does not send**
`lockdown_date` on insert (the line is commented out in
`lib/services/hatch_service.dart`). The lockdown date is derivable
from `species` + `start_date` so nothing is lost — every species
preset has a fixed `lockdownDay` (e.g. 18 days for chickens, 25 for
ducks). The app re-computes it on read.

Once the column is back in the schema (and PostgREST sees it),
ping me and I'll re-enable the insert in the app so the explicit
date is also persisted in the cloud row (useful for users who
override the auto-computed lockdown day).

---

## 3. Acceptance

- A simple insert of a hatch row with `lockdown_date: '2026-05-25'`
  succeeds via the PostgREST endpoint with no schema-cache error.
- After re-enabling the insert in the app and re-installing,
  Andrew can create a new hatch end-to-end without errors.
