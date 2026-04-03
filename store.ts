/**
 * SQLite 存储层
 *
 * 使用 Node.js 内置的 node:sqlite 模块
 */

import { mkdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ==================== 类型定义 ====================

export interface TraceRecord {
  id?: number;
  timestamp: string;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  agentId?: string;
  channel?: string;
  durationMs?: number;
  status: "pending" | "success" | "error";
  requestJson?: string;
  responseJson?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  errorMessage?: string;
}

export interface TraceFilter {
  page?: number;
  pageSize?: number;
  agentId?: string;
  channel?: string;
  provider?: string;
  model?: string;
  status?: string;
  keyword?: string;
  startDate?: string;
  endDate?: string;
}

export interface TraceListResult {
  traces: TraceRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StatsResult {
  totalTraces: number;
  totalTokens: number;
  totalCost: number;
  totalCacheHitTokens: number;
  dbSizeBytes: number;
  byProvider: StatsItem[];
  byModel: StatsItem[];
  byAgent: StatsItem[];
  byChannel: StatsItem[];
}

export interface StatsItem {
  key: string;
  calls: number;
  tokens: number;
  cacheHitTokens: number;
  cost: number;
  avgDurationMs: number;
}

export interface ToolCallRecord {
  id?: number;
  runId: string;
  toolCallId: string;
  toolName: string;
  params?: string;
  result?: string;
  durationMs?: number;
  timestamp: string;
}

// ==================== 敏感信息脱敏 ====================

const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /bearer/i,
  /secret/i,
  /password/i,
  /credential/i,
  /^token$/i,  // 精确匹配 token，不匹配 totalTokens
];

const API_KEY_PATTERNS = [
  /^sk-[a-zA-Z0-9]{20,}$/,
  /^sk-ant-[a-zA-Z0-9-]{20,}$/,
  /^[a-zA-Z0-9]{32,}$/,
  /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/,
];

export function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 10) return "[MAX_DEPTH]";
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    if (API_KEY_PATTERNS.some(p => p.test(obj))) {
      return "[REDACTED]";
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => redactSensitive(item, depth + 1));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_PATTERNS.some(p => p.test(lowerKey))) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactSensitive(value, depth + 1);
      }
    }
    return result;
  }

  return obj;
}

// ==================== 工具函数 ====================

function expandPath(path: string): string {
  if (path.startsWith("~")) {
    let home = homedir();
    // 如果 homedir() 返回空或根目录，尝试使用环境变量
    if (!home || home === "/" || home === "") {
      home = process.env.HOME || process.env.USERPROFILE || "";
    }
    // 如果还是空的或根目录，使用插件所在目录
    if (!home || home === "/" || home === "") {
      try {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        home = __dirname;
      } catch (e) {
        home = process.cwd();
      }
    }
    return join(home, path.slice(1));
  }
  return path;
}

// ==================== TraceStore 类 ====================

export class TraceStore {
  private db: any = null;
  private dbPath: string;
  private redactEnabled: boolean;
  private initialized: boolean = false;
  private initError: string | null = null;

  constructor(dbPath: string, redactEnabled: boolean = true) {
    this.dbPath = expandPath(dbPath);
    this.redactEnabled = redactEnabled;
    this.initDatabase();
  }

  private initDatabase(): void {
    try {
      // 动态导入 node:sqlite
      const { DatabaseSync } = require("node:sqlite");

      // 同步确保目录存在
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      this.db = new DatabaseSync(this.dbPath);

      // 创建表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS traces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          run_id TEXT,
          session_id TEXT,
          agent_id TEXT,
          channel TEXT,
          duration_ms INTEGER,
          status TEXT NOT NULL,
          request_json TEXT,
          response_json TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_write_tokens INTEGER,
          cost REAL,
          error_message TEXT
        );
      `);

      // 创建索引
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces(timestamp);`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_id);`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_channel ON traces(channel);`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_provider_model ON traces(provider, model);`);

      // 创建工具调用表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tool_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          params TEXT,
          result TEXT,
          duration_ms INTEGER,
          timestamp TEXT NOT NULL
        );
      `);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id ON tool_calls(run_id);`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);`);

      this.initialized = true;
    } catch (err: any) {
      this.initError = err.message;
      console.error("[llm-tracer] Failed to initialize database:", err.message);
    }
  }

  private checkReady(): boolean {
    if (!this.initialized || !this.db) {
      return false;
    }
    return true;
  }

  // ==================== 写入操作 ====================

  /**
   * 保存请求（llm_input 时调用）
   */
  saveRequest(params: {
    runId: string;
    timestamp: string;
    provider: string;
    model: string;
    agentId?: string;
    channel?: string;
    request: unknown;
  }): void {
    if (!this.checkReady()) return;

    try {
      const requestJson = this.redactEnabled
        ? JSON.stringify(redactSensitive(params.request))
        : JSON.stringify(params.request);

      const stmt = this.db.prepare(`
        INSERT INTO traces (
          timestamp, provider, model, run_id, agent_id, channel,
          status, request_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `);

      stmt.run(
        params.timestamp,
        params.provider,
        params.model,
        params.runId,
        params.agentId || null,
        params.channel || null,
        requestJson
      );
    } catch (err) {
      console.error("[llm-tracer] saveRequest error:", err);
    }
  }

  /**
   * 更新响应（llm_output 时调用）
   */
  saveResponse(params: {
    runId: string;
    response?: unknown;
    durationMs?: number;
    status: "success" | "error";
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cost?: number;
    errorMessage?: string;
    sessionId?: string;
  }): void {
    if (!this.checkReady()) return;

    try {
      const responseJson = params.response
        ? (this.redactEnabled
            ? JSON.stringify(redactSensitive(params.response))
            : JSON.stringify(params.response))
        : null;

      const stmt = this.db.prepare(`
        UPDATE traces SET
          response_json = ?,
          duration_ms = ?,
          status = ?,
          input_tokens = ?,
          output_tokens = ?,
          cache_read_tokens = ?,
          cache_write_tokens = ?,
          cost = ?,
          error_message = ?,
          session_id = COALESCE(?, session_id)
        WHERE run_id = ?
      `);

      stmt.run(
        responseJson,
        params.durationMs || null,
        params.status,
        params.inputTokens || null,
        params.outputTokens || null,
        params.cacheReadTokens || null,
        params.cacheWriteTokens || null,
        params.cost || 0,
        params.errorMessage || null,
        params.sessionId || null,
        params.runId
      );
    } catch (err) {
      console.error("[llm-tracer] saveResponse error:", err);
    }
  }

  /**
   * 保存工具调用（after_tool_call 时调用）
   * timestamp 使用 before_tool_call 记录的时间，保证顺序正确
   */
  saveToolCall(params: {
    runId: string;
    toolCallId: string;
    toolName: string;
    params?: unknown;
    result?: unknown;
    durationMs?: number;
    timestamp?: string;  // 来自 before_tool_call 的时间
  }): void {
    if (!this.checkReady()) return;

    try {
      const paramsJson = params.params
        ? (this.redactEnabled
            ? JSON.stringify(redactSensitive(params.params))
            : JSON.stringify(params.params))
        : null;
      const resultJson = params.result
        ? (this.redactEnabled
            ? JSON.stringify(redactSensitive(params.result))
            : JSON.stringify(params.result))
        : null;

      const stmt = this.db.prepare(`
        INSERT INTO tool_calls (
          run_id, tool_call_id, tool_name, params, result, duration_ms, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      // 使用 before_tool_call 记录的时间，或当前时间作为备选
      const timestamp = params.timestamp || new Date().toISOString();

      stmt.run(
        params.runId,
        params.toolCallId,
        params.toolName,
        paramsJson,
        resultJson,
        params.durationMs || null,
        timestamp
      );
    } catch (err) {
      console.error("[llm-tracer] saveToolCall error:", err);
    }
  }

  /**
   * 查询工具调用（按 runId）
   * 使用 id 排序保证顺序正确（SQLite AUTOINCREMENT 保证插入顺序）
   */
  getToolCallsByRunId(runId: string): ToolCallRecord[] {
    if (!this.checkReady()) return [];

    try {
      const stmt = this.db.prepare(`
        SELECT * FROM tool_calls WHERE run_id = ? ORDER BY id ASC
      `);
      const rows = stmt.all(runId) as Record<string, unknown>[];

      return rows.map(row => ({
        id: Number(row.id),
        runId: String(row.run_id),
        toolCallId: String(row.tool_call_id),
        toolName: String(row.tool_name),
        params: row.params ? String(row.params) : undefined,
        result: row.result ? String(row.result) : undefined,
        durationMs: row.duration_ms ? Number(row.duration_ms) : undefined,
        timestamp: String(row.timestamp),
      }));
    } catch (err) {
      console.error("[llm-tracer] getToolCallsByRunId error:", err);
      return [];
    }
  }

  // ==================== 查询操作 ====================

  /**
   * 查询列表
   */
  listTraces(filter: TraceFilter): TraceListResult {
    if (!this.checkReady()) {
      return { traces: [], total: 0, page: filter.page || 1, pageSize: filter.pageSize || 20 };
    }

    try {
      const page = filter.page || 1;
      const pageSize = filter.pageSize || 20;
      const offset = (page - 1) * pageSize;

      // 构建查询条件
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (filter.agentId) {
        conditions.push("agent_id = ?");
        params.push(filter.agentId);
      }
      if (filter.channel) {
        conditions.push("channel = ?");
        params.push(filter.channel);
      }
      if (filter.provider) {
        conditions.push("provider = ?");
        params.push(filter.provider);
      }
      if (filter.model) {
        conditions.push("model = ?");
        params.push(filter.model);
      }
      if (filter.status) {
        conditions.push("status = ?");
        params.push(filter.status);
      }
      if (filter.startDate) {
        conditions.push("timestamp >= ?");
        params.push(filter.startDate);
      }
      if (filter.endDate) {
        conditions.push("timestamp <= ?");
        params.push(filter.endDate);
      }
      if (filter.keyword) {
        conditions.push("(request_json LIKE ? OR response_json LIKE ?)");
        params.push(`%${filter.keyword}%`, `%${filter.keyword}%`);
      }

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

      // 查询总数
      const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM traces ${whereClause}`);
      const countResult = countStmt.get(...params) as { count: number };
      const total = countResult.count;

      // 查询列表
      const listStmt = this.db.prepare(`
        SELECT * FROM traces ${whereClause}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `);
      const rows = listStmt.all(...params, pageSize, offset) as Record<string, unknown>[];

      const traces: TraceRecord[] = rows.map(row => this.rowToRecord(row));

      return { traces, total, page, pageSize };
    } catch (err) {
      console.error("[llm-tracer] listTraces error:", err);
      return { traces: [], total: 0, page: filter.page || 1, pageSize: filter.pageSize || 20 };
    }
  }

  /**
   * 获取详情
   */
  getTraceById(id: number): TraceRecord | null {
    if (!this.checkReady()) return null;

    try {
      const stmt = this.db.prepare("SELECT * FROM traces WHERE id = ?");
      const row = stmt.get(id) as Record<string, unknown> | undefined;
      return row ? this.rowToRecord(row) : null;
    } catch (err) {
      console.error("[llm-tracer] getTraceById error:", err);
      return null;
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): StatsResult {
    if (!this.checkReady()) {
      return {
        totalTraces: 0,
        totalTokens: 0,
        totalCost: 0,
        totalCacheHitTokens: 0,
        dbSizeBytes: 0,
        byProvider: [],
        byModel: [],
        byAgent: [],
        byChannel: [],
      };
    }

    try {
      // 总体统计
      const totalStmt = this.db.prepare(`
        SELECT
          COUNT(*) as totalTraces,
          COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
          COALESCE(SUM(cost), 0) as totalCost,
          COALESCE(SUM(cache_read_tokens), 0) as totalCacheHitTokens
        FROM traces
        WHERE status != 'pending'
      `);
      const totalResult = totalStmt.get() as Record<string, number>;

      // 数据库大小
      let dbSizeBytes = 0;
      try {
        const stats = statSync(this.dbPath);
        dbSizeBytes = stats.size;
      } catch {
        // ignore
      }

      // 按维度统计
      const byProvider = this.getGroupedStats("provider");
      const byModel = this.getGroupedStats("model");
      const byAgent = this.getGroupedStats("agent_id", "agentId");
      const byChannel = this.getGroupedStats("channel");

      return {
        totalTraces: totalResult.totalTraces || 0,
        totalTokens: totalResult.totalTokens || 0,
        totalCost: totalResult.totalCost || 0,
        totalCacheHitTokens: totalResult.totalCacheHitTokens || 0,
        dbSizeBytes,
        byProvider,
        byModel,
        byAgent,
        byChannel,
      };
    } catch (err) {
      console.error("[llm-tracer] getStats error:", err);
      return {
        totalTraces: 0,
        totalTokens: 0,
        totalCost: 0,
        totalCacheHitTokens: 0,
        dbSizeBytes: 0,
        byProvider: [],
        byModel: [],
        byAgent: [],
        byChannel: [],
      };
    }
  }

  private getGroupedStats(field: string, keyName?: string): StatsItem[] {
    try {
      const stmt = this.db.prepare(`
        SELECT
          ${field} as key,
          COUNT(*) as calls,
          COALESCE(SUM(input_tokens + output_tokens), 0) as tokens,
          COALESCE(SUM(cache_read_tokens), 0) as cacheHitTokens,
          COALESCE(SUM(cost), 0) as cost,
          AVG(duration_ms) as avgDurationMs
        FROM traces
        WHERE status != 'pending' AND ${field} IS NOT NULL
        GROUP BY ${field}
        ORDER BY calls DESC
      `);
      const rows = stmt.all() as Record<string, unknown>[];

      return rows.map(row => ({
        key: String(row.key || ""),
        calls: Number(row.calls) || 0,
        tokens: Number(row.tokens) || 0,
        cacheHitTokens: Number(row.cacheHitTokens) || 0,
        cost: Number(row.cost) || 0,
        avgDurationMs: Math.round(Number(row.avgDurationMs) || 0),
      }));
    } catch (err) {
      console.error("[llm-tracer] getGroupedStats error:", err);
      return [];
    }
  }

  // ==================== 清理操作 ====================

  /**
   * 清理数据
   */
  clearTraces(before?: Date): number {
    if (!this.checkReady()) return 0;

    try {
      let traceCount = 0;
      let toolCallCount = 0;

      if (!before) {
        // 清理全部
        const traceStmt = this.db.prepare("DELETE FROM traces");
        const traceResult = traceStmt.run();
        traceCount = traceResult.changes;

        const toolCallStmt = this.db.prepare("DELETE FROM tool_calls");
        const toolCallResult = toolCallStmt.run();
        toolCallCount = toolCallResult.changes;
      } else {
        // 先获取要删除的 runIds
        const runIdsStmt = this.db.prepare("SELECT DISTINCT run_id FROM traces WHERE timestamp < ?");
        const runIds = runIdsStmt.all(before.toISOString()) as { run_id: string }[];

        if (runIds.length > 0) {
          // 删除 tool_calls
          const toolCallStmt = this.db.prepare(`DELETE FROM tool_calls WHERE run_id IN (${runIds.map(() => '?').join(',')})`);
          const toolCallResult = toolCallStmt.run(...runIds.map(r => r.run_id));
          toolCallCount = toolCallResult.changes;

          // 删除 traces
          const traceStmt = this.db.prepare("DELETE FROM traces WHERE timestamp < ?");
          const traceResult = traceStmt.run(before.toISOString());
          traceCount = traceResult.changes;
        }
      }

      return traceCount;
    } catch (err) {
      console.error("[llm-tracer] clearTraces error:", err);
      return 0;
    }
  }

  // ==================== 工具方法 ====================

  private rowToRecord(row: Record<string, unknown>): TraceRecord {
    return {
      id: Number(row.id),
      timestamp: String(row.timestamp),
      provider: String(row.provider),
      model: String(row.model),
      runId: row.run_id ? String(row.run_id) : undefined,
      sessionId: row.session_id ? String(row.session_id) : undefined,
      agentId: row.agent_id ? String(row.agent_id) : undefined,
      channel: row.channel ? String(row.channel) : undefined,
      durationMs: row.duration_ms ? Number(row.duration_ms) : undefined,
      status: row.status as "pending" | "success" | "error",
      requestJson: row.request_json ? String(row.request_json) : undefined,
      responseJson: row.response_json ? String(row.response_json) : undefined,
      inputTokens: row.input_tokens ? Number(row.input_tokens) : undefined,
      outputTokens: row.output_tokens ? Number(row.output_tokens) : undefined,
      cacheReadTokens: row.cache_read_tokens ? Number(row.cache_read_tokens) : undefined,
      cacheWriteTokens: row.cache_write_tokens ? Number(row.cache_write_tokens) : undefined,
      cost: row.cost ? Number(row.cost) : undefined,
      errorMessage: row.error_message ? String(row.error_message) : undefined,
    };
  }

  /**
   * 检查是否初始化成功
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * 获取初始化错误
   */
  getInitError(): string | null {
    return this.initError;
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        console.error("[llm-tracer] close error:", err);
      }
    }
  }
}