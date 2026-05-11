import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";

const products = [
  {
    name: "Origin Pro",
    tagline: "Factory calibrated. IP67 waterproof.",
    price: "$95",
    features: [
      "Factory-calibrated temperature & humidity",
      "IP67 waterproof housing",
      "Calibration certificate included",
      "Calibration kit included",
      "Annual recalibration service",
    ],
    badge: "Flagship",
  },
  {
    name: "Origin Lite",
    tagline: "Compact. Simple. Reliable.",
    price: "$55",
    features: [
      "Same core readings",
      "Compact form factor",
      "Ideal for secondary placements",
      "Pairs with the Origin Monitor app",
    ],
    badge: null,
  },
  {
    name: "Origin Primus",
    tagline: "Monitor your incubator from anywhere.",
    price: "~$250–300",
    features: [
      "4.3\" LCD basestation",
      "WiFi + BLE — connects 4 sensors",
      "Live worldwide remote monitoring",
      "No phone proximity needed",
    ],
    badge: "Coming soon",
  },
  {
    name: "Origin Arca",
    tagline: "Australian-made cabinet incubator.",
    price: "TBA",
    features: [
      "Designed and built in Australia",
      "Premium cabinet form factor",
      "World-first features",
      "Full Origin ecosystem integration",
    ],
    badge: "In development",
  },
];

const steps = [
  {
    n: "01",
    title: "Place the sensor",
    body: "Drop an Origin Monitor into your incubator. No wiring. IP67 so humidity is never an issue.",
  },
  {
    n: "02",
    title: "Open the Origin Monitor app",
    body: "Free Android app pairs automatically over Bluetooth. Live temperature, humidity, and battery at a glance.",
  },
  {
    n: "03",
    title: "Add Origin Primus (optional)",
    body: "Plug in the basestation and watch your incubator from anywhere in the world over WiFi.",
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen">
      <SiteNav />

      {/* Hero */}
      <section className="grain relative overflow-hidden">
        <div className="mx-auto max-w-6xl px-6 pb-24 pt-20 md:pb-32 md:pt-28">
          <div className="max-w-3xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-grass/30 bg-grass/10 px-3 py-1 text-xs font-medium text-light">
              <span className="h-1.5 w-1.5 rounded-full bg-light" />
              Designed in Australia by Uneek Poultry
            </div>
            <h1 className="text-4xl font-bold tracking-tight text-white md:text-6xl md:leading-[1.05]">
              Incubation data you can{" "}
              <span className="bg-gradient-to-r from-grass to-light bg-clip-text text-transparent">
                actually trust
              </span>
              .
            </h1>
            <p className="mt-6 max-w-2xl text-lg text-white/70">
              Origin Monitor is a premium IoT ecosystem built specifically for
              serious poultry breeders. Factory-calibrated sensors, a locked
              companion app, and worldwide remote monitoring — all in one
              stack.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-4">
              <Link href="#products" className="btn-primary">
                View the lineup
              </Link>
              <a
                href="https://uneekpoultry.com.au"
                target="_blank"
                rel="noreferrer"
                className="btn-ghost"
              >
                Shop on Uneek Poultry →
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Products */}
      <section id="products" className="border-t border-white/5">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="mb-12 flex items-end justify-between gap-6">
            <div>
              <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
                The lineup
              </h2>
              <p className="mt-2 max-w-xl text-white/60">
                Four products. One ecosystem. Buy what you need today, add more
                later.
              </p>
            </div>
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            {products.map((p) => (
              <div key={p.name} className="card relative overflow-hidden">
                {p.badge && (
                  <span className="absolute right-5 top-5 rounded-full border border-light/30 bg-light/10 px-2.5 py-0.5 text-xs font-medium text-light">
                    {p.badge}
                  </span>
                )}
                <h3 className="text-xl font-semibold">{p.name}</h3>
                <p className="mt-1 text-sm text-white/60">{p.tagline}</p>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-3xl font-bold">{p.price}</span>
                  <span className="text-sm text-white/40">AUD</span>
                </div>
                <ul className="mt-6 space-y-2 text-sm text-white/70">
                  {p.features.map((f) => (
                    <li key={f} className="flex gap-2">
                      <span className="mt-1 block h-1 w-1 flex-shrink-0 rounded-full bg-light" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-10 rounded-xl border border-white/5 bg-white/[0.02] p-6 text-sm text-white/60">
            <strong className="text-white">The Origin Monitor app</strong> —
            free on Android — is included with every sensor and locks to Origin
            hardware.
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="border-t border-white/5 bg-black/20">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            How it works
          </h2>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {steps.map((s) => (
              <div key={s.n}>
                <div className="text-sm font-semibold tracking-widest text-light">
                  {s.n}
                </div>
                <h3 className="mt-3 text-xl font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-white/60">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust block */}
      <section className="border-t border-white/5">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid gap-8 md:grid-cols-3">
            <Trust title="Factory calibrated" body="Every Pro sensor ships with a calibration certificate and salt-solution reference kit. No guessing." />
            <Trust title="Locked ecosystem" body="The Origin Monitor app only pairs with Origin sensors. No compatibility guesswork, no third-party hardware." />
            <Trust title="Built in Australia" body="Designed, assembled, and supported locally by Uneek Poultry. Same-country support, same-country calibration." />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section id="pricing" className="border-t border-white/5 bg-gradient-to-b from-transparent to-forest/10">
        <div className="mx-auto max-w-4xl px-6 py-20 text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Ready to upgrade your hatchery?
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-white/60">
            Sensors ship Australia-wide from Uneek Poultry. Create an account
            here to register, calibrate, and monitor.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <a
              href="https://uneekpoultry.com.au"
              target="_blank"
              rel="noreferrer"
              className="btn-primary"
            >
              Buy on Uneek Poultry
            </a>
            <Link href="/signup" className="btn-ghost">
              Create your account
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

function Trust({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div className="h-10 w-10 rounded-lg bg-grass/10 ring-1 ring-grass/30" />
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-white/60">{body}</p>
    </div>
  );
}
