export type LogLevel = "debug" | "info" | "warn" | "error";

const weights: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private readonly level: LogLevel = "info") {}

  debug(message: string, ...details: unknown[]): void { this.write("debug", message, details); }
  info(message: string, ...details: unknown[]): void { this.write("info", message, details); }
  warn(message: string, ...details: unknown[]): void { this.write("warn", message, details); }
  error(message: string, ...details: unknown[]): void { this.write("error", message, details); }

  private write(level: LogLevel, message: string, details: unknown[]): void {
    if (weights[level] < weights[this.level]) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
    const output = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    output(line, ...details);
  }
}
