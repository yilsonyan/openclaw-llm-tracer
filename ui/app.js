/**
 * LLM Tracer 前端交互逻辑
 */

// ==================== 状态管理 ====================

const state = {
  currentView: 'list',
  page: 1,
  pageSize: 10,
  total: 0,
  filters: {},
  stats: null,
};

// ==================== API 调用 ====================

async function fetchAPI(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }
  return response.json();
}

// ==================== 工具函数 ====================

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatNumber(num) {
  if (num === null || num === undefined) return '--';
  return num.toLocaleString();
}

function formatCost(cost) {
  if (cost === null || cost === undefined) return '--';
  if (cost === 0) return '0';
  // 超过8位小数显示≈0
  if (cost < 0.00000001) {
    return '≈0';
  }
  return cost.toFixed(8).replace(/\.?0+$/, '');  // 去掉末尾的0
}

function formatDuration(ms) {
  if (!ms) return '--';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatFullTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN');
}

/**
 * 格式化精确时间（到毫秒）
 */
function formatPreciseTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const timeStr = date.toLocaleString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${timeStr}.${ms}`;
}

function parseTimeFilter(filter) {
  if (!filter) return { startDate: undefined, endDate: undefined };

  const now = new Date();
  let startDate;

  const unit = filter.slice(-1);
  const value = parseInt(filter.slice(0, -1));

  switch (unit) {
    case 's':
      startDate = new Date(now.getTime() - value * 1000);
      break;
    case 'm':
      startDate = new Date(now.getTime() - value * 60 * 1000);
      break;
    case 'h':
      startDate = new Date(now.getTime() - value * 60 * 60 * 1000);
      break;
    case 'd':
      startDate = new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
      break;
    case 'M':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
  }

  return {
    startDate: startDate ? startDate.toISOString() : undefined,
    endDate: undefined
  };
}

// ==================== 列表视图 ====================

async function loadTraces() {
  const params = new URLSearchParams();

  params.set('page', state.page);
  params.set('pageSize', state.pageSize);

  // 只添加有值的筛选参数
  for (const [key, value] of Object.entries(state.filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, value);
    }
  }

  const result = await fetchAPI(`/traces?${params}`);
  state.total = result.total;

  renderTraceList(result.traces);
  renderPagination();
}

function renderTraceList(traces) {
  const tbody = document.getElementById('traceList');

  if (traces.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无数据</td></tr>';
    return;
  }

  tbody.innerHTML = traces.map(trace => {
    // Token 信息
    const input = trace.inputTokens || 0;
    const output = trace.outputTokens || 0;
    const total = input + output;

    // 提取用户提示词
    let promptPreview = '--';
    if (trace.requestJson) {
      try {
        const request = JSON.parse(trace.requestJson);
        if (request.prompt) {
          const { display } = extractUserMessage(request.prompt);
          if (display) {
            promptPreview = display.length > 12 ? display.substring(0, 12) + '...' : display;
          }
        }
      } catch (e) {}
    }

    // 状态文本
    const statusText = trace.status === 'success' ? '成功' : trace.status === 'error' ? '失败' : '进行中';

    return `
    <tr data-id="${trace.id}">
      <td>${formatTime(trace.timestamp)}</td>
      <td>${trace.agentId || '--'}</td>
      <td>${trace.model}</td>
      <td><span class="status status-${trace.status}">${statusText}</span></td>
      <td>${formatNumber(total)}</td>
      <td>${formatCost(trace.cost)}</td>
      <td title="${promptPreview === '--' ? '' : promptPreview}">${promptPreview}</td>
    </tr>
  `}).join('');

  // 绑定点击事件
  tbody.querySelectorAll('tr[data-id]').forEach(row => {
    row.addEventListener('click', () => showDetail(row.dataset.id));
  });
}

function renderPagination() {
  const totalPages = Math.ceil(state.total / state.pageSize) || 1;
  document.getElementById('pageInfo').textContent = `第 ${state.page} 页 / 共 ${totalPages} 页`;
  document.getElementById('prevPage').disabled = state.page <= 1;
  document.getElementById('nextPage').disabled = state.page >= totalPages;
}

// ==================== 详情视图 ====================

async function showDetail(id) {
  const trace = await fetchAPI(`/traces/${id}`);

  // 构建基本信息 + Usage 合一的标题栏（两行布局）
  const usage = trace.response?.usage || {};
  const lastAssistantUsage = trace.response?.lastAssistant?.usage || {};
  const input = usage.input || lastAssistantUsage.input || trace.inputTokens || 0;
  const output = usage.output || lastAssistantUsage.output || trace.outputTokens || 0;
  const cacheRead = usage.cacheRead || lastAssistantUsage.cacheRead || trace.cacheReadTokens || 0;
  const cacheWrite = lastAssistantUsage.cacheWrite || trace.cacheWriteTokens || 0;
  const costInfo = lastAssistantUsage.cost || {};
  const costTotal = costInfo.total || trace.cost || 0;

  document.getElementById('detailTitle').innerHTML = `
    <div class="detail-header-rows">
      <div class="detail-header-row">
        <div class="detail-header-card">
          <span class="card-label">🕐 时间</span>
          <span class="card-value">${formatFullTime(trace.timestamp)}</span>
        </div>
        <div class="detail-header-card">
          <span class="card-label">🔗 会话ID</span>
          <span class="card-value truncate" title="${trace.sessionId || '--'}">${trace.sessionId || '--'}</span>
        </div>
        <div class="detail-header-card">
          <span class="card-label">📡 渠道</span>
          <span class="card-value">${trace.channel || '--'}</span>
        </div>
        <div class="detail-header-card">
          <span class="card-label">⏱️ 耗时</span>
          <span class="card-value">${formatDuration(trace.durationMs)}</span>
        </div>
      </div>
      <div class="detail-header-row">
        <div class="detail-header-card">
          <span class="card-label">⬇️ 输入Token</span>
          <span class="card-value">${formatNumber(input)}</span>
        </div>
        <div class="detail-header-card">
          <span class="card-label">⬆️ 输出Token</span>
          <span class="card-value">${formatNumber(output)}</span>
        </div>
        <div class="detail-header-card">
          <span class="card-label">⚡ 缓存命中</span>
          <span class="card-value">${formatNumber(cacheRead)}</span>
        </div>
        <div class="detail-header-card">
          <span class="card-label">💰 成本</span>
          <span class="card-value">${formatCost(costTotal)}</span>
        </div>
      </div>
    </div>
  `;
  document.getElementById('detailMeta').style.display = 'none';

  // 构建详情内容（三栏竖向并列：系统提示词、历史消息、模型交互过程）
  let html = '';

  // 系统提示词（默认折叠）
  html += formatSystemPromptBlock(trace.request);

  // 历史消息（默认折叠）
  html += formatHistoryBlock(trace.request);

  // 模型交互过程（默认展开）
  const responseEndTime = trace.timestamp && trace.durationMs
    ? new Date(new Date(trace.timestamp).getTime() + trace.durationMs).toISOString()
    : null;
  html += formatInteractionBlock(trace.request, trace.timestamp, trace.response, trace.toolCalls, responseEndTime, trace.errorMessage);

  document.getElementById('detailBody').innerHTML = html;

  // 绑定请求区块的折叠事件
  document.querySelectorAll('.request-section-header').forEach(header => {
    header.addEventListener('click', () => {
      const content = header.nextElementSibling;
      const toggle = header.querySelector('.section-toggle');
      if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        toggle.textContent = '收起';
      } else {
        content.classList.add('collapsed');
        toggle.textContent = '展开';
      }
    });
  });

  // 绑定可折叠区块的折叠事件
  document.querySelectorAll('.collapsible-block .detail-block-header').forEach(header => {
    header.addEventListener('click', () => {
      const content = header.nextElementSibling;
      const toggle = header.querySelector('.block-toggle');
      if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        toggle.textContent = '收起';
      } else {
        content.classList.add('collapsed');
        toggle.textContent = '展开';
      }
    });
  });

  // 绑定原始按钮点击事件
  document.querySelectorAll('.raw-hint').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tooltip = btn.closest('.chat-bubble').querySelector('.raw-tooltip');
      if (tooltip) {
        tooltip.classList.add('active');
      }
    });
  });

  // 绑定tooltip关闭按钮
  document.querySelectorAll('.raw-tooltip-close').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.raw-tooltip').classList.remove('active');
    });
  });

  // 绑定聊天内容展开/收起按钮
  document.querySelectorAll('.chat-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const content = btn.parentElement.nextElementSibling;
      if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        btn.textContent = '收起';
      } else {
        content.classList.add('collapsed');
        btn.textContent = '展开';
      }
    });
  });
  document.getElementById('detailModal').classList.add('active');
}

// 提取用户提示词中的实际消息（去掉metadata部分）
function extractUserMessage(prompt) {
  if (!prompt) return { display: '', original: '' };

  // 匹配 "Sender (untrusted metadata):" 后面的 JSON 块结束位置
  // 格式: Sender (untrusted metadata):\n```json\n{...}\n```\n\n实际消息
  const senderMatch = prompt.match(/Sender \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*/);

  if (senderMatch) {
    // 找到 Sender metadata 结束位置，取后面的内容
    const endIndex = senderMatch.index + senderMatch[0].length;
    const actualMessage = prompt.substring(endIndex).trim();
    return { display: actualMessage, original: prompt };
  }

  // 没有匹配到 metadata，直接返回原文
  return { display: prompt, original: prompt };
}

/**
 * 格式化历史消息，支持多种内容类型
 */
function formatHistoryMessage(msg) {
  const role = msg.role;
  let roleClass, roleIcon;

  // 根据角色设置样式
  if (role === 'user') {
    roleClass = 'user';
    roleIcon = '👤 User';
  } else if (role === 'toolResult') {
    roleClass = 'tool-result';
    roleIcon = '📤 工具结果';
  } else {
    roleClass = 'assistant';
    roleIcon = '🤖 Assistant';
  }

  // 原始内容JSON
  const rawContent = JSON.stringify(msg, null, 2);

  // 时间分隔线（跳过 session bootstrap 等特殊消息）
  let timeDividerHtml = '';
  const contentStr = typeof msg.content === 'string' ? msg.content : '';
  const isBootstrap = contentStr === '(session bootstrap)' || contentStr.startsWith('(session bootstrap)');
  if (msg.timestamp && !isBootstrap) {
    timeDividerHtml = `<div class="chat-time-divider">${formatPreciseTime(msg.timestamp)}</div>`;
  }

  // content 可能是字符串或数组
  let contentHtml = '';

  if (typeof msg.content === 'string') {
    // 用户消息需要提取实际内容（去掉metadata）
    if (role === 'user') {
      const { display } = extractUserMessage(msg.content);
      contentHtml = formatMessageContent('text', display);
    } else if (role === 'toolResult') {
      // 工具结果
      contentHtml = formatMessageContent('tool_result', { content: msg.content, is_error: false });
    } else {
      contentHtml = formatMessageContent('text', msg.content);
    }
  } else if (Array.isArray(msg.content)) {
    // 数组形式的内容块
    msg.content.forEach(block => {
      // 用户消息的 text 类型需要提取实际内容
      if (role === 'user' && block.type === 'text') {
        const text = block.text || block.content || '';
        const { display } = extractUserMessage(text);
        contentHtml += formatMessageContent('text', display);
      } else {
        contentHtml += formatMessageContent(block.type, block);
      }
    });
  } else if (msg.content) {
    // 对象形式，尝试解析
    contentHtml = formatMessageContent('json', msg.content);
  } else {
    contentHtml = '<div class="chat-empty">空内容</div>';
  }

  return `${timeDividerHtml}<div class="chat-message chat-${roleClass}"><div class="chat-bubble"><div class="chat-header"><span class="chat-role">${roleIcon}</span><span class="raw-hint">{raw}</span></div><div class="chat-content">${contentHtml}</div><div class="raw-tooltip"><span class="raw-tooltip-close">&times;</span><div class="raw-tooltip-content"><pre>${escapeHtml(rawContent)}</pre></div></div></div></div>`;
}

/**
 * 根据类型格式化消息内容块
 */
function formatMessageContent(type, data) {
  switch (type) {
    case 'text':
      return `<div class="content-text">${escapeHtml(typeof data === 'string' ? data : data.text || '')}</div>`;

    case 'image':
      const imgSrc = data.source?.url || data.source?.base64
        ? (data.source.base64 ? `data:${data.source.media_type || 'image/png'};base64,${data.source.base64}` : data.source.url)
        : null;
      if (imgSrc) {
        return `<div class="content-image"><img src="${imgSrc}" alt="图片" style="max-width: 200px; max-height: 150px; border-radius: 6px; cursor: pointer;" onclick="window.open(this.src, '_blank')"></div>`;
      }
      return `<div class="content-image">🖼️ [图片]</div>`;

    case 'tool_use':
    case 'toolCall':
      // tool_use 和 toolCall 都处理为工具调用
      return `<div class="content-tool-use"><div class="tool-header">🔧 工具调用: <code>${data.name || 'unknown'}</code></div><div class="tool-params">${escapeHtml(JSON.stringify(data.input || data.arguments || {}, null, 2))}</div></div>`;

    case 'tool_result':
      const isError = data.is_error;
      return `<div class="content-tool-result ${isError ? 'error' : ''}"><div class="tool-header">${isError ? '❌' : '✅'} 工具结果 ${data.tool_use_id ? `<code class="tool-id">${data.tool_use_id.slice(0, 8)}</code>` : ''}</div><div class="tool-output">${escapeHtml(typeof data.content === 'string' ? data.content : JSON.stringify(data.content, null, 2))}</div></div>`;

    case 'thinking':
      return `<div class="content-thinking"><div class="thinking-header">💭 思考过程</div><div class="thinking-content">${escapeHtml(data.thinking || data.text || '')}</div></div>`;

    default:
      // 未知类型，JSON展示
      return `<div class="content-json"><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></div>`;
  }
}

/**
 * 格式化系统提示词区块（默认折叠）
 */
function formatSystemPromptBlock(request) {
  if (!request || !request.systemPrompt) return '';

  return `
    <div class="detail-block collapsible-block">
      <div class="detail-block-header">
        <span>🤖 系统提示词</span>
        <span class="block-toggle">展开</span>
      </div>
      <div class="detail-block-content collapsed">
        ${createChatMessage('system', '🤖 System', request.systemPrompt, { maxLines: Infinity, maxChars: Infinity })}
      </div>
    </div>
  `;
}

/**
 * 格式化历史消息区块（默认折叠）
 */
function formatHistoryBlock(request) {
  if (!request || !request.historyMessages || request.historyMessages.length === 0) return '';

  let historyHtml = '';
  request.historyMessages.forEach(msg => {
    historyHtml += formatHistoryMessage(msg);
  });

  return `
    <div class="detail-block collapsible-block">
      <div class="detail-block-header">
        <span>📖 历史消息集 <span class="block-count">(${request.historyMessages.length}条)</span></span>
        <span class="block-toggle">展开</span>
      </div>
      <div class="detail-block-content collapsed">
        ${historyHtml}
      </div>
    </div>
  `;
}

/**
 * 格式化模型交互过程区块（用户提示词 + 响应内容合并，默认展开）
 */
function formatInteractionBlock(request, timestamp, response, toolCalls, endTime, errorMessage) {
  let contentHtml = '';

  // 用户提示词
  if (request && request.prompt) {
    const { display, original } = extractUserMessage(request.prompt);
    const timeHtml = timestamp ? `<div class="chat-time-divider">${formatPreciseTime(timestamp)}</div>` : '';
    contentHtml += `${timeHtml}${createChatMessage('user', '👤 User', display, { rawContent: original, maxLines: 20, maxChars: 5000 })}`;
  }

  // 响应内容
  contentHtml += formatResponse(response, toolCalls, endTime);

  // 错误信息（如果有）
  if (errorMessage) {
    contentHtml += `<div class="response-error"><span class="error-icon">❌</span> ${escapeHtml(errorMessage)}</div>`;
  }

  return `
    <div class="detail-block collapsible-block">
      <div class="detail-block-header">
        <span>💬 交互全过程</span>
        <span class="block-toggle">收起</span>
      </div>
      <div class="detail-block-content">
        ${contentHtml || '<div class="chat-empty">暂无交互内容</div>'}
      </div>
    </div>
  `;
}

function formatRequest(request, timestamp) {
  if (!request) return '<div class="chat-empty">暂无请求内容</div>';

  let html = '';

  // 系统提示词区块（默认折叠，无时间）
  if (request.systemPrompt) {
    html += `
      <div class="request-section">
        <div class="request-section-header">
          <span>🤖 系统提示词</span>
          <span class="section-toggle">展开</span>
        </div>
        <div class="request-section-content collapsed">
          ${createChatMessage('system', '🤖 System', request.systemPrompt, { maxLines: Infinity, maxChars: Infinity })}
        </div>
      </div>
    `;
  }

  // 历史消息区块（默认折叠，无时间）
  if (request.historyMessages && request.historyMessages.length > 0) {
    let historyHtml = '';
    request.historyMessages.forEach(msg => {
      historyHtml += formatHistoryMessage(msg);
    });

    html += `
      <div class="request-section">
        <div class="request-section-header">
          <span>📜 历史消息 (${request.historyMessages.length}条)</span>
          <span class="section-toggle">展开</span>
        </div>
        <div class="request-section-content collapsed">
          ${historyHtml}
        </div>
      </div>
    `;
  }

  // 用户提示词区块（默认展开，有时间）
  if (request.prompt) {
    const { display, original } = extractUserMessage(request.prompt);
    const timeHtml = timestamp ? `<div class="chat-time-divider">${formatPreciseTime(timestamp)}</div>` : '';

    html += `
      <div class="request-section">
        <div class="request-section-header">
          <span>👤 用户提示词</span>
          <span class="section-toggle">收起</span>
        </div>
        <div class="request-section-content">
          ${timeHtml}
          ${createChatMessage('user', '👤 User', display, { rawContent: original })}
        </div>
      </div>
    `;
  }

  return html || '<div class="chat-empty">暂无请求内容</div>';
}

function formatResponse(response, toolCalls, endTime) {
  if (!response) return '<div class="chat-empty">暂无响应内容</div>';

  let html = '';

  // 如果有 toolCalls（从数据库查询），展示工具调用
  if (toolCalls && toolCalls.length > 0) {
    toolCalls.forEach((tool, index) => {
      html += formatToolCallFromHook(tool, index + 1);
    });
  }
  // 兼容旧数据：如果 toolCalls 在 response 内部
  else if (response.toolCalls && response.toolCalls.length > 0) {
    response.toolCalls.forEach((tool, index) => {
      html += formatToolCallFromHook(tool, index + 1);
    });
  }

  // 如果有 allAssistantMessages（包含所有中间轮次），展示它们
  if (response.allAssistantMessages && response.allAssistantMessages.length > 0) {
    // 收集所有内容块
    let contentBlocks = [];
    response.allAssistantMessages.forEach((msg, index) => {
      const content = msg.content;
      if (Array.isArray(content)) {
        content.forEach((item, itemIndex) => {
          contentBlocks.push({ item, msgIndex: index, total: response.allAssistantMessages.length });
        });
      }
    });

    // 在一个气泡内展示所有内容
    if (contentBlocks.length > 0) {
      let innerHtml = '';
      contentBlocks.forEach((block, i) => {
        const item = block.item;
        const type = item.type;
        if (type === 'thinking' && item.thinking) {
          innerHtml += `<div class="content-thinking"><div class="thinking-header">💭 思考过程</div><div class="thinking-content">${escapeHtml(item.thinking)}</div></div>`;
        } else if (type === 'text' && item.text) {
          innerHtml += `<div class="content-text">${escapeHtml(item.text)}</div>`;
        } else if (type === 'tool_use' || type === 'toolCall') {
          innerHtml += formatToolUseContent(item);
        } else if (type) {
          const contentText = item[type] || item.content || JSON.stringify(item, null, 2);
          innerHtml += `<div class="content-json"><pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre></div>`;
        }
      });

      // 原始数据
      const rawContent = JSON.stringify(response.allAssistantMessages, null, 2);

      // 时间分隔线
      if (endTime) {
        html += `<div class="chat-time-divider">${formatPreciseTime(endTime)}</div>`;
      }
      // 用一个气泡包裹
      html += `<div class="chat-message chat-assistant"><div class="chat-bubble"><div class="chat-header"><span class="chat-role">🤖 Assistant</span><span class="raw-hint">{raw}</span></div><div class="chat-content">${innerHtml}</div><div class="raw-tooltip"><span class="raw-tooltip-close">&times;</span><div class="raw-tooltip-content"><pre>${escapeHtml(rawContent)}</pre></div></div></div></div>`;
    }
  }
  // 否则处理 lastAssistant.content（兼容旧数据）
  else if (response.lastAssistant?.content && Array.isArray(response.lastAssistant.content)) {
    let innerHtml = '';
    response.lastAssistant.content.forEach((item, index) => {
      const type = item.type;
      if (type === 'thinking' && item.thinking) {
        innerHtml += `<div class="content-thinking"><div class="thinking-header">💭 思考过程</div><div class="thinking-content">${escapeHtml(item.thinking)}</div></div>`;
      } else if (type === 'text' && item.text) {
        innerHtml += `<div class="content-text">${escapeHtml(item.text)}</div>`;
      } else if (type === 'tool_use' || type === 'toolCall') {
        innerHtml += formatToolUseContent(item);
      } else if (type) {
        const contentText = item[type] || item.content || JSON.stringify(item, null, 2);
        innerHtml += `<div class="content-json"><pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre></div>`;
      }
    });

    // 原始数据
    const rawContent = JSON.stringify(response.lastAssistant, null, 2);

    if (endTime) {
      html += `<div class="chat-time-divider">${formatPreciseTime(endTime)}</div>`;
    }
    html += `<div class="chat-message chat-assistant"><div class="chat-bubble"><div class="chat-header"><span class="chat-role">🤖 Assistant</span><span class="raw-hint">{raw}</span></div><div class="chat-content">${innerHtml}</div><div class="raw-tooltip"><span class="raw-tooltip-close">&times;</span><div class="raw-tooltip-content"><pre>${escapeHtml(rawContent)}</pre></div></div></div></div>`;
  }
  // 如果没有 lastAssistant.content，处理 assistantTexts
  else if (response.assistantTexts && response.assistantTexts.length > 0) {
    let innerHtml = '';
    response.assistantTexts.forEach(text => {
      innerHtml += `<div class="content-text">${escapeHtml(text)}</div>`;
    });
    // 原始数据
    const rawContent = JSON.stringify(response.assistantTexts, null, 2);

    if (endTime) {
      html += `<div class="chat-time-divider">${formatPreciseTime(endTime)}</div>`;
    }
    html += `<div class="chat-message chat-assistant"><div class="chat-bubble"><div class="chat-header"><span class="chat-role">🤖 Assistant</span><span class="raw-hint">{raw}</span></div><div class="chat-content">${innerHtml}</div><div class="raw-tooltip"><span class="raw-tooltip-close">&times;</span><div class="raw-tooltip-content"><pre>${escapeHtml(rawContent)}</pre></div></div></div></div>`;
  }
  // 兜底处理
  else if (response.lastAssistant) {
    const content = typeof response.lastAssistant === 'string'
      ? response.lastAssistant
      : JSON.stringify(response.lastAssistant, null, 2);
    // 原始数据
    const rawContent = JSON.stringify(response.lastAssistant, null, 2);

    if (endTime) {
      html += `<div class="chat-time-divider">${formatPreciseTime(endTime)}</div>`;
    }
    html += `<div class="chat-message chat-assistant"><div class="chat-bubble"><div class="chat-header"><span class="chat-role">🤖 Assistant</span><span class="raw-hint">{raw}</span></div><div class="chat-content"><div class="content-text">${escapeHtml(content)}</div></div><div class="raw-tooltip"><span class="raw-tooltip-close">&times;</span><div class="raw-tooltip-content"><pre>${escapeHtml(rawContent)}</pre></div></div></div></div>`;
  }

  return html || '<div class="chat-empty">暂无响应内容</div>';
}

/**
 * 格式化工具调用内容块（用于气泡内部）
 */
function formatToolUseContent(tool) {
  const name = tool.name || 'unknown';
  const input = tool.input || tool.arguments || {};
  const toolId = tool.id || '';

  return `<div class="content-tool-use"><div class="tool-header">调用: <code>${name}</code>${toolId ? `<code class="tool-id">${toolId.slice(0, 8)}</code>` : ''}</div><div class="tool-params">${escapeHtml(JSON.stringify(input, null, 2))}</div></div>`;
}

/**
 * 格式化从 hook 捕获的工具调用
 */
function formatToolCallFromHook(tool, turnNumber) {
  const name = tool.toolName || 'unknown';
  const params = tool.params || {};
  const result = tool.result || {};
  const durationMs = tool.durationMs;
  const timestamp = tool.timestamp;

  // 提取结果文本
  let resultText = '';
  if (result.content && Array.isArray(result.content)) {
    resultText = result.content.map(c => c.text || JSON.stringify(c)).join('\n');
  } else if (result.details?.aggregated) {
    resultText = result.details.aggregated;
  }

  // 时间分隔线（居中显示）
  let timeDividerHtml = '';
  if (timestamp) {
    timeDividerHtml = `<div class="chat-time-divider">${formatPreciseTime(timestamp)}</div>`;
  }

  // 格式化耗时（中文），显示在标题后面
  let durationLabel = '';
  if (durationMs) {
    if (durationMs < 1000) {
      durationLabel = ` <span class="tool-duration">(耗时 ${durationMs}ms)</span>`;
    } else {
      durationLabel = ` <span class="tool-duration">(耗时 ${(durationMs / 1000).toFixed(1)}s)</span>`;
    }
  }

  // 工具调用参数区块（蓝色）
  const toolUseBlock = `<div class="content-tool-use"><div class="tool-header">调用: <code>${name}</code></div><div class="tool-params">${escapeHtml(JSON.stringify(params, null, 2))}</div></div>`;

  // 执行结果区块（绿色）
  const resultBlock = resultText ? `<div class="content-tool-result"><div class="tool-header">✅ 执行结果</div><div class="tool-output">${escapeHtml(resultText.substring(0, 2000))}${resultText.length > 2000 ? '...' : ''}</div></div>` : '';

  return `${timeDividerHtml}<div class="chat-message chat-tool-use"><div class="chat-bubble"><div class="chat-header"><span class="chat-role">🔧 工具调用 #${turnNumber}${durationLabel}</span><span class="raw-hint">{raw}</span></div><div class="chat-content">${toolUseBlock}${resultBlock}</div><div class="raw-tooltip"><span class="raw-tooltip-close">&times;</span><div class="raw-tooltip-content"><pre>${escapeHtml(JSON.stringify(tool, null, 2))}</pre></div></div></div></div>`;
}

function createChatMessage(type, role, content, options = {}) {
  // 确保 content 是字符串
  const text = content ? String(content) : '';

  // 折叠阈值：默认5行/500字符，可自定义
  const maxLines = options.maxLines ?? 5;
  const maxChars = options.maxChars ?? 500;

  // 计算行数（按换行符分割）
  const lines = text ? text.split('\n').length : 0;
  // 判断是否需要折叠
  const shouldCollapse = lines > maxLines || text.length > maxChars;
  const collapsedClass = shouldCollapse ? 'collapsed' : '';

  // 原始内容（如果和展示内容相同则不显示按钮）
  const rawContent = options.rawContent;
  const showRaw = rawContent && rawContent !== text;

  return `
    <div class="chat-message chat-${type}">
      <div class="chat-bubble">
        <div class="chat-header">
          <span class="chat-role">${role}</span>
          ${shouldCollapse ? '<span class="chat-toggle">展开</span>' : ''}
          ${showRaw ? '<span class="raw-hint">{raw}</span>' : ''}
        </div>
        <div class="chat-content ${collapsedClass}">${escapeHtml(text)}</div>
        ${showRaw ? `<div class="raw-tooltip"><span class="raw-tooltip-close">&times;</span><div class="raw-tooltip-content"><pre>${escapeHtml(rawContent)}</pre></div></div>` : ''}
      </div>
    </div>
  `;
}


function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

function escapeAttr(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==================== 统计视图 ====================

async function loadStats() {
  const stats = await fetchAPI('/stats');
  state.stats = stats;

  // 更新头部信息
  document.getElementById('dbSize').textContent = formatBytes(stats.dbSizeBytes);

  // 更新总览卡片
  document.getElementById('totalTraces').textContent = formatNumber(stats.totalTraces);
  document.getElementById('totalTokens').textContent = formatNumber(stats.totalTokens);
  document.getElementById('totalCost').textContent = formatCost(stats.totalCost);
  document.getElementById('totalCacheHit').textContent = formatNumber(stats.totalCacheHitTokens);

  // 更新各维度统计
  renderStatsTable('statsProvider', stats.byProvider, 'provider');
  renderStatsTable('statsModel', stats.byModel, 'model');
  renderStatsTable('statsAgent', stats.byAgent, 'agentId');
  renderStatsTable('statsChannel', stats.byChannel, 'channel');

  // 更新筛选下拉框选项
  updateFilterOptions(stats);
}

function renderStatsTable(containerId, items, keyField) {
  const tbody = document.getElementById(containerId);

  if (!items || items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无数据</td></tr>';
    return;
  }

  tbody.innerHTML = items.map(item => `
    <tr>
      <td>${item[keyField] || '--'}</td>
      <td>${formatNumber(item.calls)}</td>
      <td>${formatNumber(item.tokens)}</td>
      <td>${formatNumber(item.cacheHitTokens)}</td>
      <td>${formatCost(item.cost)}</td>
      <td>${formatDuration(item.avgDurationMs)}</td>
    </tr>
  `).join('');
}

function updateFilterOptions(stats) {
  // Agent 选项
  const agentSelect = document.getElementById('filterAgent');
  const existingAgents = new Set([...agentSelect.options].map(o => o.value));
  stats.byAgent.forEach(item => {
    if (item.agentId && !existingAgents.has(item.agentId)) {
      const option = document.createElement('option');
      option.value = item.agentId;
      option.textContent = item.agentId;
      agentSelect.appendChild(option);
      existingAgents.add(item.agentId);
    }
  });

  // Model 选项
  const modelSelect = document.getElementById('filterModel');
  const existingModels = new Set([...modelSelect.options].map(o => o.value));
  stats.byModel.forEach(item => {
    if (item.model && !existingModels.has(item.model)) {
      const option = document.createElement('option');
      option.value = item.model;
      option.textContent = item.model;
      modelSelect.appendChild(option);
      existingModels.add(item.model);
    }
  });
}

// ==================== 数据清理 ====================

async function clearTraces(before) {
  const confirmed = confirm(
    before === 'all'
      ? '确定要清理全部数据吗？此操作不可恢复。'
      : `确定要清理 ${before === '1d' ? '1天前' : '3天前'} 的数据吗？`
  );

  if (!confirmed) return;

  const result = await fetchAPI('/clear', {
    method: 'POST',
    body: JSON.stringify({ before }),
  });

  if (result.success) {
    alert(`已清理 ${result.deletedCount} 条记录`);
    loadTraces();
    loadStats();
  }
}

// ==================== 事件绑定 ====================

function initEvents() {
  // 视图切换
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      state.currentView = view;

      // 更新按钮状态
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // 切换视图
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById(`${view}View`).classList.add('active');

      // 加载数据
      if (view === 'stats') {
        loadStats();
      } else {
        loadTraces();
      }
    });
  });

  // 搜索函数
  function doSearch() {
    state.page = 1;
    const timeFilter = document.getElementById('filterTime').value;
    const { startDate, endDate } = parseTimeFilter(timeFilter);

    state.filters = {
      keyword: document.getElementById('keyword').value,
      agentId: document.getElementById('filterAgent').value,
      model: document.getElementById('filterModel').value,
      status: document.getElementById('filterStatus').value,
      startDate,
      endDate,
    };
    loadTraces();
  }

  // 搜索按钮点击
  document.getElementById('searchBtn').addEventListener('click', doSearch);

  // 下拉框改变时自动搜索
  ['filterTime', 'filterAgent', 'filterModel', 'filterStatus'].forEach(id => {
    document.getElementById(id).addEventListener('change', doSearch);
  });

  // 搜索框回车时搜索
  document.getElementById('keyword').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      doSearch();
    }
  });

  // 分页
  document.getElementById('prevPage').addEventListener('click', () => {
    if (state.page > 1) {
      state.page--;
      loadTraces();
    }
  });

  document.getElementById('nextPage').addEventListener('click', () => {
    const totalPages = Math.ceil(state.total / state.pageSize);
    if (state.page < totalPages) {
      state.page++;
      loadTraces();
    }
  });

  // 清理按钮
  document.getElementById('clearBtn').addEventListener('click', () => {
    document.getElementById('clearModal').classList.add('active');
  });

  // 关闭清理弹窗
  document.getElementById('closeClearModal').addEventListener('click', () => {
    document.getElementById('clearModal').classList.remove('active');
  });

  // 点击弹窗外部关闭
  document.getElementById('clearModal').addEventListener('click', (e) => {
    if (e.target.id === 'clearModal') {
      document.getElementById('clearModal').classList.remove('active');
    }
  });

  // 清理选项
  document.querySelectorAll('.clear-option').forEach(btn => {
    btn.addEventListener('click', () => {
      clearTraces(btn.dataset.clear);
      document.getElementById('clearModal').classList.remove('active');
    });
  });

  // 点击弹窗外部关闭
  document.getElementById('detailModal').addEventListener('click', (e) => {
    if (e.target.id === 'detailModal') {
      document.getElementById('detailModal').classList.remove('active');
    }
  });

  // ESC 关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('detailModal').classList.remove('active');
      document.querySelectorAll('.raw-tooltip.active').forEach(t => t.classList.remove('active'));
    }
  });

  // 点击其他地方关闭 raw tooltip
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.raw-hint') && !e.target.closest('.raw-tooltip')) {
      document.querySelectorAll('.raw-tooltip.active').forEach(t => t.classList.remove('active'));
    }
  });
}

// ==================== 初始化 ====================

async function init() {
  initEvents();
  await loadStats();
  await loadTraces();
}

init();