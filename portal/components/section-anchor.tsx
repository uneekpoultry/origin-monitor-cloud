// Section anchor — a full-width horizontal rule + small uppercase label +
// large heading. Creates an unmistakable "chapter break" between major
// modules of the hatch page. Pattern from editorial / premium SaaS design
// (Linear, Stripe Docs, The Information).
//
// Visual:
//   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   ← gold rule
//   SECTION 01                                       ← small, uppercase, gold
//   Sensors & devices                                ← large heading
//   Which sensors are reporting…                     ← muted description

type Props = {
  label?: string;        // optional small uppercase label (e.g. "Section 01")
  heading: string;       // required large heading
  description?: string;  // optional muted subtitle below heading
  tone?: "default" | "amber"; // amber for ambient-themed sections
  actions?: React.ReactNode; // optional trailing element (right-aligned, e.g. a button)
  className?: string;
};

export function SectionAnchor({
  label,
  heading,
  description,
  tone = "default",
  actions,
  className = "",
}: Props) {
  // Gradient rule reads more "designed" than a flat line, but we keep a
  // strong solid segment at the left so it registers as a real divider.
  const ruleClass =
    tone === "amber"
      ? "bg-gradient-to-r from-amber-400/80 via-amber-400/30 to-transparent"
      : "bg-gradient-to-r from-light/80 via-light/30 to-transparent";

  const labelColor =
    tone === "amber" ? "text-amber-300/90" : "text-light";

  return (
    <div className={className}>
      {/* Full-width horizontal rule — the "chapter break" */}
      <div className={`h-px w-full ${ruleClass}`} />

      {/* Heading row with optional label + optional right-aligned actions */}
      <div className="mt-5 flex items-end justify-between gap-4">
        <div>
          {label && (
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.22em] ${labelColor}`}
            >
              {label}
            </p>
          )}
          <h2
            className={`${label ? "mt-1" : ""} text-3xl font-bold tracking-tight text-white`}
          >
            {heading}
          </h2>
          {description && (
            <p className="mt-2 text-sm text-white/55">{description}</p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
