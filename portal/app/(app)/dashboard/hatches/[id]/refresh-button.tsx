"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshIcon } from "@/components/icons";

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  function handleClick() {
    startTransition(() => {
      router.refresh();
      setLastRefreshed(new Date());
    });
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="btn-ghost inline-flex items-center gap-2"
        aria-label="Refresh data from cloud"
      >
        <RefreshIcon
          className={`h-4 w-4 ${pending ? "animate-spin" : ""}`}
        />
        <span>{pending ? "Refreshing…" : "Refresh"}</span>
      </button>
      {lastRefreshed && !pending && (
        <span className="text-xs text-white/40">
          Refreshed{" "}
          {lastRefreshed.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      )}
    </div>
  );
}
