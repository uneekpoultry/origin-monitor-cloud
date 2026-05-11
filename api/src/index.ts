import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { env } from "./lib/env.js";
import { healthRouter } from "./routes/health.js";
import { primusRouter } from "./routes/primus.js";

const app = express();

app.set("trust proxy", 1); // behind Nginx

app.use(helmet());
app.use(
  cors({
    origin: env.corsOrigins,
    credentials: true,
  }),
);
app.use(express.json({ limit: "256kb" }));
app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));

// Global, generous rate limiter. Route-specific limits can tighten later.
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Routes
app.use("/", healthRouter);
app.use("/primus", primusRouter);

// Fallback
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

app.listen(env.port, () => {
  console.log(
    `[origin-monitor-api] listening on :${env.port} (${env.nodeEnv})`,
  );
});
