import Image from "next/image";
import Link from "next/link";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link
      href="/"
      className={`inline-flex items-center gap-2.5 ${className}`}
      aria-label="Origin Monitor home"
    >
      <Image
        src="/logo.png"
        alt=""
        width={32}
        height={32}
        className="h-8 w-8 select-none"
        priority
      />
      <span className="text-base font-bold tracking-tight text-white">
        Origin <span className="text-light">Monitor</span>
      </span>
    </Link>
  );
}
