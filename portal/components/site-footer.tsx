import Link from "next/link";
import { Logo } from "./logo";

export function SiteFooter() {
  return (
    <footer className="border-t border-white/5 bg-ink">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 md:grid-cols-4">
        <div className="md:col-span-2">
          <Logo />
          <p className="mt-4 max-w-sm text-sm text-white/60">
            Premium IoT temperature and humidity monitoring for poultry
            incubation. Designed and assembled in Australia by{" "}
            <a
              className="text-light hover:underline"
              href="https://uneekpoultry.com.au"
              target="_blank"
              rel="noreferrer"
            >
              Uneek Poultry
            </a>
            .
          </p>
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-widest text-white/40">
            Products
          </h4>
          <ul className="mt-4 space-y-2 text-sm text-white/70">
            <li>Origin Pro</li>
            <li>Origin Lite</li>
            <li>Origin Primus</li>
            <li>Origin Arca</li>
            <li>Origin Calibration Kit</li>
            <li className="text-white/40">Origin Monitor (app)</li>
          </ul>
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-widest text-white/40">
            Company
          </h4>
          <ul className="mt-4 space-y-2 text-sm text-white/70">
            <li>
              <Link href="/support" className="hover:text-white">
                Support
              </Link>
            </li>
            <li>
              <a
                href="mailto:support@originmonitor.com"
                className="hover:text-white"
              >
                support@originmonitor.com
              </a>
            </li>
            <li>
              <a
                href="https://uneekpoultry.com.au"
                target="_blank"
                rel="noreferrer"
                className="hover:text-white"
              >
                Shop on Uneek Poultry
              </a>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/5">
        <div className="mx-auto max-w-6xl px-6 py-6 text-xs text-white/40">
          © {new Date().getFullYear()} Uneek Poultry. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
