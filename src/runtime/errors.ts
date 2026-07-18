export class RuntimeNotFoundError extends Error {
  constructor(message = "No usable Codex Runtime was found") {
    super(message);
    this.name = "RuntimeNotFoundError";
  }
}

export class RuntimeDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeDownloadError";
  }
}

export class RuntimeChecksumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeChecksumError";
  }
}

export class RuntimeUnsupportedPlatformError extends Error {
  constructor(platform: NodeJS.Platform, arch: NodeJS.Architecture) {
    super(`Unsupported Codex Runtime platform: ${platform}/${arch}`);
    this.name = "RuntimeUnsupportedPlatformError";
  }
}

export class RuntimeVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeVerificationError";
  }
}

export class AppServerHandshakeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppServerHandshakeError";
  }
}

export class CodexAuthenticationRequiredError extends Error {
  constructor(message = "Codex authentication is required") {
    super(message);
    this.name = "CodexAuthenticationRequiredError";
  }
}

export class DesktopRuntimeAccessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DesktopRuntimeAccessError";
  }
}
