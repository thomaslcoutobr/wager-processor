/** DI tokens: the HTTP layer depends on application ports, never on infrastructure classes. */
export const TOKENS = {
  submit: Symbol("SubmitWagerTransaction"),
  createWallet: Symbol("CreateWallet"),
  readStore: Symbol("ReadStore"),
  ids: Symbol("IdGenerator"),
  health: Symbol("HealthChecks"),
  metrics: Symbol("PromMetrics"),
  reconcile: Symbol("ReconcileWallet"),
  lifecycle: Symbol("Lifecycle"),
  jobs: Symbol("BackgroundJobs"),
} as const;
