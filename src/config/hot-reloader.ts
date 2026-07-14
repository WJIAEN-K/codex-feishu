export interface ReloadableService {
  stop(): Promise<void>;
}

export type ReloadResult<Config = unknown> =
  | { status: "unchanged" }
  | { status: "reloaded" }
  | { status: "rolled_back"; error: Error; config: Config };

export class ServiceHotReloader<Config, Service extends ReloadableService> {
  private chain = Promise.resolve();

  constructor(
    private currentConfig: Config,
    private currentService: Service,
    private readonly start: (config: Config) => Promise<Service>,
    private readonly fingerprint: (config: Config) => string,
  ) {}

  reload(nextConfig: Config): Promise<ReloadResult<Config>> {
    const operation = this.chain.then(() => this.performReload(nextConfig));
    this.chain = operation.then(() => {}, () => {});
    return operation;
  }

  async stop(): Promise<void> {
    await this.chain;
    await this.currentService.stop();
  }

  private async performReload(nextConfig: Config): Promise<ReloadResult<Config>> {
    if (this.fingerprint(nextConfig) === this.fingerprint(this.currentConfig)) {
      // Some configuration fields can be consumed live without restarting the
      // service. Keep the rollback snapshot current so a later failed restart
      // cannot restore stale data.
      this.currentConfig = nextConfig;
      return { status: "unchanged" };
    }
    const previousConfig = this.currentConfig;
    await this.currentService.stop();
    try {
      this.currentService = await this.start(nextConfig);
      this.currentConfig = nextConfig;
      return { status: "reloaded" };
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      try {
        this.currentService = await this.start(previousConfig);
        return { status: "rolled_back", error: normalized, config: previousConfig };
      } catch (rollbackError) {
        throw new AggregateError(
          [normalized, rollbackError],
          "新配置启动失败，并且无法恢复上一份配置",
        );
      }
    }
  }
}
