"use client";

import { useState, useTransition } from "react";
import { emailHatchReport } from "../actions";
import { MailIcon } from "@/components/icons";

export function EmailReportButton({ hatchId }: { hatchId: string }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );

  function flash(tone: "ok" | "err", text: string) {
    setMsg({ tone, text });
    setTimeout(() => setMsg(null), 4000);
  }

  function handleClick() {
    startTransition(async () => {
      const r = await emailHatchReport(hatchId);
      if (r.error) flash("err", r.error);
      else if (r.message) flash("ok", r.message);
    });
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        className="btn-ghost inline-flex items-center gap-2"
        disabled={pending}
      >
        <MailIcon className="h-4 w-4" />
        <span>{pending ? "Sending…" : "Email report"}</span>
      </button>
      {msg && (
        <span
          className={`text-xs ${msg.tone === "ok" ? "text-light" : "text-red-300"}`}
        >
          {msg.text}
        </span>
      )}
    </div>
  );
}
