// Inline SVG icons. Single-colour, stroke-based, sized via className.
// Replaces emoji in buttons / section anchors — emoji looks cheap on a
// premium product. Use currentColor so icons inherit text colour.

type IconProps = {
  className?: string;
  strokeWidth?: number;
};

const defaults = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function RefreshIcon({ className = "h-4 w-4", strokeWidth = 2 }: IconProps) {
  return (
    <svg {...defaults} strokeWidth={strokeWidth} className={className} aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

export function MailIcon({ className = "h-4 w-4", strokeWidth = 2 }: IconProps) {
  return (
    <svg {...defaults} strokeWidth={strokeWidth} className={className} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

export function DownloadIcon({ className = "h-4 w-4", strokeWidth = 2 }: IconProps) {
  return (
    <svg {...defaults} strokeWidth={strokeWidth} className={className} aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

export function EditIcon({ className = "h-4 w-4", strokeWidth = 2 }: IconProps) {
  return (
    <svg {...defaults} strokeWidth={strokeWidth} className={className} aria-hidden="true">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

export function EggIcon({ className = "h-4 w-4", strokeWidth = 2 }: IconProps) {
  return (
    <svg {...defaults} strokeWidth={strokeWidth} className={className} aria-hidden="true">
      <path d="M12 2c4 0 7 5 7 10a7 7 0 1 1-14 0c0-5 3-10 7-10Z" />
    </svg>
  );
}

export function ThermometerIcon({ className = "h-4 w-4", strokeWidth = 2 }: IconProps) {
  return (
    <svg {...defaults} strokeWidth={strokeWidth} className={className} aria-hidden="true">
      <path d="M14 4a2 2 0 0 0-4 0v10.5a4 4 0 1 0 4 0Z" />
    </svg>
  );
}

export function DropletIcon({ className = "h-4 w-4", strokeWidth = 2 }: IconProps) {
  return (
    <svg {...defaults} strokeWidth={strokeWidth} className={className} aria-hidden="true">
      <path d="M12 2.5s7 7.5 7 12a7 7 0 1 1-14 0c0-4.5 7-12 7-12Z" />
    </svg>
  );
}

export function HomeIcon({ className = "h-4 w-4", strokeWidth = 2 }: IconProps) {
  return (
    <svg {...defaults} strokeWidth={strokeWidth} className={className} aria-hidden="true">
      <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M9 22V12h6v10" />
    </svg>
  );
}

export function ArrowLeftIcon({ className = "h-4 w-4", strokeWidth = 2 }: IconProps) {
  return (
    <svg {...defaults} strokeWidth={strokeWidth} className={className} aria-hidden="true">
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

export function CheckIcon({ className = "h-4 w-4", strokeWidth = 2.5 }: IconProps) {
  return (
    <svg {...defaults} strokeWidth={strokeWidth} className={className} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
