"use client";

import { useState, type ReactNode } from "react";

export type HatchTab = {
  id: string;
  label: string;
  content: ReactNode;
};

/**
 * Top-level tab strip on the hatch detail page. Content for every tab is
 * passed in up-front — switching tabs just changes which panel is visible.
 * Simple, no URL state (yet), survives page refresh by starting on Daily
 * Log (the tab farmers open daily).
 *
 * Ambient room-context banner (if shown) lives inside the parent page,
 * not inside this component, so it's visible regardless of which tab
 * is open.
 */
export function HatchTabs({
  tabs,
  initialId,
}: {
  tabs: HatchTab[];
  initialId?: string;
}) {
  const defaultId = initialId ?? tabs[0]?.id ?? "";
  const [activeId, setActiveId] = useState(defaultId);

  return (
    <div>
      <div className="flex flex-wrap gap-1 border-b border-white/10">
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveId(t.id)}
              className={`relative px-4 py-2.5 text-sm transition ${
                active
                  ? "font-semibold text-white"
                  : "text-white/50 hover:text-white"
              }`}
            >
              {t.label}
              {active && (
                <span className="absolute inset-x-0 -bottom-[1px] h-[2px] bg-light" />
              )}
            </button>
          );
        })}
      </div>

      {/*
        Render all panels but only show the active one. Keeps form state
        alive when the user switches tabs and comes back (e.g. mid-edit on
        the Daily log).
      */}
      <div className="mt-6">
        {tabs.map((t) => (
          <div key={t.id} className={t.id === activeId ? "block" : "hidden"}>
            {t.content}
          </div>
        ))}
      </div>
    </div>
  );
}
