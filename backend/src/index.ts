import { createHttpServer } from "./utils/http-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "fs/promises";
import { initializeDatabase } from "./db/schema";
import { listRepos } from "./db/queries";
import { createRepoRoutes } from "./routes/repos";
import { createRepoTerminalSocketRoutes } from "./routes/repo-terminal-socket";
import { createIPCServer, type IPCServer } from "./ipc/ipcServer";
import { GitAuthService } from "./services/git-auth";
import { createSettingsRoutes } from "./routes/settings";
import { createDevicePairingRoutes } from "./routes/device-pairing";
import { createHealthRoutes } from "./routes/health";
import { createTTSRoutes, cleanupExpiredCache } from "./routes/tts";
import { createSTTRoutes } from "./routes/stt";
import { createFileRoutes } from "./routes/files";
import { createFilesystemRoutes } from "./routes/filesystem";
import {
  createScheduleRoutes,
  createServerScheduleRoutes,
} from "./routes/schedules";

async function getAppVersion(): Promise<string> {
  try {
    const packageUrl = new URL("../../package.json", import.meta.url);
    const packageJsonRaw = await readFile(packageUrl, "utf-8");
    const packageJson = JSON.parse(packageJsonRaw) as { version?: string };
    return packageJson.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
import { createProvidersRoutes } from "./routes/providers";
import { loadClaudeProxyClient } from "./services/claude-proxy-config";
import { CliproxyUsageCollector } from "./services/cliproxy-usage-collector";
import { loadClaudeInference } from "./services/claude-inference-config";
import { createClaudeInferenceRoutes } from "./routes/claude-inference";
import { protectRawClaudeMutations } from "./routes/claude-raw-ownership";
import {
  maintenanceAdmission,
  maintenanceHttpAdmission,
} from "./services/maintenance-admission";
import { createMessageSearchRoutes } from "./routes/message-search";
import { MessageSearchService } from "./services/message-search";
import { MESSAGE_SEARCH_PROJECTION } from "./services/message-search-projection";
import { createStatsRoutes } from "./routes/stats";
import { TokenUsageIndex } from "./services/stats/token-usage-index";
import { ModelPriceCache } from "./services/stats/pricing";
import { ScheduleOverviewReader } from "./services/overview-source";
import { createWorkflowRoutes } from "./routes/workflow";
import { createSystemRoutes } from "./routes/system";
import { SystemStatusService } from "./services/system-status";
import { WorkflowStatsSource } from "./services/stats/workflow-source";
import { runLearningScript } from "./services/learnings/script-runner";
import { getAssistantModeDirectory } from "./services/assistant-mode";
import {
  mcpStatusByName,
  openCodeLocation,
} from "@opencode-manager/shared/opencode";
import { z } from "zod";
import { createOAuthRoutes } from "./routes/oauth";
import { createSSERoutes } from "./routes/sse";
import { createSSHRoutes } from "./routes/ssh";
import { createNotificationRoutes } from "./routes/notifications";
import { createMcpOauthProxyRoutes } from "./routes/mcp-oauth-proxy";
import {
  createAuthRoutes,
  createAuthInfoRoutes,
  syncAdminFromEnv,
} from "./routes/auth";
import { createAuth } from "./auth";
import { createAuthMiddleware } from "./auth/middleware";
import { createPromptTemplateRoutes } from "./routes/prompt-templates";
import { createSessionPinRoutes } from "./routes/session-pins";
import { createSessionPermissionModeRoutes } from "./routes/session-permission-modes";
import { createSessionSandboxRoutes } from "./routes/session-sandbox";
import { createSessionGoalRoutes } from "./routes/session-goals";
import { createMultiRunRoutes } from "./routes/multi-runs";
import { createChangeWalkthroughRoutes } from "./routes/change-walkthroughs";
import { getChangeWalkthroughByWalkthroughSession } from "./db/change-walkthroughs";
import { createLogRoutes } from "./routes/logs";
import {
  createPreviewRoutes,
  createPreviewAvailability,
} from "./routes/preview";
import { createGlobalSecretRoutes } from "./routes/secrets";
import {
  createPreviewGatewayApp,
  PreviewSessionStore,
} from "./services/preview/gateway";
import { createInternalRoutes } from "./routes/internal";
import { createLearningLintRoutes } from "./routes/internal/learnings";
import { TelegramSettingsService } from "./services/telegram-settings";
import { sweepStaleUploadSessions } from "./routes/internal/repo-mirror-helpers";
import { createOpenCodeProxyRoutes } from "./routes/opencode-proxy";
import { createAuthenticatedOpenCodeProxyRoutes } from "./routes/opencode-auth-proxy";
import { createOpenCodeServerProxyRoutes } from "./routes/opencode-server-proxy";
import { createOpenCodeServerRoutes } from "./routes/opencode-servers";
import {
  createOpenCodeServerTerminalRoutes,
  createOpenCodeServerTerminalSocketRoutes,
} from "./routes/opencode-server-terminals";
import { sseAggregator } from "./services/sse-aggregator";
import { RemoteServerEventHub } from "./services/remote-server-events";
import {
  ensureDirectoryExists,
  writeFileContent,
  fileExists,
} from "./services/file-operations";
import { SettingsService } from "./services/settings";
import { RemoteAccessHeadersService } from "./services/remote-access-headers";
import { SessionPermissionModeService } from "./services/session-permission-modes";
import { SessionSandboxService } from "./services/session-sandbox";
import { SessionAncestry } from "./services/session-ancestry";
import { SessionGoalService } from "./services/session-goals";
import { MultiRunService } from "./services/multi-runs";
import { ChangeWalkthroughService } from "./services/change-walkthroughs";
import { opencodeServerManager } from "./services/opencode-single-server";
import { createOpenCodeClient } from "./services/opencode/client";
import { OpenCodeServerRegistry } from "./services/opencode-server-registry";
import { getOpenCodeUpstreamBaseUrl } from "./services/opencode/upstream";
import { NotificationService } from "./services/notification";
import { ScheduleRunner, ScheduleService } from "./services/schedules";
import { CredentialProvider } from "./services/credential-provider";
import { TerminalService } from "./services/terminal";
import { ProjectConfigService } from "./services/project-config";
import { SecretsService } from "./services/secrets";
import { RepoEnvService } from "./services/repo-env";
import { RepoWorkspaceService } from "./services/repo-workspace";
import { createGitService } from "./services/git/GitService";
import { ScheduleWorktreeManager } from "./services/schedule-worktree";
import { migrateGlobalSkills } from "./services/skills";
import { installAssistantWorkspace } from "./services/assistant-mode";
import { detectSandboxCapability } from "./services/sandbox/capability";
import {
  SandboxRuntimeService,
  stopSandboxesOnShutdown,
} from "./services/sandbox/runtime";
import {
  getOpenCodeImportStatus,
  syncOpenCodeImport,
} from "./services/opencode-import";
import {
  readOpenCodeConfigFile,
  foldLegacyConfigJsonSource,
  withOpenCodeConfigLock,
} from "./services/opencode-config-file";
import { seedOpenCodeConfigFile } from "./services/opencode-config-apply";
import { OpenCodeSupervisor } from "./services/opencode-supervisor";
import { logger } from "./utils/logger";
import {
  getWorkspacePath,
  getReposPath,
  getConfigPath,
  getAgentsMdPath,
  getDatabasePath,
  getLearningsEntriesPath,
  getOpenCodeDataPath,
  getTrustedOrigins,
  ENV,
} from "@opencode-manager/shared/config/env";
import {
  LOCAL_OPENCODE_SERVER_ID,
  NotificationEventType,
} from "@opencode-manager/shared/schemas";

const { PORT, HOST } = ENV.SERVER;
const DB_PATH = getDatabasePath();
const claudeProxyClient = await loadClaudeProxyClient(process.env);
const claudeInference = await loadClaudeInference(process.env);

const app = new Hono();
const { start, upgradeWebSocket } = createHttpServer(app);

/**
 * Route prefixes reachable from custom WebViews whose origin is not a
 * trusted web origin (e.g. "null" for file://). These routes authenticate via
 * Bearer/CF-Access headers rather than cookies, so any origin may be reflected.
 */
const REFLECT_ANY_ORIGIN_PREFIXES = ["/api/opencode-proxy/", "/api/internal/"];

app.use(
  "/*",
  cors({
    origin: (origin, c) => {
      if (
        origin &&
        REFLECT_ANY_ORIGIN_PREFIXES.some((prefix) =>
          c.req.path.startsWith(prefix),
        )
      ) {
        return origin;
      }
      const trustedOrigins = getTrustedOrigins();
      if (!origin) return trustedOrigins[0];
      if (trustedOrigins.includes(origin)) return origin;
      return trustedOrigins[0];
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "CF-Access-Client-Id",
      "CF-Access-Client-Secret",
    ],
    credentials: true,
  }),
);

const db = initializeDatabase(DB_PATH);
app.use("/api/*", maintenanceHttpAdmission(maintenanceAdmission));
const auth = createAuth(db);
const requireAuth = createAuthMiddleware(auth);
const openCodeClient = createOpenCodeClient(
  () => new SettingsService(db).getOpenCodeServerPassword(),
  () => opencodeServerManager.getEffectiveServerHost(),
);
export const opencodeServerRegistry = new OpenCodeServerRegistry(
  db,
  openCodeClient,
);

import { DEFAULT_AGENTS_MD } from "./constants";

let ipcServer: IPCServer | undefined;
const gitAuthService = new GitAuthService();
const gitService = createGitService(gitAuthService);
const projectConfigService = new ProjectConfigService(
  db,
  gitService,
  gitAuthService,
);
const secretsService = new SecretsService(db);
const repoEnvService = new RepoEnvService(
  db,
  projectConfigService,
  secretsService,
);
const sandboxRuntimeService = new SandboxRuntimeService(db, repoEnvService);
let openCodeSupervisor: OpenCodeSupervisor | undefined;
async function ensureOpenCodeConfigFileExists(): Promise<void> {
  await withOpenCodeConfigLock(foldLegacyConfigJsonSource);

  const existing = await readOpenCodeConfigFile();
  if (existing) {
    if (!existing.isValid) {
      logger.warn(
        "OpenCode config file has validation issues",
        existing.validationIssues,
      );
    }
    return;
  }

  const status = await getOpenCodeImportStatus();
  if (status.configSourcePath) {
    logger.info(
      `Found importable OpenCode config at ${status.configSourcePath}, importing...`,
    );
    try {
      const result = await syncOpenCodeImport({
        overwriteState: false,
        status,
      });
      if (result.configImported) {
        logger.info(
          `Imported OpenCode config from ${status.configSourcePath} to workspace`,
        );
        return;
      }
    } catch (error) {
      logger.warn(
        `Failed to import OpenCode config from ${status.configSourcePath}`,
        error,
      );
    }
  }

  await seedOpenCodeConfigFile();
  logger.info("Created minimal seed config");
}

async function ensureHomeStateImported(): Promise<void> {
  try {
    const status = await getOpenCodeImportStatus();
    if (status.workspaceStateExists) {
      return;
    }

    if (!status.stateSourcePath) {
      return;
    }

    const result = await syncOpenCodeImport({
      overwriteState: false,
      importConfig: false,
      status,
    });
    if (result.stateImported) {
      logger.info(`Imported OpenCode state from ${status.stateSourcePath}`);
    }
  } catch (error) {
    logger.warn(
      "Failed to import OpenCode state, continuing without imported state",
      error,
    );
  }
}

async function ensureDefaultAgentsMdExists(): Promise<void> {
  const agentsMdPath = getAgentsMdPath();
  const exists = await fileExists(agentsMdPath);

  if (!exists) {
    await writeFileContent(agentsMdPath, DEFAULT_AGENTS_MD);
    logger.info(`Created default AGENTS.md at: ${agentsMdPath}`);
  }
}

try {
  if (ENV.SERVER.NODE_ENV === "production" && !ENV.AUTH.SECRET) {
    logger.error("AUTH_SECRET is required in production mode");
    logger.error("Generate one with: openssl rand -base64 32");
    logger.error("Set it as environment variable: AUTH_SECRET=your-secret");
    process.exit(1);
  }

  await ensureDirectoryExists(getWorkspacePath());
  await ensureDirectoryExists(getReposPath());
  await ensureDirectoryExists(getConfigPath());
  await ensureDirectoryExists(getLearningsEntriesPath());
  logger.info("Workspace directories initialized");

  await cleanupExpiredCache();
  await sweepStaleUploadSessions();

  await ensureOpenCodeConfigFileExists();
  await ensureHomeStateImported();
  await ensureDefaultAgentsMdExists();

  const settingsService = new SettingsService(db);
  settingsService.initializeLastKnownGoodConfig();

  openCodeSupervisor = new OpenCodeSupervisor(
    opencodeServerManager,
    settingsService,
  );

  await migrateGlobalSkills();

  await installAssistantWorkspace({ db });
  logger.info("Assistant workspace installed");

  ipcServer = await createIPCServer(process.env.STORAGE_PATH || undefined);
  await gitAuthService.initialize(ipcServer, db);
  logger.info(`Git IPC server running at ${ipcServer.ipcHandlePath}`);

  await syncAdminFromEnv(auth, db);

  opencodeServerManager.setDatabase(db);
  detectSandboxCapability();
  void sandboxRuntimeService.prepareSandboxOnBoot().catch((error) => {
    logger.warn("Sandbox preparation failed:", error);
  });
  const openCodeStatus = await openCodeSupervisor.start();
  if (openCodeStatus.healthy) {
    logger.info(`OpenCode server running on port ${openCodeStatus.port}`);
  } else {
    logger.warn(
      `OpenCode server unavailable after startup recovery: ${openCodeStatus.lastError ?? openCodeStatus.state}`,
    );
  }
} catch (error) {
  logger.error("Failed to initialize workspace:", error);
}

const terminalService = new TerminalService(
  {
    client: openCodeClient,
    baseUrl: () =>
      getOpenCodeUpstreamBaseUrl(
        opencodeServerManager.getEffectiveServerHost(),
      ),
    includeLocalEnv: true,
  },
  new CredentialProvider(db),
  repoEnvService,
);
const resolveServerTerminalService = (serverId: string): TerminalService => {
  const connection = opencodeServerRegistry.getConnection(serverId);
  return terminalService.forTarget({
    client: opencodeServerRegistry.getClient(serverId),
    baseUrl: () => connection.baseUrl,
    includeLocalEnv: false,
  });
};
const sessionSettingsService = new SettingsService(db);
const sessionAncestry = new SessionAncestry((serverId) =>
  opencodeServerRegistry.getClient(serverId),
);
const sessionSandboxService = new SessionSandboxService(
  db,
  sessionAncestry,
  sessionSettingsService,
  {
    removeSessionSandbox: (rootSessionId) =>
      sandboxRuntimeService.removeSessionSandbox(rootSessionId),
  },
);
const scheduleWorktreeManager = new ScheduleWorktreeManager(gitAuthService, db);
const scheduleService = new ScheduleService(
  db,
  openCodeClient,
  scheduleWorktreeManager,
  opencodeServerRegistry,
  {
    sessions: sessionSandboxService,
    runtime: sandboxRuntimeService,
  },
);
scheduleService.setWorktreeRemovedHandler(async (directory) => {
  try {
    await terminalService.removeAll(directory);
  } catch (error) {
    logger.warn(
      `Failed to remove terminals for schedule worktree ${directory}:`,
      error,
    );
  }
});
const repoWorkspaces = new RepoWorkspaceService(
  db,
  openCodeClient,
  gitAuthService,
  projectConfigService,
  terminalService,
  scheduleService,
);
const scheduleRunnerInstance = new ScheduleRunner(scheduleService);
const cliproxyUsageCollector = claudeProxyClient
  ? new CliproxyUsageCollector({
      client: claudeProxyClient,
      db,
      pageSize: 200,
      maxPagesPerTick: 10,
      intervalMs: 30_000,
    })
  : null;
cliproxyUsageCollector?.start();

const telegramSettings = new TelegramSettingsService(db);
const notificationService = new NotificationService(
  db,
  opencodeServerRegistry,
  () => telegramSettings.getTransport(),
);
const sessionPermissionModeService = new SessionPermissionModeService(
  db,
  opencodeServerRegistry,
  sessionSettingsService,
  sessionAncestry,
);
const sessionGoalService = new SessionGoalService(
  db,
  opencodeServerRegistry,
  sessionSettingsService,
  {
    onOutcome: (goal) => {
      void notificationService.notifyGoalOutcome(goal).catch((error) => {
        logger.error("Goal outcome notification error:", error);
      });
    },
    resolveSessionLock: async (sessionId, serverId) =>
      (await sessionPermissionModeService.getEffectiveMode(sessionId, serverId))
        .lockedReason,
    resolveSessionLockStrict: (sessionId, serverId) =>
      sessionPermissionModeService.resolveLockReason(sessionId, serverId),
  },
);
sessionGoalService.loadOpenGoals();

const multiRunService = new MultiRunService(
  db,
  openCodeClient,
  repoWorkspaces,
  sessionPermissionModeService,
  (serverId) => opencodeServerRegistry.getClient(serverId),
);
const changeWalkthroughService = new ChangeWalkthroughService(
  db,
  openCodeClient,
  sessionSettingsService,
  gitAuthService,
  gitService,
);

sseAggregator.onEvent((directory, event) => {
  sessionSandboxService.handleEvent(directory, event).catch((err) => {
    logger.error("Session sandbox event handling error:", err);
  });
  try {
    changeWalkthroughService.handleEvent(event);
  } catch (err) {
    logger.error("Change walkthrough event handling error:", err);
  }
});

sseAggregator.onServerEvent((serverId, directory, event) => {
  sessionPermissionModeService
    .handleEvent(directory, event, serverId)
    .catch((err) => {
      logger.error("Session permission mode event handling error:", err);
    });
  sessionGoalService.handleEvent(directory, event, serverId).catch((err) => {
    logger.error("Session goal event handling error:", err);
  });
});

notificationService.addEventSuppressor((event, sessionId, serverId) =>
  sessionPermissionModeService.suppressesPermissionNotification(
    event,
    sessionId,
    serverId,
  ),
);

notificationService.addEventSuppressor(async (event, sessionId, serverId) => {
  if (serverId !== LOCAL_OPENCODE_SERVER_ID) return false;
  if (!sessionId) return false;
  if (
    event.type !== NotificationEventType.SESSION_IDLE &&
    event.type !== NotificationEventType.SESSION_FAILED
  )
    return false;
  return getChangeWalkthroughByWalkthroughSession(db, sessionId) !== null;
});

if (ENV.VAPID.PUBLIC_KEY && ENV.VAPID.PRIVATE_KEY) {
  if (!ENV.VAPID.SUBJECT) {
    logger.warn(
      "VAPID_SUBJECT is not set — push notifications require a mailto: subject (e.g. mailto:you@example.com)",
    );
  } else if (!ENV.VAPID.SUBJECT.startsWith("mailto:")) {
    logger.warn(
      `VAPID_SUBJECT="${ENV.VAPID.SUBJECT}" does not use mailto: format — iOS/Safari push notifications will fail`,
    );
  }

  notificationService.configureVapid({
    publicKey: ENV.VAPID.PUBLIC_KEY,
    privateKey: ENV.VAPID.PRIVATE_KEY,
    subject: ENV.VAPID.SUBJECT || "mailto:push@localhost",
  });
  sseAggregator.onServerEvent((serverId, directory, event) => {
    notificationService
      .handleSSEEvent(directory, event, serverId)
      .catch((err) => {
        logger.error("Push notification dispatch error:", err);
      });
  });
}

sseAggregator.setPendingActionsFetcher(openCodeClient);
sseAggregator.setPasswordResolver(() =>
  new SettingsService(db).getOpenCodeServerPassword(),
);
sseAggregator.onServerConnected((serverId) => {
  void sessionPermissionModeService
    .acceptPendingRequestsForActiveSessions(serverId)
    .catch((err) => {
      logger.error(
        `Failed to accept pending permission requests for server ${serverId}:`,
        err,
      );
    });
});
sseAggregator.start();

const remoteServerEvents = new RemoteServerEventHub(
  opencodeServerRegistry,
  sseAggregator,
);
remoteServerEvents.start();

void sessionGoalService.recoverOpenGoals().catch((error) => {
  logger.error("Session goal recovery error:", error);
});

sseAggregator.setScheduledSessionsResolver(() =>
  scheduleService.getActiveRunSessions(),
);

void scheduleRunnerInstance.start();

const settingsService = new SettingsService(db);
const previewSessionStore = new PreviewSessionStore();
const previewAvailability = createPreviewAvailability(false);

app.route("/api/auth", createAuthRoutes(auth));
app.route("/api/auth-info", createAuthInfoRoutes(auth));
app.route("/api/health", createHealthRoutes(db, openCodeSupervisor));
app.route(
  "/api/claude-inference",
  createClaudeInferenceRoutes(claudeInference),
);

app.route(
  "/api/mcp-oauth-proxy",
  createMcpOauthProxyRoutes(openCodeClient, requireAuth),
);
const systemStatusService = new SystemStatusService();
app.route(
  "/api/internal",
  createInternalRoutes(
    db,
    scheduleService,
    notificationService,
    settingsService,
    openCodeClient,
    sessionPermissionModeService,
    repoWorkspaces,
    gitAuthService,
    sessionGoalService,
    multiRunService,
    changeWalkthroughService,
    sessionSandboxService,
    repoEnvService,
    systemStatusService,
  ),
);
app.route(
  "/api/opencode-proxy",
  createOpenCodeProxyRoutes(
    db,
    settingsService,
    upgradeWebSocket,
    protectRawClaudeMutations({
      ownsInference: Boolean(claudeInference),
      async credentialIntegration(id) {
        const credentials = await openCodeClient.api.credential.list({
          signal: AbortSignal.timeout(5000),
        });
        return credentials.find((entry) => entry.id === id)?.integrationID;
      },
    }),
  ),
);

const protectedApi = new Hono();
protectedApi.use("/*", requireAuth);
protectedApi.route("/system", createSystemRoutes(systemStatusService));
const messageSearch = new MessageSearchService({
  sourcePath: `${getOpenCodeDataPath()}/opencode.db`,
  indexPath: `${getWorkspacePath()}/.opencode/message-search-v2.db`,
  projection: MESSAGE_SEARCH_PROJECTION,
});
protectedApi.route("/messages", createMessageSearchRoutes(messageSearch));
const modelPriceCache = new ModelPriceCache(async () =>
  (await openCodeClient.api.model.list({})).data.map((model) => ({
    providerID: model.providerID,
    modelID: model.modelID,
    cost: model.cost,
  })),
);
const workflowSource = new WorkflowStatsSource({
  openCodeDbPath: `${getOpenCodeDataPath()}/opencode.db`,
  searchLessons: async (queries) => {
    const result = await runLearningScript({
      script: "search.mjs",
      args: [
        "--batch",
        "--include-pending",
        "--limit",
        "3",
        "--entries",
        getLearningsEntriesPath(),
      ],
      stdin: JSON.stringify(queries),
      timeoutMs: 10_000,
    });
    if (result.timedOut || result.exitCode !== 0)
      throw new Error("WORKFLOW_LEARNING_SEARCH_FAILED");
    return z
      .array(z.object({ query: z.string(), ids: z.array(z.string()) }))
      .parse(JSON.parse(result.stdout));
  },
  mcpStatus: async () => {
    const directory = getAssistantModeDirectory();
    const servers = (
      await openCodeClient.api.mcp.list(openCodeLocation(directory) ?? {}, {
        signal: AbortSignal.timeout(10_000),
      })
    ).data;
    return { directory, statuses: mcpStatusByName(servers) };
  },
});
protectedApi.route("/stats/workflow", createWorkflowRoutes(workflowSource));
protectedApi.route(
  "/stats",
  createStatsRoutes(
    new TokenUsageIndex({
      openCodeDbPath: `${getOpenCodeDataPath()}/opencode.db`,
      listRepos: () => listRepos(db),
    }),
    modelPriceCache,
  ),
);

protectedApi.route(
  "/repos",
  createRepoTerminalSocketRoutes(
    db,
    gitAuthService,
    openCodeClient,
    terminalService,
    upgradeWebSocket,
  ),
);
protectedApi.route(
  "/repos",
  createRepoRoutes(
    db,
    gitAuthService,
    scheduleService,
    openCodeClient,
    terminalService,
    projectConfigService,
    repoWorkspaces,
    secretsService,
  ),
);
protectedApi.route(
  "/settings",
  createSettingsRoutes(db, gitAuthService, openCodeClient, openCodeSupervisor),
);
protectedApi.route(
  "/device-pairing",
  createDevicePairingRoutes({
    mintPairingCode: (headers) => auth.api.createDevicePairingCode({ headers }),
    remoteAccessHeaders: new RemoteAccessHeadersService(db),
    readAllowPrivateNetworkHttp: () =>
      settingsService.getSettings("default").preferences.devicePairing
        ?.allowPrivateNetworkHttp === true,
  }),
);
protectedApi.route(
  "/files",
  createFileRoutes(() => listRepos(db)),
);
protectedApi.route("/filesystem", createFilesystemRoutes());
protectedApi.route(
  "/providers",
  createProvidersRoutes(openCodeClient, settingsService, {
    client: claudeProxyClient,
    ownsInference: Boolean(claudeInference),
  }),
);
protectedApi.route("/learnings", createLearningLintRoutes());
protectedApi.route(
  "/oauth",
  createOAuthRoutes(openCodeClient, Boolean(claudeInference)),
);
protectedApi.route("/tts", createTTSRoutes(db));
protectedApi.route("/stt", createSTTRoutes(db));
protectedApi.route("/sse", createSSERoutes());
protectedApi.route("/ssh", createSSHRoutes(gitAuthService));
protectedApi.route(
  "/notifications",
  createNotificationRoutes(notificationService, telegramSettings),
);
protectedApi.route("/prompt-templates", createPromptTemplateRoutes(db));
protectedApi.route(
  "/secrets",
  createGlobalSecretRoutes(secretsService, "secret"),
);
protectedApi.route(
  "/variables",
  createGlobalSecretRoutes(secretsService, "variable"),
);
protectedApi.route("/session-pins", createSessionPinRoutes(db));
protectedApi.route(
  "/opencode-servers/:serverId/schedules",
  createServerScheduleRoutes(scheduleService),
);
protectedApi.route(
  "/opencode-servers",
  createOpenCodeServerTerminalSocketRoutes(
    resolveServerTerminalService,
    upgradeWebSocket,
  ),
);
protectedApi.route(
  "/opencode-servers",
  createOpenCodeServerTerminalRoutes(resolveServerTerminalService),
);
protectedApi.route(
  "/opencode-servers",
  createOpenCodeServerRoutes(opencodeServerRegistry, () =>
    remoteServerEvents.getStatuses(),
  ),
);
protectedApi.route(
  "/session-permission-modes",
  createSessionPermissionModeRoutes(sessionPermissionModeService),
);
protectedApi.route(
  "/session-sandbox",
  createSessionSandboxRoutes(sessionSandboxService),
);
protectedApi.route(
  "/session-goals",
  createSessionGoalRoutes(sessionGoalService),
);
protectedApi.route("/multi-runs", createMultiRunRoutes(multiRunService));
protectedApi.route(
  "/change-walkthroughs",
  createChangeWalkthroughRoutes(changeWalkthroughService),
);
protectedApi.route(
  "/schedules",
  createScheduleRoutes(
    scheduleService,
    new ScheduleOverviewReader(db, modelPriceCache),
  ),
);
protectedApi.route("/logs", createLogRoutes());
protectedApi.route(
  "/preview",
  createPreviewRoutes({
    store: previewSessionStore,
    isEnabled: previewAvailability.isEnabled,
  }),
);

app.route("/api", protectedApi);

app.route(
  "/api/opencode/servers",
  createOpenCodeServerProxyRoutes(opencodeServerRegistry, requireAuth),
);
app.route(
  "/api/opencode",
  createAuthenticatedOpenCodeProxyRoutes(openCodeClient, requireAuth),
);

const isProduction = ENV.SERVER.NODE_ENV === "production";

if (isProduction) {
  app.use("/*", async (c, next) => {
    await next();
    if (c.req.path === "/sw.js") {
      c.res.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      c.res.headers.set("Pragma", "no-cache");
      c.res.headers.set("Expires", "0");
    }
  });

  app.use("/*", serveStatic({ root: "./frontend/dist" }));

  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.notFound();
    }
    const fs = await import("fs/promises");
    const path = await import("path");
    const indexPath = path.join(process.cwd(), "frontend/dist/index.html");
    const html = await fs.readFile(indexPath, "utf-8");
    return c.html(html);
  });
} else {
  app.get("/", async (c) => {
    const version = await getAppVersion();
    return c.json({
      name: "OpenCode WebUI",
      version,
      status: "running",
      endpoints: {
        health: "/api/health",
        repos: "/api/repos",
        settings: "/api/settings",
        sessions: "/api/sessions",
        files: "/api/files",
        providers: "/api/providers",
        opencode_proxy: "/api/opencode/*",
      },
    });
  });

  app.get("/api/network-info", async (c) => {
    const os = await import("os");
    const interfaces = os.networkInterfaces();
    const ips = Object.values(interfaces)
      .flat()
      .filter((info) => info && !info.internal && info.family === "IPv4")
      .map((info) => info!.address);

    const requestHost = c.req.header("host") || `localhost:${PORT}`;
    const protocol = c.req.header("x-forwarded-proto") || "http";

    return c.json({
      host: HOST,
      port: PORT,
      requestHost,
      protocol,
      availableIps: ips,
      apiUrls: [
        `${protocol}://localhost:${PORT}`,
        ...ips.map((ip) => `${protocol}://${ip}:${PORT}`),
      ],
    });
  });
}

let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  maintenanceAdmission.closeForShutdown();
  try {
    scheduleRunnerInstance?.stop();
    logger.info("Schedule runner stopped");
  } catch (error) {
    logger.error("Schedule runner shutdown failed:", error);
  }

  logger.info(`${signal} received, shutting down gracefully...`);
  try {
    remoteServerEvents.shutdown();
    logger.info("Remote server event hub stopped");
    sseAggregator.shutdown();
    logger.info("SSE Aggregator stopped");
    if (ipcServer) {
      await ipcServer.dispose();
      logger.info("Git IPC server stopped");
    }
    if (openCodeSupervisor) {
      await openCodeSupervisor.stop();
    }
    if (!openCodeSupervisor) {
      await opencodeServerManager.stop();
    }
    logger.info("OpenCode server stopped");
  } catch (error) {
    logger.error("Error during shutdown:", error);
  }
  try {
    await stopSandboxesOnShutdown(db);
    logger.info("Sandbox microVMs stopped");
  } catch (error) {
    logger.error("Error stopping sandbox microVMs:", error);
  }
  try {
    await cliproxyUsageCollector?.stop();
  } catch (error) {
    logger.error("Error stopping CLIProxy usage collector:", error);
  }
  try {
    await messageSearch.stop();
  } catch (error) {
    logger.error("Error stopping message search worker:", error);
  }
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await start({
  port: PORT,
  hostname: HOST,
});

if (ENV.PREVIEW.PORT > 0) {
  const previewGateway = createPreviewGatewayApp(previewSessionStore);
  const disablePreview = (error: unknown): void => {
    previewAvailability.markUnavailable();
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    logger.warn(
      `Preview gateway listener failed on port ${ENV.PREVIEW.PORT}${code ? ` (${code})` : ""}; preview disabled`,
    );
  };
  try {
    await previewGateway.start({
      port: ENV.PREVIEW.PORT,
      hostname: HOST,
      onError: disablePreview,
    });
    previewAvailability.markAvailable();
    logger.info(
      `Preview gateway running on http://${HOST}:${ENV.PREVIEW.PORT}`,
    );
  } catch (error) {
    disablePreview(error);
  }
}

logger.info(`🚀 OpenCode WebUI API running on http://${HOST}:${PORT}`);
