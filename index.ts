/**
 * openclaw-llm-tracer 插件入口
 *
 * 记录 LLM 交互，提供可视化查询界面
 */

// ==================== 类型定义 ====================

type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type HookAgentContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  channelId?: string;
  runId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
};

type OpenClawPluginApi = {
  config?: any;
  pluginConfig?: unknown;
  logger: PluginLogger;
  on: (
    hookName: string,
    handler: (event: unknown, ctx?: HookAgentContext) => unknown,
    opts?: { priority?: number },
  ) => void;
};

interface PluginConfig {
  enabled: boolean;
  uiEnabled: boolean;
  uiPort: number;
  dbPath: string;
  redactSensitive: boolean;
}

interface InFlightRequest {
  timestamp: string;
  provider: string;
  model: string;
  agentId?: string;
  channel?: string;
  startTime: number;
}

// ==================== 插件定义 ====================

const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  uiEnabled: true,
  uiPort: 5500,
  dbPath: "~/.openclaw/extensions/openclaw-llm-tracer/data/traces.db",
  redactSensitive: true,
};

const inFlightRequests = new Map<string, InFlightRequest>();

// 延迟初始化的模块
let store: any = null;
let server: any = null;

const plugin = {
  id: "openclaw-llm-tracer",
  name: "LLM Tracer",
  description: "记录 LLM 交互，提供可视化查询界面",

  register(api: OpenClawPluginApi) {
    const rawConfig = api.config?.plugins?.entries?.["openclaw-llm-tracer"]?.config ?? {};
    const config: PluginConfig = { ...DEFAULT_CONFIG, ...rawConfig };

    if (!config.enabled) {
      api.logger.info("[llm-tracer] Plugin disabled");
      return;
    }

    api.logger.info("[llm-tracer] Plugin registered, initializing async...");

    // 异步初始化，不阻塞
    initAsync(config, api).catch(err => {
      api.logger.error("[llm-tracer] Init failed:", err?.message || err);
    });

    // 注册 llm_input hook
    api.on("llm_input", (event: any, ctx?: HookAgentContext) => {
      if (!store) return;

      try {
        const runId = event.runId;
        if (!runId) return;

        // 从 ctx.channelId 获取 channel
        const channel = ctx?.channelId || extractChannelFromSession(ctx?.sessionKey);

        inFlightRequests.set(runId, {
          timestamp: new Date().toISOString(),
          provider: event.provider ?? "unknown",
          model: event.model ?? "unknown",
          agentId: ctx?.agentId,
          channel,
          startTime: Date.now(),
        });

        store.saveRequest({
          runId,
          timestamp: new Date().toISOString(),
          provider: event.provider ?? "unknown",
          model: event.model ?? "unknown",
          agentId: ctx?.agentId,
          channel,
          request: {
            systemPrompt: event.systemPrompt,
            prompt: event.prompt,
            historyMessages: event.historyMessages,
            imagesCount: event.imagesCount,
          },
        });
      } catch (err) {
        api.logger.error?.("[llm-tracer] llm_input error:", err);
      }
    });

    // 注册 llm_output hook
    api.on("llm_output", (event: any, ctx?: HookAgentContext) => {
      if (!store) return;

      try {
        const runId = event.runId;
        if (!runId) return;

        const requestData = inFlightRequests.get(runId);
        if (!requestData) return;

        inFlightRequests.delete(runId);

        const durationMs = Date.now() - requestData.startTime;
        const status = event.error ? "error" : "success";

        // 从 event.usage 获取 token 信息
        const usage = event.usage || {};
        const lastAssistantUsage = event.lastAssistant?.usage || {};

        // token 字段名是 input/output/cacheRead
        const inputTokens = usage.input || lastAssistantUsage.input;
        const outputTokens = usage.output || lastAssistantUsage.output;
        const cacheReadTokens = usage.cacheRead || lastAssistantUsage.cacheRead;
        const cacheWriteTokens = usage.cacheWrite || lastAssistantUsage.cacheWrite;

        // cost 在 lastAssistant.usage.cost.total 中
        const cost = lastAssistantUsage.cost?.total || 0;

        store.saveResponse({
          runId,
          response: {
            assistantTexts: event.assistantTexts,
            lastAssistant: event.lastAssistant,
            usage: event.usage,
          },
          durationMs,
          status,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          cost,
          errorMessage: event.error,
          sessionId: ctx?.sessionId || event.sessionId,
        });
      } catch (err) {
        api.logger.error?.("[llm-tracer] llm_output error:", err);
      }
    });
  },
};

// ==================== 异步初始化 ====================

async function initAsync(config: PluginConfig, api: OpenClawPluginApi) {
  try {
    // 动态导入模块
    const { TraceStore } = await import("./store.js");

    store = new TraceStore(config.dbPath, config.redactSensitive);

    if (!store.isReady()) {
      api.logger.error("[llm-tracer] Store init failed:", store.getInitError());
      store = null;
      return;
    }

    api.logger.info("[llm-tracer] Store ready");

    // 启动 UI 服务器
    if (config.uiEnabled) {
      try {
        const { startUIServer } = await import("./server.js");
        server = startUIServer(store, config.uiPort, api.logger);
        if (server) {
          api.logger.info(`[llm-tracer] UI available at http://localhost:${config.uiPort}`);
        }
      } catch (err: any) {
        api.logger.error("[llm-tracer] UI server error:", err?.message || err);
      }
    }
  } catch (err: any) {
    api.logger.error("[llm-tracer] Init error:", err?.message || err);
  }
}

// ==================== 工具函数 ====================

function extractChannelFromSession(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  // sessionKey 格式: "agent:lubanqihao:dingtalk-connector:direct:256954"
  // channel 在第三个位置
  const parts = sessionKey.split(":");
  if (parts.length > 2) {
    return parts[2].toLowerCase();
  }
  return undefined;
}

// ==================== 导出 ====================

export default plugin;