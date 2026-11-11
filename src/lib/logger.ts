import pino from "pino";
import { env } from "../config/env.js";

/**
 * Structured logger. In development it pretty-prints; in production it emits
 * JSON lines suitable for shipping to the monitoring stack (§10 — GlitchTip /
 * log alerts). Create child loggers per component with `logger.child({ mod })`.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
});

export type Logger = typeof logger;
