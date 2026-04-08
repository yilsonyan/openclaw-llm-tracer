/**
 * HTTP 服务器
 *
 * 提供 API 和 UI 服务
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import type { TraceStore } from "./store.js";

// ==================== 类型定义 ====================

type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export interface UIServer {
  close: () => void;
  port: number;
}

// ==================== 端口清理 ====================

/**
 * 清理占用端口的进程
 * 返回 true 表示端口可用（原本空闲或已成功清理）
 * 返回 false 表示端口仍被占用（其他进程在重启）
 */
function ensurePortAvailable(port: number, logger?: PluginLogger): string | null {
  try {
    // 获取占用端口的 PID
    const pid = execSync(`lsof -t -i :${port} 2>/dev/null`, { encoding: "utf-8" }).trim();
    if (!pid) return null; // 端口空闲

    // 不杀自己
    if (pid === process.pid.toString()) return null;

    // 杀掉进程
    execSync(`kill -9 ${pid} 2>/dev/null`);

    // 等待端口释放（最多 500ms）
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      while (Date.now() - start < 100) {} // 等 100ms
      try {
        execSync(`lsof -t -i :${port} 2>/dev/null`);
        // 还有进程占用，说明有服务在重启
        //logger?.warn?.(`[openclaw-llm-tracer] Port ${port} still in use after kill, another process may be restarting`);
        return null;
      } catch {
        // 端口已释放
        return pid;
      }
    }
    return pid;
  } catch {
    // 端口未被占用
    return null;
  }
}

// ==================== 服务器创建 ====================

export function startUIServer(
  store: TraceStore,
  port: number,
  logger?: PluginLogger
): UIServer | null {
  // 清理占用端口的进程
  const killedPid = ensurePortAvailable(port, logger);

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const uiDir = join(__dirname, "ui");

  const server = createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;

    try {
      // API 路由
      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, pathname, url, store);
        return;
      }

      // 静态文件
      await handleStatic(req, res, pathname, uiDir);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      logger?.error?.(`[openclaw-llm-tracer] Port ${port} is already in use`);
    } else {
      logger?.error?.(`[openclaw-llm-tracer] Server error: ${err.message}`);
    }
  });

  server.listen(port, () => {
    // unref 让服务器不阻止进程退出
    server.unref();
    const msg = killedPid
      ? `UI server started at http://localhost:${port} (killed old process ${killedPid})`
      : `UI server started at http://localhost:${port}`;
    logger?.info?.(`[openclaw-llm-tracer] ${msg}`);
  });

  return {
    close: () => {
      try {
        server.close();
      } catch {}
    },
    port,
  };
}

// ==================== API 处理 ====================

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  store: TraceStore
): Promise<void> {
  res.setHeader("Content-Type", "application/json");

  // GET /api/traces - 列表查询
  if (pathname === "/api/traces" && req.method === "GET") {
    const filter = {
      page: parseInt(url.searchParams.get("page") || "1"),
      pageSize: parseInt(url.searchParams.get("pageSize") || "20"),
      agentId: url.searchParams.get("agentId") || undefined,
      channel: url.searchParams.get("channel") || undefined,
      provider: url.searchParams.get("provider") || undefined,
      model: url.searchParams.get("model") || undefined,
      status: url.searchParams.get("status") || undefined,
      keyword: url.searchParams.get("keyword") || undefined,
      startDate: url.searchParams.get("startDate") || undefined,
      endDate: url.searchParams.get("endDate") || undefined,
    };
    const result = store.listTraces(filter);
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  // GET /api/traces/:id - 获取详情
  const detailMatch = pathname.match(/^\/api\/traces\/(\d+)$/);
  if (detailMatch && req.method === "GET") {
    const id = parseInt(detailMatch[1]);
    const trace = store.getTraceById(id);
    if (trace) {
      // 获取工具调用
      const toolCalls = trace.runId ? store.getToolCallsByRunId(trace.runId) : [];

      // 解析 JSON 字段
      const result = {
        ...trace,
        request: trace.requestJson ? JSON.parse(trace.requestJson) : null,
        response: trace.responseJson ? JSON.parse(trace.responseJson) : null,
        toolCalls: toolCalls.map(tc => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          params: tc.params ? JSON.parse(tc.params) : null,
          result: tc.result ? JSON.parse(tc.result) : null,
          durationMs: tc.durationMs,
          timestamp: tc.timestamp,
        })),
      };
      delete (result as any).requestJson;
      delete (result as any).responseJson;
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
    return;
  }

  // GET /api/stats - 统计信息
  if (pathname === "/api/stats" && req.method === "GET") {
    const stats = store.getStats();
    // 转换格式
    const result = {
      totalTraces: stats.totalTraces,
      totalTokens: stats.totalTokens,
      totalCost: stats.totalCost,
      totalCacheHitTokens: stats.totalCacheHitTokens,
      dbSizeBytes: stats.dbSizeBytes,
      byProvider: stats.byProvider.map(item => ({
        provider: item.key,
        calls: item.calls,
        tokens: item.tokens,
        cacheHitTokens: item.cacheHitTokens,
        cost: item.cost,
        avgDurationMs: item.avgDurationMs,
      })),
      byModel: stats.byModel.map(item => ({
        model: item.key,
        calls: item.calls,
        tokens: item.tokens,
        cacheHitTokens: item.cacheHitTokens,
        cost: item.cost,
        avgDurationMs: item.avgDurationMs,
      })),
      byAgent: stats.byAgent.map(item => ({
        agentId: item.key,
        calls: item.calls,
        tokens: item.tokens,
        cacheHitTokens: item.cacheHitTokens,
        cost: item.cost,
        avgDurationMs: item.avgDurationMs,
      })),
      byChannel: stats.byChannel.map(item => ({
        channel: item.key,
        calls: item.calls,
        tokens: item.tokens,
        cacheHitTokens: item.cacheHitTokens,
        cost: item.cost,
        avgDurationMs: item.avgDurationMs,
      })),
    };
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/clear - 清理数据
  if (pathname === "/api/clear" && req.method === "POST") {
    const body = await readBody(req);
    const params = body ? JSON.parse(body) : {};
    let before: Date | undefined;

    if (params.before === "1d") {
      before = new Date(Date.now() - 24 * 60 * 60 * 1000);
    } else if (params.before === "3d") {
      before = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    } else if (params.before === "all") {
      before = undefined;
    } else {
      before = undefined;
    }

    const deletedCount = store.clearTraces(before);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, deletedCount }));
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}

// ==================== 静态文件处理 ====================

async function handleStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  uiDir: string
): Promise<void> {
  // 默认 index.html
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = join(uiDir, filePath);

  // 检查文件是否存在
  if (!existsSync(filePath)) {
    // 文件不存在，返回 index.html（SPA 支持）
    filePath = join(uiDir, "index.html");
  }

  // 读取文件
  readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end("Internal Server Error");
      return;
    }

    // 设置 Content-Type
    const ext = filePath.split(".").pop()?.toLowerCase();
    const contentTypes: Record<string, string> = {
      html: "text/html; charset=utf-8",
      css: "text/css; charset=utf-8",
      js: "application/javascript; charset=utf-8",
      json: "application/json; charset=utf-8",
      png: "image/png",
      jpg: "image/jpeg",
      svg: "image/svg+xml",
    };
    const contentType = contentTypes[ext || ""] || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.writeHead(200);
    res.end(content);
  });
}

// ==================== 工具函数 ====================

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}