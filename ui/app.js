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
    tbody.innerHTML = '<tr><td colspan="10" class="empty">暂无数据</td></tr>';
    return;
  }

  tbody.innerHTML = traces.map(trace => {
    // Token 信息（列表页用数据库字段）
    const input = trace.inputTokens || 0;
    const output = trace.outputTokens || 0;
    const cacheRead = trace.cacheReadTokens || 0;
    const total = input + output;

    return `
    <tr data-id="${trace.id}">
      <td>${formatTime(trace.timestamp)}</td>
      <td>${trace.agentId || '--'}</td>
      <td>${trace.channel || '--'}</td>
      <td>${trace.model}</td>
      <td>${formatNumber(input)}</td>
      <td>${formatNumber(output)}</td>
      <td>${formatNumber(cacheRead)}</td>
      <td>${formatNumber(total)}</td>
      <td>${formatCost(trace.cost)}</td>
      <td><span class="status status-${trace.status}">${trace.status}</span></td>
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

  document.getElementById('detailTitle').innerHTML = `
    <div class="detail-info-grid">
      <div class="detail-info-item">
        <div class="detail-info-label">🕐 时间</div>
        <div class="detail-info-value">${formatFullTime(trace.timestamp)}</div>
      </div>
      <div class="detail-info-item">
        <div class="detail-info-label">🤖 智能体</div>
        <div class="detail-info-value">${trace.agentId || '--'}</div>
      </div>
      <div class="detail-info-item">
        <div class="detail-info-label">📡 渠道</div>
        <div class="detail-info-value">${trace.channel || '--'}</div>
      </div>
      <div class="detail-info-item">
        <div class="detail-info-label">🧠 模型</div>
        <div class="detail-info-value">${trace.model || '--'}</div>
      </div>
      <div class="detail-info-item">
        <div class="detail-info-label">🔗 会话</div>
        <div class="detail-info-value">${trace.sessionId || '--'}</div>
      </div>
      <div class="detail-info-item">
        <div class="detail-info-label">⏱️ 耗时</div>
        <div class="detail-info-value">${formatDuration(trace.durationMs)}</div>
      </div>
    </div>
  `;
  document.getElementById('detailMeta').style.display = 'none';

  // 构建详情内容
  let html = '';

  // 请求
  html += `
    <div class="detail-block">
      <div class="detail-block-header">
        <span>📥 请求内容</span>
        <span>🏢 模型提供方: ${trace.provider}</span>
      </div>
      <div class="detail-block-content">${formatRequest(trace.request)}</div>
    </div>
  `;

  // 响应
  html += `
    <div class="detail-block">
      <div class="detail-block-header">
        <span>📤 响应内容</span>
        <span>⏱️ 耗时: ${formatDuration(trace.durationMs)}</span>
      </div>
      <div class="detail-block-content">${formatResponse(trace.response)}</div>
    </div>
  `;

  // Usage 详情（从 lastAssistant.usage 获取完整信息）
  html += formatUsageDetail(trace);

  // 错误信息
  if (trace.errorMessage) {
    html += `
      <div class="detail-block error-block">
        <div class="detail-block-header">
          <span>❌ 错误信息</span>
        </div>
        <div class="detail-block-content">${trace.errorMessage}</div>
      </div>
    `;
  }

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

  // 绑定原始按钮点击事件
  document.querySelectorAll('.metadata-hint').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tooltip = btn.closest('.chat-bubble').querySelector('.metadata-tooltip');
      if (tooltip) {
        tooltip.classList.add('active');
      }
    });
  });

  // 绑定tooltip关闭按钮
  document.querySelectorAll('.metadata-tooltip-close').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.metadata-tooltip').classList.remove('active');
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

function formatRequest(request) {
  if (!request) return '<div class="chat-empty">暂无请求内容</div>';

  let html = '';

  // 系统提示词区块（默认折叠）
  if (request.systemPrompt) {
    html += `
      <div class="request-section">
        <div class="request-section-header">
          <span>🤖 系统提示词</span>
          <span class="section-toggle">展开</span>
        </div>
        <div class="request-section-content collapsed">
          ${createChatMessage('system', '🤖 System', request.systemPrompt)}
        </div>
      </div>
    `;
  }

  // 历史消息区块（默认折叠）
  if (request.historyMessages && request.historyMessages.length > 0) {
    let historyHtml = '';
    request.historyMessages.forEach(msg => {
      const isUser = msg.role === 'user';
      const roleClass = isUser ? 'user' : 'assistant';
      const roleIcon = isUser ? '👤 User' : '🤖 Assistant';
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      historyHtml += createChatMessage(roleClass, roleIcon, content);
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

  // 用户提示词区块（默认展开）
  if (request.prompt) {
    const { display, original } = extractUserMessage(request.prompt);

    html += `
      <div class="request-section">
        <div class="request-section-header">
          <span>👤 用户提示词</span>
          <span class="section-toggle">收起</span>
        </div>
        <div class="request-section-content">
          ${createChatMessage('user', '👤 User', display, { metadata: { display, original } })}
        </div>
      </div>
    `;
  }

  return html || '<div class="chat-empty">暂无请求内容</div>';
}

function formatResponse(response) {
  if (!response) return '<div class="chat-empty">暂无响应内容</div>';

  let html = '';

  // 处理 lastAssistant.content 数组（包含 thinking 和 text）
  if (response.lastAssistant?.content && Array.isArray(response.lastAssistant.content)) {
    response.lastAssistant.content.forEach(item => {
      if (item.type === 'thinking' && item.thinking) {
        // 思考过程：默认展开，超过20行或2000字符才折叠
        html += createChatMessage('thinking', '💭 思考过程', item.thinking, { maxLines: 20, maxChars: 2000 });
      } else if (item.type === 'text' && item.text) {
        html += createChatMessage('assistant', '🤖 Assistant', item.text);
      }
    });
  }
  // 处理 assistantTexts
  else if (response.assistantTexts && response.assistantTexts.length > 0) {
    response.assistantTexts.forEach(text => {
      html += createChatMessage('assistant', '🤖 Assistant', text);
    });
  }
  // 兜底处理
  else if (response.lastAssistant) {
    const content = typeof response.lastAssistant === 'string'
      ? response.lastAssistant
      : JSON.stringify(response.lastAssistant, null, 2);
    html += createChatMessage('assistant', '🤖 Assistant', content);
  }

  return html || '<div class="chat-empty">暂无响应内容</div>';
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

  // metadata 支持（用于用户提示词显示原始内容）
  const metadata = options.metadata;
  const hasMetadata = metadata && metadata.display !== metadata.original;

  return `
    <div class="chat-message chat-${type}">
      <div class="chat-bubble">
        <div class="chat-header">
          <span class="chat-role">${role}</span>
          ${shouldCollapse ? '<span class="chat-toggle">展开</span>' : ''}
          ${hasMetadata ? '<span class="metadata-hint">📋 原始</span>' : ''}
        </div>
        <div class="chat-content ${collapsedClass}">${escapeHtml(text)}</div>
        ${hasMetadata ? `<div class="metadata-tooltip"><span class="metadata-tooltip-close">&times;</span><div class="metadata-tooltip-content">${escapeHtml(metadata.original)}</div></div>` : ''}
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

function formatUsageDetail(trace) {
  // 从 response 获取完整 usage 信息
  const usage = trace.response?.usage || {};
  const lastAssistantUsage = trace.response?.lastAssistant?.usage || {};

  // Token 信息：优先用 usage，再用 lastAssistant.usage，最后用数据库字段
  const input = usage.input || lastAssistantUsage.input || trace.inputTokens || 0;
  const output = usage.output || lastAssistantUsage.output || trace.outputTokens || 0;
  const cacheRead = usage.cacheRead || lastAssistantUsage.cacheRead || trace.cacheReadTokens || 0;
  const cacheWrite = lastAssistantUsage.cacheWrite || trace.cacheWriteTokens || 0;
  const total = usage.total;  // 直接用 usage.total

  // Cost 信息：从 lastAssistant.usage.cost 获取
  const costInfo = lastAssistantUsage.cost || {};
  const costInput = costInfo.input || 0;
  const costOutput = costInfo.output || 0;
  const costCacheRead = costInfo.cacheRead || 0;
  const costCacheWrite = costInfo.cacheWrite || 0;
  const costTotal = costInfo.total || trace.cost || 0;

  // 停止原因和响应ID
  const stopReason = trace.response?.lastAssistant?.stopReason || '--';
  const responseId = trace.response?.lastAssistant?.responseId || '--';

  return `
    <div class="detail-block">
      <div class="detail-block-header">
        <span>📊 Usage 详情</span>
      </div>
      <div class="usage-grid">
        <div class="usage-section">
          <h4>📊 Token 统计</h4>
          <table class="usage-table">
            <tr><td>📥 输入 Token</td><td>${formatNumber(input)}</td></tr>
            <tr><td>📤 输出 Token</td><td>${formatNumber(output)}</td></tr>
            <tr><td>⚡ 命中缓存</td><td>${formatNumber(cacheRead)}</td></tr>
            <tr><td>💾 缓存写入</td><td>${formatNumber(cacheWrite)}</td></tr>
            <tr class="total-row"><td><strong>📊 总计</strong></td><td><strong>${formatNumber(total)}</strong></td></tr>
          </table>
        </div>
        <div class="usage-section">
          <h4>💰 成本明细</h4>
          <table class="usage-table">
            <tr><td>📥 输入成本</td><td>${formatCost(costInput)}</td></tr>
            <tr><td>📤 输出成本</td><td>${formatCost(costOutput)}</td></tr>
            <tr><td>⚡ 缓存读取</td><td>${formatCost(costCacheRead)}</td></tr>
            <tr><td>💾 缓存写入</td><td>${formatCost(costCacheWrite)}</td></tr>
            <tr class="total-row"><td><strong>💰 总成本</strong></td><td><strong>${formatCost(costTotal)}</strong></td></tr>
          </table>
        </div>
        <div class="usage-section">
          <h4>📋 其他信息</h4>
          <table class="usage-table">
            <tr><td>🛑 停止原因</td><td><span class="status status-${trace.status}">${stopReason}</span></td></tr>
            <tr><td>🔖 响应 ID</td><td><code class="response-id">${responseId}</code></td></tr>
            <tr><td>🔗 Session</td><td><code class="response-id">${trace.sessionId || '--'}</code></td></tr>
          </table>
        </div>
      </div>
    </div>
  `;
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

  // Channel 选项
  const channelSelect = document.getElementById('filterChannel');
  const existingChannels = new Set([...channelSelect.options].map(o => o.value));
  stats.byChannel.forEach(item => {
    if (item.channel && !existingChannels.has(item.channel)) {
      const option = document.createElement('option');
      option.value = item.channel;
      option.textContent = item.channel;
      channelSelect.appendChild(option);
      existingChannels.add(item.channel);
    }
  });

  // Provider 选项
  const providerSelect = document.getElementById('filterProvider');
  const existingProviders = new Set([...providerSelect.options].map(o => o.value));
  stats.byProvider.forEach(item => {
    if (item.provider && !existingProviders.has(item.provider)) {
      const option = document.createElement('option');
      option.value = item.provider;
      option.textContent = item.provider;
      providerSelect.appendChild(option);
      existingProviders.add(item.provider);
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

  // 搜索
  document.getElementById('searchBtn').addEventListener('click', () => {
    state.page = 1;
    const timeFilter = document.getElementById('filterTime').value;
    const { startDate, endDate } = parseTimeFilter(timeFilter);

    state.filters = {
      keyword: document.getElementById('keyword').value,
      agentId: document.getElementById('filterAgent').value,
      channel: document.getElementById('filterChannel').value,
      provider: document.getElementById('filterProvider').value,
      model: document.getElementById('filterModel').value,
      status: document.getElementById('filterStatus').value,
      startDate,
      endDate,
    };
    loadTraces();
  });

  // 回车搜索
  document.getElementById('keyword').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('searchBtn').click();
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
      document.querySelectorAll('.metadata-tooltip.active').forEach(t => t.classList.remove('active'));
    }
  });

  // 点击其他地方关闭 metadata tooltip
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.metadata-hint') && !e.target.closest('.metadata-tooltip')) {
      document.querySelectorAll('.metadata-tooltip.active').forEach(t => t.classList.remove('active'));
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