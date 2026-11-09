const messagesEl = document.getElementById('messages');
const statusText = document.getElementById('status-text');
const headerTitle = document.getElementById('header-title');
const modeBtn = document.getElementById('mode-btn');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop-btn');
const thinkingEl = document.getElementById('thinking');
const scrollBtn = document.getElementById('scroll-btn');
const navigatorEl = document.getElementById('navigator');
const chatViewEl = document.getElementById('chat-view');
const navListEl = document.getElementById('nav-list');
const backBtn = document.getElementById('back-btn');
const notificationBtn = document.getElementById('notification-btn');

// Derive base path for proxy-safe URLs (e.g. "/app/acp-mobile/" -> "/app/acp-mobile")
const basePath = location.pathname.replace(/\/$/, '');

let selecting = false;
let selectedSessions = new Set(); // Set of bufferNames

let ws, nextId = 100, sessionId = null;
let currentAgentMsg = null;
let processing = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isAtBottom = true;
let msgIdCounter = 0;
let projectCwd = null;
let currentSockPid = null;
let currentBufferName = null;

// Notification state
let notificationEnabled = localStorage.getItem('acp-notification') !== 'false';
function updateNotificationUI() {
  notificationBtn.classList.toggle('muted', !notificationEnabled);
  notificationBtn.innerHTML = notificationEnabled ? '🔔' : '🔕';
}
notificationBtn.onclick = () => {
  notificationEnabled = !notificationEnabled;
  localStorage.setItem('acp-notification', notificationEnabled);
  updateNotificationUI();
  if (notificationEnabled) playNotification();
};
function playNotification() {
  if (!notificationEnabled) return;
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(1.0, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);
    setTimeout(() => audioCtx.close(), 400);
  } catch (e) {}
}
updateNotificationUI();

// Auto-speak state
const autoSpeakBtn = document.getElementById('autospeak-btn');
let autoSpeakEnabled = localStorage.getItem('acp-autospeak') === 'true';
function updateAutoSpeakUI() {
  autoSpeakBtn.classList.toggle('muted', !autoSpeakEnabled);
  autoSpeakBtn.innerHTML = autoSpeakEnabled ? '🗣' : '🔇';
}
autoSpeakBtn.onclick = () => {
  autoSpeakEnabled = !autoSpeakEnabled;
  localStorage.setItem('acp-autospeak', autoSpeakEnabled);
  updateAutoSpeakUI();
};
updateAutoSpeakUI();

// Permission state
let pendingPermissions = []; // [{id, element}]

// Mode state
let currentMode = 'default';
let availableModes = [];
let replayMode = false;
let replayBuffer = [];
let replayTimer = null;
let allReplayTurns = [];  // Full history from replay
let renderedTurnStart = 0; // Index into allReplayTurns of first rendered turn
let currentSpeakEl = null;
let ttsRate = parseFloat(localStorage.getItem('ttsRate'));
if (isNaN(ttsRate) || ttsRate < 0.1 || ttsRate > 10) ttsRate = 1;
// Mode display: look up name from availableModes, fall back to id
function modeName(id) {
  const mode = availableModes.find(m => m.id === id);
  return mode ? mode.name : id;
}
function modeColor(id) {
  // Heuristic coloring based on common mode semantics
  const lower = id.toLowerCase();
  if (lower.includes('yolo') || lower.includes('bypass')) return '#F44336';
  if (lower.includes('plan') || lower.includes('architect')) return '#FF9800';
  if (lower.includes('edit') || lower.includes('code') || lower.includes('auto')) return '#4CAF50';
  if (lower.includes('dont') || lower.includes("don't")) return '#2196F3';
  return '#888';
}

// --- Markdown renderer (basic, no dependencies) ---

function renderMarkdown(text) {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    '<pre><code>' + code.trimEnd() + '</code></pre>');

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links (only allow http/https, escape quotes to prevent attribute injection)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    if (/^https?:\/\//i.test(url)) {
      var safeUrl = url.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      return '<a href="' + safeUrl + '" target="_blank" rel="noopener">' + text + '</a>';
    }
    return text + ' (' + url + ')';
  });

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^(?:- |\* )(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => '<ul>' + m + '</ul>');

  // Paragraphs
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  return '<p>' + html + '</p>';
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderDiff(oldStr, newStr) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  let html = '';
  for (const line of oldLines) {
    html += '<span class="diff-removed">- ' + escHtml(line) + '</span>\n';
  }
  for (const line of newLines) {
    html += '<span class="diff-added">+ ' + escHtml(line) + '</span>\n';
  }
  return html;
}

function shortPath(p) {
  return p ? p.replace(/^\/Users\/[^/]+/, '~') : '';
}

function formatTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// --- Message display ---

function stripMarkdownForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, 'code block')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/^---+$/gm, '')
    .trim();
}

function splitSpeechChunks(text, maxLen = 200) {
  // Chrome silently drops SpeechSynthesisUtterances longer than ~200 chars.
  // Split at sentence boundaries first, then word boundaries if a sentence
  // is still too long.
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) || [text];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxLen) {
      // Sentence itself is too long — split at word boundaries
      if (current) { chunks.push(current.trim()); current = ''; }
      const words = sentence.split(/\s+/);
      for (const word of words) {
        if ((current + ' ' + word).trim().length > maxLen && current) {
          chunks.push(current.trim());
          current = word;
        } else {
          current = current ? current + ' ' + word : word;
        }
      }
    } else if ((current + sentence).length > maxLen && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 0);
}

function speakMsg(d, rawText) {
  const btn = d.querySelector('.msg-tts-btn');
  if (currentSpeakEl === d) {
    speechSynthesis.cancel();
    currentSpeakEl = null;
    btn.textContent = '🔊';
    return;
  }
  if (currentSpeakEl) {
    const prevBtn = currentSpeakEl.querySelector('.msg-tts-btn');
    if (prevBtn) prevBtn.textContent = '🔊';
    speechSynthesis.cancel();
  }
  currentSpeakEl = d;
  btn.textContent = '🔇';

  const chunks = splitSpeechChunks(rawText);
  let heartbeat = null;

  function finish() {
    clearInterval(heartbeat);
    if (currentSpeakEl === d) currentSpeakEl = null;
    btn.textContent = '🔊';
  }

  // Queue all chunks synchronously — every speak() is in the user gesture context
  chunks.forEach((chunk, i) => {
    const utter = new SpeechSynthesisUtterance(chunk);
    utter.rate = ttsRate;
    if (i === chunks.length - 1) utter.onend = finish;
    utter.onerror = () => { speechSynthesis.cancel(); finish(); };
    speechSynthesis.speak(utter);
  });

  // Heartbeat defeats Chrome's ~15s silent-pause bug
  heartbeat = setInterval(() => {
    if (speechSynthesis.paused) speechSynthesis.resume();
  }, 10000);
}

function attachMsgBubbleBtns(d, isMarkdown) {
  d.querySelector('.msg-header').insertAdjacentHTML('beforeend',
    '<button class="msg-bubble-btn msg-copy-btn" title="Copy">⎘</button>' +
    '<button class="msg-bubble-btn msg-tts-btn" title="Speak">🔊</button>'
  );
  d.querySelector('.msg-copy-btn').addEventListener('click', (e) => { e.stopPropagation(); copyText(d._text); });
  d.querySelector('.msg-tts-btn').addEventListener('click', (e) => { e.stopPropagation(); speakMsg(d, isMarkdown ? stripMarkdownForSpeech(d._text) : d._text); });
}

function addUserMsg(text, status) {
  const d = document.createElement('div');
  d.className = 'msg user';
  d.id = 'msg-' + (++msgIdCounter);
  const time = formatTime(new Date());
  const deliveryIcon = status === 'queued' ? '&#9201;' : status === 'sending' ? '&#9675;' : '&#10003;';
  d.innerHTML =
    '<div class="msg-header">' +
      '<span class="role">You</span>' +
    '</div>' +
    '<div class="text">' + escHtml(text) + '</div>' +
    '<div class="meta"><span class="time">' + time + '</span>' +
    '<span class="delivery">' + deliveryIcon + '</span></div>';
  d._text = text;
  attachMsgBubbleBtns(d, false);
  messagesEl.appendChild(d);
  if (isAtBottom) scrollToBottom();
  return d;
}

function markSent(el) {
  const delivery = el.querySelector('.delivery');
  if (delivery) delivery.innerHTML = '&#10003;';
}

function addAgentMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg agent';
  d.id = 'msg-' + (++msgIdCounter);
  d.innerHTML =
    '<div class="msg-header">' +
      '<span class="role">Agent</span>' +
    '</div>' +
    '<div class="md">' + renderMarkdown(text) + '</div>';
  d._text = text;
  attachMsgBubbleBtns(d, true);
  messagesEl.appendChild(d);
  if (isAtBottom) scrollToBottom();
  return d;
}

function updateAgentMsg(el, text) {
  el._text = text;
  el.querySelector('.md').innerHTML = renderMarkdown(text);
  if (isAtBottom) scrollToBottom();
}

function addToolMsg(toolName, params, type) {
  const d = document.createElement('div');
  d.className = 'msg tool';
  d.id = 'msg-' + (++msgIdCounter);

  const cleanType = (type || toolName).replace('mcp__acp__', '');

  // Pick icon based on tool type
  let icon = '\u2699'; // gear
  if (cleanType === 'Read') icon = '\uD83D\uDCD6';
  else if (cleanType === 'Write') icon = '\uD83D\uDCDD';
  else if (cleanType === 'Edit') icon = '\u270F\uFE0F';
  else if (cleanType === 'Bash') icon = '\uD83D\uDCBB';
  else if (cleanType === 'Grep' || cleanType === 'Glob') icon = '\uD83D\uDD0D';

  // Extract subtitle (path/command) and description from params
  let subtitle = '';
  let titleText = toolName;
  if (params) {
    subtitle = params.file_path || params.path || params.command || '';
    if (params.description) titleText = params.description;
  }

  let infoHtml = '<div class="tool-name">' + escHtml(titleText) + '</div>';
  if (subtitle) {
    infoHtml += '<div class="tool-path">' + escHtml(shortPath(subtitle)) + '</div>';
  }

  // Pre-populate tool body with input details for Edit/Write
  let bodyHtml = '';
  if (params && cleanType === 'Edit' && params.old_string) {
    bodyHtml = renderDiff(params.old_string, params.new_string || '');
  } else if (params && params.plan) {
    bodyHtml = '<div class="md">' + renderMarkdown(params.plan) + '</div>';
  } else if (params && cleanType === 'Write' && params.content) {
    const preview = params.content.length > 2000
      ? params.content.slice(0, 2000) + '\n... (truncated)'
      : params.content;
    bodyHtml = escHtml(preview);
  } else if (params) {
    // Show params summary for other tools (Grep pattern, Bash command, etc.)
    const parts = [];
    for (const [k, v] of Object.entries(params)) {
      if (k === 'file_path' || k === 'path' || k === 'command' || k === 'description') continue; // already in title/subtitle
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(k + ': ' + s);
    }
    if (parts.length) bodyHtml = escHtml(parts.join('\n'));
  }

  d.innerHTML =
    '<div class="tool-header">' +
      '<span class="tool-icon">' + icon + '</span>' +
      '<div class="tool-info">' + infoHtml + '</div>' +
      '<span class="tool-expand">&#9656;</span>' +
    '</div>' +
    '<div class="tool-body">' + bodyHtml + '</div>' +
    '<div class="tool-hint">' + (bodyHtml ? 'tap to view details' : 'tap to expand') + '</div>';
  d.onclick = () => d.classList.toggle('expanded');
  d.addEventListener('contextmenu', (e) => { e.preventDefault(); copyText(toolCopyText(d)); });
  messagesEl.appendChild(d);
  if (isAtBottom) scrollToBottom();
  return d;
}

function updateToolInfo(toolEl, name, params, type) {
  const cleanType = (type || name).replace('mcp__acp__', '');
  const nameEl = toolEl.querySelector('.tool-name');
  let titleText = name;
  if (params && params.description) titleText = params.description;
  if (nameEl) nameEl.textContent = titleText;

  let subtitle = '';
  if (params) subtitle = params.file_path || params.path || params.command || '';
  const pathEl = toolEl.querySelector('.tool-path');
  if (subtitle) {
    if (pathEl) {
      pathEl.textContent = shortPath(subtitle);
    } else {
      const infoEl = toolEl.querySelector('.tool-info');
      if (infoEl) {
        const p = document.createElement('div');
        p.className = 'tool-path';
        p.textContent = shortPath(subtitle);
        infoEl.appendChild(p);
      }
    }
  }

  // Update body with input details
  const body = toolEl.querySelector('.tool-body');
  if (body && !body.innerHTML.trim()) {
    let bodyHtml = '';
    if (params && cleanType === 'Edit' && params.old_string) {
      bodyHtml = renderDiff(params.old_string, params.new_string || '');
    } else if (params && params.plan) {
    bodyHtml = '<div class="md">' + renderMarkdown(params.plan) + '</div>';
  } else if (params && cleanType === 'Write' && params.content) {
      const preview = params.content.length > 2000
        ? params.content.slice(0, 2000) + '\n... (truncated)'
        : params.content;
      bodyHtml = escHtml(preview);
    } else if (params) {
      // Show params summary for other tools
      const parts = [];
      for (const [k, v] of Object.entries(params)) {
        if (k === 'file_path' || k === 'path' || k === 'command' || k === 'description') continue;
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        parts.push(k + ': ' + s);
      }
      if (parts.length) bodyHtml = escHtml(parts.join('\n'));
    }
    if (bodyHtml) {
      body.innerHTML = bodyHtml;
      const hint = toolEl.querySelector('.tool-hint');
      if (hint) hint.textContent = 'tap to view details';
    }
  }
}

function updateToolStatus(toolEl, status, content) {
  const nameEl = toolEl.querySelector('.tool-name');
  if (nameEl) {
    nameEl.className = 'tool-name ' + status;
    // Update icon
    const iconEl = toolEl.querySelector('.tool-icon');
    if (status === 'completed') {
      iconEl.textContent = '\u2713';
    } else if (status === 'failed') {
      iconEl.textContent = '\u2717';
    }
  }
  const body = toolEl.querySelector('.tool-body');
  const hint = toolEl.querySelector('.tool-hint');
  if (content) {
    if (body) {
      if (body.innerHTML.trim()) {
        // Body has input params - add separator and append result
        const sep = document.createElement('hr');
        sep.style.cssText = 'border:none;border-top:1px solid #333;margin:8px 0';
        body.appendChild(sep);
        const out = document.createElement('div');
        out.textContent = content;
        body.appendChild(out);
      } else {
        body.textContent = content;
      }
    }
    if (hint) hint.textContent = 'tap to view details';
  } else if (body && body.innerHTML.trim()) {
    if (hint) hint.textContent = 'tap to view details';
  }
}

function addSystemMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg system';
  d.innerHTML = '<span class="text">' + escHtml(text) + '</span>';
  messagesEl.appendChild(d);
  if (isAtBottom) scrollToBottom();
  return d;
}

function addErrorMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg error';
  d.innerHTML =
    '<span class="error-icon">\u26A0\uFE0F</span>' +
    '<span class="text">' + escHtml(text) + '</span>';
  messagesEl.appendChild(d);
  if (isAtBottom) scrollToBottom();
  return d;
}

function addPermissionMsg(msg, interactive) {
  const params = msg.params || {};
  const tc = params.toolCall || {};
  const options = params.options || [];

  const d = document.createElement('div');
  d.className = 'msg permission' + (interactive ? '' : ' resolved');
  d.id = 'msg-' + (++msgIdCounter);

  // Icon based on tool kind
  const KIND_ICONS = {
    read: '\uD83D\uDCD6', edit: '\u270F\uFE0F', delete: '\uD83D\uDDD1',
    execute: '\uD83D\uDCBB', search: '\uD83D\uDD0D', fetch: '\uD83C\uDF10',
    switch_mode: '\uD83D\uDCCB'
  };
  const icon = KIND_ICONS[tc.kind] || '\uD83D\uDD12';

  // Extract path from content or locations
  let filePath = '';
  if (tc.content && tc.content.length > 0) {
    filePath = tc.content[0].path || '';
  }
  if (!filePath && tc.locations && tc.locations.length > 0) {
    filePath = tc.locations[0].path || '';
  }

  let headerHtml =
    '<div class="perm-header">' +
      '<span class="perm-icon">' + icon + '</span>' +
      '<div class="perm-info">' +
        '<div class="perm-title">' + escHtml(tc.title || 'Permission required') + '</div>' +
        (filePath ? '<div class="perm-path">' + escHtml(shortPath(filePath)) + '</div>' : '') +
      '</div>' +
    '</div>';

  // Detail: show diff or text content
  let detailHtml = '';
  // ExitPlanMode: show the plan text from rawInput.plan
  if (tc.kind === 'switch_mode' && tc.rawInput && tc.rawInput.plan) {
    detailHtml = '<div class="perm-detail md">' + renderMarkdown(tc.rawInput.plan) + '</div>';
  } else if (tc.content && tc.content.length > 0) {
    const c = tc.content[0];
    if (c.type === 'diff' && c.oldText !== undefined) {
      detailHtml = '<div class="perm-detail">' + renderDiff(c.oldText, c.newText || '') + '</div>';
    } else if (c.type === 'text' && c.text) {
      const preview = c.text.length > 1000 ? c.text.slice(0, 1000) + '\n... (truncated)' : c.text;
      detailHtml = '<div class="perm-detail">' + escHtml(preview) + '</div>';
    } else if (c.type === 'terminal' && c.command) {
      detailHtml = '<div class="perm-detail">$ ' + escHtml(c.command) + '</div>';
    }
  }

  // Option buttons
  let optionsHtml = '';
  if (interactive && options.length > 0) {
    optionsHtml = '<div class="perm-options">';
    for (const opt of options) {
      let cls = 'perm-btn';
      if (opt.kind === 'allow_once') cls += ' allow';
      else if (opt.kind === 'allow_always') cls += ' allow-always';
      else if (opt.kind === 'reject_once') cls += ' reject';
      else if (opt.kind === 'reject_always') cls += ' reject-always';
      optionsHtml += '<button class="' + cls + '" data-option-id="' + escHtml(opt.optionId) + '">' +
        escHtml(opt.name) + '</button>';
    }
    optionsHtml += '</div>';
  }

  d.innerHTML = headerHtml + detailHtml + optionsHtml;

  if (interactive) {
    const buttons = d.querySelectorAll('.perm-btn');
    buttons.forEach(btn => {
      btn.onclick = () => {
        const optionId = btn.getAttribute('data-option-id');
        // Send response
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { outcome: { outcome: 'selected', optionId: optionId } }
        }));
        // Disable all buttons, highlight selected
        buttons.forEach(b => { b.disabled = true; });
        btn.classList.add('selected');
        d.classList.add('resolved');
        // Remove from pending
        pendingPermissions = pendingPermissions.filter(p => p.id !== msg.id);
      };
    });
    pendingPermissions.push({ id: msg.id, element: d });
  }

  messagesEl.appendChild(d);
  if (isAtBottom) scrollToBottom();
  return d;
}

// Add approve/reject buttons to a pending ExitPlanMode tool card.
// The card already shows the plan text; this adds interactive buttons.
function addPlanApprovalButtons(toolEl) {
  const btns = document.createElement('div');
  btns.className = 'perm-options';
  btns.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;padding:0 12px 12px';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'perm-btn allow';
  approveBtn.textContent = 'Approve';
  approveBtn.style.cssText = 'border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;background:#238636;color:#fff';

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'perm-btn reject';
  rejectBtn.textContent = 'Reject';
  rejectBtn.style.cssText = 'border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;background:#8b2020;color:#fff';

  function respond(approved) {
    // Check if there's a pending permission we can respond to
    const pending = pendingPermissions.find(p => true); // any pending permission
    if (pending) {
      const optionId = approved ? 'default' : (pending.element ? 'reject' : 'default');
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: pending.id,
        result: { outcome: { outcome: 'selected', optionId: approved ? 'default' : 'reject' } }
      }));
      pendingPermissions = pendingPermissions.filter(p2 => p2.id !== pending.id);
    } else {
      // No pending permission — send as a prompt
      if (sessionId && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: Date.now(),
          method: 'session/prompt',
          params: {
            sessionId: sessionId,
            prompt: [{ type: 'text', text: approved ? 'Yes, proceed with the plan.' : 'No, reject the plan.' }]
          }
        }));
      }
    }
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    (approved ? approveBtn : rejectBtn).style.outline = '2px solid #fff';
    (approved ? approveBtn : rejectBtn).style.outlineOffset = '1px';
    toolEl.classList.add('resolved');
  }

  approveBtn.onclick = (e) => { e.stopPropagation(); respond(true); };
  rejectBtn.onclick = (e) => { e.stopPropagation(); respond(false); };

  btns.appendChild(approveBtn);
  btns.appendChild(rejectBtn);

  // Make card expanded by default so plan text and buttons are visible
  toolEl.classList.add('expanded');
  toolEl.appendChild(btns);
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Copied to clipboard');
    }).catch(() => { copyTextFallback(text); });
  } else {
    copyTextFallback(text);
  }
}
function copyTextFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); showToast('Copied to clipboard'); }
  catch(e) { showToast('Copy failed'); }
  document.body.removeChild(ta);
}

function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('visible'), 1500);
}

function toolCopyText(el) {
  const name = el.querySelector('.tool-name');
  const path = el.querySelector('.tool-path');
  const body = el.querySelector('.tool-body');
  let parts = [];
  if (name) parts.push(name.textContent);
  if (path) parts.push(path.textContent);
  if (body && body.textContent.trim()) parts.push(body.textContent.trim());
  return parts.join('\n');
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  scrollBtn.classList.remove('visible');
  isAtBottom = true;
}

messagesEl.addEventListener('scroll', () => {
  const dist = messagesEl.scrollHeight - messagesEl.clientHeight - messagesEl.scrollTop;
  isAtBottom = dist < 60;
  scrollBtn.classList.toggle('visible', !isAtBottom);
});

function setProcessing(v) {
  processing = v;
  thinkingEl.classList.toggle('visible', v);
  sendBtn.style.display = v ? 'none' : '';
  stopBtn.style.display = v ? 'flex' : 'none';
}

function updateModeBtn() {
  const label = modeName(currentMode);
  const color = modeColor(currentMode);
  modeBtn.textContent = label;
  modeBtn.style.color = color;
  modeBtn.style.borderColor = color;
}

function cycleMode() {
  if (!sessionId || availableModes.length === 0) return;
  const ids = availableModes.map(m => m.id);
  const idx = ids.indexOf(currentMode);
  const nextMode = ids[(idx + 1) % ids.length];
  // Optimistic update
  currentMode = nextMode;
  updateModeBtn();
  // Send to agent
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: nextId++,
    method: 'session/set_mode',
    params: { sessionId, modeId: nextMode }
  }));
}

// --- WebSocket & ACP protocol ---

function connect(pid) {
  replayMode = true;
  replayBuffer = [];
  clearTimeout(replayTimer);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = proto + '//' + location.host + basePath + '/ws';
  if (pid) url += '?sock=' + pid;

  ws = new WebSocket(url);

  ws.onopen = () => {
    statusText.textContent = 'Connected';
    statusText.className = 'header-status connected';
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (replayMode) {
      replayBuffer.push(msg);
      clearTimeout(replayTimer);
      replayTimer = setTimeout(flushReplay, 80);
    } else {
      handleMessage(msg);
    }
  };

  ws.onclose = () => {
    statusText.textContent = 'Disconnected';
    statusText.className = 'header-status error';
    sendBtn.disabled = true;
    setProcessing(false);
    if (chatViewEl && chatViewEl.classList.contains('visible')) {
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    statusText.textContent = 'Connection error';
    statusText.className = 'header-status error';
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(60000, 2000 * Math.pow(2, reconnectAttempts));
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    messagesEl.innerHTML = '';
    currentAgentMsg = null;
    sessionId = null;
    allReplayTurns = [];
    pendingPermissions = [];
    renderedTurnStart = 0;
    if (currentSockPid) {
      connect(String(currentSockPid));
    } else {
      connect();
    }
  }, delay);
}

function toolType(update) {
  return (update._meta && update._meta.claudeCode && update._meta.claudeCode.toolName) || '';
}

function toolName(update) {
  return update.title || toolType(update) || '?';
}

function toolOutputText(update) {
  if (update.rawOutput) {
    if (Array.isArray(update.rawOutput)) {
      return update.rawOutput.map(c => (c && c.text) || '').filter(Boolean).join('\n');
    }
    if (typeof update.rawOutput === 'string') return update.rawOutput;
  }
  if (Array.isArray(update.content)) {
    for (const c of update.content) {
      const inner = c.content || c;
      if (inner.text) return inner.text;
    }
  }
  if (typeof update.content === 'string') return update.content;
  if (update.content && update.content.text) return update.content.text;
  return '';
}

function renderTurnBatch(turns, prepend) {
  let fragment = document.createDocumentFragment();
  let lastToolEl = null;
  for (let _ti = 0; _ti < turns.length; _ti++) {
    const t = turns[_ti];
    switch (t.type) {
      case 'user': {
        const d = document.createElement('div');
        d.className = 'msg user';
        d.id = 'msg-' + (++msgIdCounter);
        const time = formatTime(new Date());
        d.innerHTML =
          '<div class="msg-header">' +
            '<span class="role">You</span>' +
          '</div>' +
          '<div class="text">' + escHtml(t.text) + '</div>' +
          '<div class="meta"><span class="time">' + time + '</span>' +
          '<span class="delivery">&#10003;</span></div>';
        d._text = t.text;
        attachMsgBubbleBtns(d, false);
        fragment.appendChild(d);
        break;
      }
      case 'agent': {
        const d = document.createElement('div');
        d.className = 'msg agent';
        d.id = 'msg-' + (++msgIdCounter);
        d.innerHTML =
          '<div class="msg-header">' +
            '<span class="role">Agent</span>' +
          '</div>' +
          '<div class="md">' + renderMarkdown(t.text) + '</div>';
        d._text = t.text;
        attachMsgBubbleBtns(d, true);
        fragment.appendChild(d);
        break;
      }
      case 'tool':
        lastToolEl = addToolMsgTo(fragment, t.toolName, t.toolParams, t.toolType);
        if (t.toolStatus) updateToolStatus(lastToolEl, t.toolStatus, t.toolContent);
        // Pending ExitPlanMode: show plan approval buttons (unless a permission card follows)
        if (t.toolKind === 'switch_mode' && t.toolParams && t.toolParams.plan && !t.toolStatus) {
          const hasPermAfter = turns.slice(_ti + 1).some(t2 => t2.type === 'permission');
          if (!hasPermAfter) addPlanApprovalButtons(lastToolEl);
        }
        break;
      case 'tool_update':
        if (lastToolEl) updateToolStatus(lastToolEl, t.toolStatus, t.toolContent);
        break;
      case 'permission': {
        // Append batch so far, render permission (it appends to messagesEl),
        // then start a new fragment for remaining turns
        if (prepend) {
          messagesEl.insertBefore(fragment, messagesEl.firstChild);
        } else {
          messagesEl.appendChild(fragment);
        }
        fragment = document.createDocumentFragment();
        addPermissionMsg(t.msg, t.interactive || false);
        break;
      }
      case 'error': {
        const d = document.createElement('div');
        d.className = 'msg error';
        d.innerHTML =
          '<span class="error-icon">\u26A0\uFE0F</span>' +
          '<span class="text">' + escHtml(t.text) + '</span>';
        fragment.appendChild(d);
        break;
      }
    }
  }
  if (prepend) {
    messagesEl.insertBefore(fragment, messagesEl.firstChild);
  } else {
    messagesEl.appendChild(fragment);
  }
}

// Like addToolMsg but appends to a given parent (DocumentFragment)
function addToolMsgTo(parent, toolName, params, type) {
  const d = document.createElement('div');
  d.className = 'msg tool';
  d.id = 'msg-' + (++msgIdCounter);

  const cleanType = (type || toolName).replace('mcp__acp__', '');
  let icon = '\u2699';
  if (cleanType === 'Read') icon = '\uD83D\uDCD6';
  else if (cleanType === 'Write') icon = '\uD83D\uDCDD';
  else if (cleanType === 'Edit') icon = '\u270F\uFE0F';
  else if (cleanType === 'Bash') icon = '\uD83D\uDCBB';
  else if (cleanType === 'Grep' || cleanType === 'Glob') icon = '\uD83D\uDD0D';

  let subtitle = '';
  let titleText = toolName;
  if (params) {
    subtitle = params.file_path || params.path || params.command || '';
    if (params.description) titleText = params.description;
  }

  let infoHtml = '<div class="tool-name completed">' + escHtml(titleText) + '</div>';
  if (subtitle) {
    infoHtml += '<div class="tool-path">' + escHtml(shortPath(subtitle)) + '</div>';
  }

  let bodyHtml = '';
  if (params && cleanType === 'Edit' && params.old_string) {
    bodyHtml = renderDiff(params.old_string, params.new_string || '');
  } else if (params && params.plan) {
    bodyHtml = '<div class="md">' + renderMarkdown(params.plan) + '</div>';
  } else if (params && cleanType === 'Write' && params.content) {
    const preview = params.content.length > 2000
      ? params.content.slice(0, 2000) + '\n... (truncated)'
      : params.content;
    bodyHtml = escHtml(preview);
  } else if (params) {
    const parts = [];
    for (const [k, v] of Object.entries(params)) {
      if (k === 'file_path' || k === 'path' || k === 'command' || k === 'description') continue;
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(k + ': ' + s);
    }
    if (parts.length) bodyHtml = escHtml(parts.join('\n'));
  }

  d.innerHTML =
    '<div class="tool-header">' +
      '<span class="tool-icon">\u2713</span>' +
      '<div class="tool-info">' + infoHtml + '</div>' +
      '<span class="tool-expand">&#9656;</span>' +
    '</div>' +
    '<div class="tool-body">' + bodyHtml + '</div>' +
    '<div class="tool-hint">' + (bodyHtml ? 'tap to view details' : 'tap to expand') + '</div>';
  d.onclick = () => d.classList.toggle('expanded');
  d.addEventListener('contextmenu', (e) => { e.preventDefault(); copyText(toolCopyText(d)); });
  parent.appendChild(d);
  return d;
}

function showLoadMoreHint() {
  let hint = document.getElementById('load-more-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'load-more-hint';
    hint.style.cssText = 'text-align:center;padding:12px;color:#007AFF;font-size:13px;cursor:pointer';
    hint.textContent = 'Load earlier messages';
    hint.onclick = loadMoreHistory;
  }
  messagesEl.insertBefore(hint, messagesEl.firstChild);
}

function loadMoreHistory() {
  if (renderedTurnStart <= 0) return;
  const LOAD_CHUNK = 20;
  const newStart = Math.max(0, renderedTurnStart - LOAD_CHUNK);
  const batch = allReplayTurns.slice(newStart, renderedTurnStart);
  renderedTurnStart = newStart;

  // Remember scroll position to maintain view
  const prevHeight = messagesEl.scrollHeight;

  // Remove existing hint
  const hint = document.getElementById('load-more-hint');
  if (hint) hint.remove();

  renderTurnBatch(batch, true);

  // Re-add hint if there's more
  if (renderedTurnStart > 0) {
    showLoadMoreHint();
  }

  // Restore scroll position
  messagesEl.scrollTop += messagesEl.scrollHeight - prevHeight;
}

// Process all buffered replay messages at once, skipping intermediate renders.
// Assembles agent chunks into complete messages, renders once per message turn.
function flushReplay() {
  replayMode = false;
  const msgs = replayBuffer;
  replayBuffer = [];

  // First pass: process responses (initialize, session/new, prompt results)
  // and collect notification sequences into assembled turns.
  const turns = []; // {type, text, toolName, toolParams, toolStatus, toolContent}
  let pendingText = '';
  let replayEnded = false; // true if we saw a stopReason or available_commands_update

  for (const msg of msgs) {
    // Responses: handle silently for state (sessionId, modes, etc.)
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      if (msg.error) {
        let errText = msg.error.message || 'Unknown error';
        if (msg.error.data && msg.error.data.details) {
          errText += ': ' + msg.error.data.details;
        }
        if (msg.error.code) {
          errText += ' [' + msg.error.code + ']';
        }
        turns.push({type: 'error', text: errText});
        continue;
      }
      if (msg.result && msg.result.agentInfo) {
        const info = msg.result.agentInfo;
        headerTitle.textContent = info.title || info.name || 'ACP';
      }
      if (msg.result && msg.result.sessionId) {
        sessionId = msg.result.sessionId;
        sendBtn.disabled = false;
        if (msg.result.cwd) projectCwd = msg.result.cwd;
        if (msg.result.modes) {
          availableModes = msg.result.modes.availableModes || [];
          currentMode = msg.result.modes.currentModeId || 'default';
          if (availableModes.length > 0) {
            modeBtn.style.display = '';
            updateModeBtn();
          }
        }
      }
      if (msg.result && msg.result.stopReason) {
        replayEnded = true;
        // Flush pending agent text as a turn
        if (pendingText) {
          turns.push({type: 'agent', text: pendingText});
          pendingText = '';
        }
      }
      continue;
    }

    // Notifications
    if (msg.method === 'acp-multiplex/meta' && msg.params && msg.params.name) {
      headerTitle.textContent = msg.params.name;
      currentBufferName = msg.params.name;
      document.getElementById('kill-btn').style.display = '';
      continue;
    }
    // Permission requests from agent (reverse calls)
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      if (pendingText) {
        turns.push({type: 'agent', text: pendingText});
        pendingText = '';
      }
      turns.push({type: 'permission', msg: msg});
      continue;
    }
    if (msg.method !== 'session/update' || !msg.params) continue;
    const update = msg.params.update;
    if (!update) continue;
    if (!sessionId && msg.params.sessionId) {
      sessionId = msg.params.sessionId;
      sendBtn.disabled = false;
    }

    const kind = update.sessionUpdate;
    const text = (update.content && update.content.text) || update.text || '';

    switch (kind) {
      case 'agent_message_chunk':
        pendingText += text;
        break;
      case 'tool_call': {
        const tcId = update.toolCallId;
        // Check if we already have a turn for this toolCallId — update it instead of adding duplicate
        let found = false;
        if (tcId) {
          for (let j = turns.length - 1; j >= 0; j--) {
            if (turns[j].type === 'tool' && turns[j].toolCallId === tcId) {
              turns[j].toolName = toolName(update);
              turns[j].toolType = toolType(update) || turns[j].toolType;
              turns[j].toolParams = update.rawInput || null;
              found = true;
              break;
            }
          }
        }
        if (!found) {
          if (pendingText) {
            turns.push({type: 'agent', text: pendingText});
            pendingText = '';
          }
          turns.push({type: 'tool', toolCallId: tcId, toolName: toolName(update), toolType: toolType(update), toolParams: update.rawInput || null});
        }
        break;
      }
      case 'tool_call_update': {
        // Merge into the parent tool turn instead of creating a separate turn.
        // This prevents orphaned tool_updates when the INITIAL_TURNS window
        // or load-more batches split a tool from its update.
        const tcuId = update.toolCallId;
        let merged = false;
        if (tcuId) {
          for (let j = turns.length - 1; j >= 0; j--) {
            if (turns[j].type === 'tool' && turns[j].toolCallId === tcuId) {
              if (update.status) turns[j].toolStatus = update.status;
              const out = toolOutputText(update);
              if (out) turns[j].toolContent = out;
              // Merge rawInput/title/kind from updates (e.g. Bash gets command after initial "Terminal")
              if (update.rawInput && Object.keys(update.rawInput).length > 0) {
                turns[j].toolParams = update.rawInput;
              }
              if (update.title) turns[j].toolName = update.title;
              if (toolType(update)) turns[j].toolType = toolType(update);
              if (update.kind) turns[j].toolKind = update.kind;
              merged = true;
              break;
            }
          }
        }
        if (!merged) {
          // Fallback: no matching tool turn found, append as standalone
          turns.push({type: 'tool_update', toolStatus: update.status || 'completed', toolContent: toolOutputText(update)});
        }
        break;
      }
      case 'user_message_chunk':
        if (pendingText) {
          turns.push({type: 'agent', text: pendingText});
          pendingText = '';
        }
        if (text) turns.push({type: 'user', text});
        break;
      case 'turn_complete':
        replayEnded = true;
        setProcessing(false);
        break;
      case 'available_commands_update':
        replayEnded = true;
        if (sessionId) sendBtn.disabled = false;
        setProcessing(false);
        break;
      case 'current_mode_update':
        if (update.currentModeId) {
          currentMode = update.currentModeId;
          updateModeBtn();
        }
        break;
    }
  }
  // Flush any remaining agent text
  if (pendingText) {
    turns.push({type: 'agent', text: pendingText});
  }

  // Detect if agent is still processing at end of replay
  // (no stopReason response and no available_commands_update seen at the end)
  if (!replayEnded) {
    setProcessing(true);
  } else {
    playNotification();
  }

  // If there's a pending permission in replay, mark it interactive.
  // The cache only stores a permission while it's unanswered, so any
  // permission found here is guaranteed to need interaction.
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].type === 'permission') {
      turns[i].interactive = true;
      setProcessing(true);
      playNotification();
      break;
    }
  }

  // Store all turns; render only the last chunk
  allReplayTurns = turns;
  const INITIAL_TURNS = 20;
  renderedTurnStart = Math.max(0, turns.length - INITIAL_TURNS);
  const renderTurns = turns.slice(renderedTurnStart);

  renderTurnBatch(renderTurns, false);

  // Show "load more" hint if there's older history
  if (renderedTurnStart > 0) {
    showLoadMoreHint();
  }

  scrollToBottom();
}

function handleMessage(msg) {
  // Response
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    if (msg.error) {
      let errText = msg.error.message || 'Unknown error';
      if (msg.error.data && msg.error.data.details) {
        errText += ': ' + msg.error.data.details;
      }
      if (msg.error.code) {
        errText += ' [' + msg.error.code + ']';
      }
      addErrorMsg(errText);
      setProcessing(false);
      return;
    }

    if (msg.result && msg.result.agentInfo) {
      const info = msg.result.agentInfo;
      headerTitle.textContent = info.title || info.name || 'ACP';
    }

    if (msg.result && msg.result.sessionId) {
      sessionId = msg.result.sessionId;
      sendBtn.disabled = false;
      // Extract cwd and modes from session/new response
      if (msg.result.cwd) {
        projectCwd = msg.result.cwd;
      }
      if (msg.result.modes) {
        availableModes = msg.result.modes.availableModes || [];
        currentMode = msg.result.modes.currentModeId || 'default';
        if (availableModes.length > 0) {
          modeBtn.style.display = '';
          updateModeBtn();
        }
      }
    }

    if (msg.result && msg.result.stopReason) {
      currentAgentMsg = null;
      setProcessing(false);
      // Mark last sent user message as delivered
      if (lastSentMsg) { markSent(lastSentMsg); lastSentMsg = null; }
      flushMessageQueue();
    }
    return;
  }

  // Buffer name from acp-multiplex
  if (msg.method === 'acp-multiplex/meta' && msg.params && msg.params.name) {
    headerTitle.textContent = msg.params.name;
    currentBufferName = msg.params.name;
    document.getElementById('kill-btn').style.display = '';
    return;
  }

  // Notification: session/update
  if (msg.method === 'session/update' && msg.params) {
    const update = msg.params.update;
    if (!update) return;

    if (!sessionId && msg.params.sessionId) {
      sessionId = msg.params.sessionId;
      sendBtn.disabled = false;
    }

    const kind = update.sessionUpdate;
    const text = (update.content && update.content.text) || update.text || '';

    switch (kind) {
      case 'agent_message_chunk':
        setProcessing(true);
        if (!currentAgentMsg) {
          currentAgentMsg = addAgentMsg('');
        }
        currentAgentMsg._text += text;
        updateAgentMsg(currentAgentMsg, currentAgentMsg._text);
        break;

      case 'agent_thought_chunk': {
        const d = document.createElement('div');
        d.className = 'msg thought';
        d.textContent = text;
        messagesEl.appendChild(d);
        if (isAtBottom) scrollToBottom();
        break;
      }

      case 'tool_call': {
        currentAgentMsg = null;
        setProcessing(true);
        const tcId = update.toolCallId;
        // If we already have an element for this toolCallId, update it in place
        const existing = tcId && messagesEl._toolCalls && messagesEl._toolCalls[tcId];
        if (existing) {
          updateToolInfo(existing, toolName(update), update.rawInput || null, toolType(update));
          messagesEl._lastTool = existing;
        } else {
          const el = addToolMsg(toolName(update), update.rawInput || null, toolType(update));
          messagesEl._lastTool = el;
          if (tcId) {
            if (!messagesEl._toolCalls) messagesEl._toolCalls = {};
            messagesEl._toolCalls[tcId] = el;
          }
          // Interactive tool call (e.g. Plan exit)
          if (update.kind === 'switch_mode' && update.rawInput && update.rawInput.plan) {
            addPlanApprovalButtons(el);
            playNotification();
          }
        }
        break;
      }

      case 'tool_call_update': {
        const tcuId = update.toolCallId;
        const toolEl = (tcuId && messagesEl._toolCalls && messagesEl._toolCalls[tcuId]) || messagesEl._lastTool;
        if (toolEl) {
          if (update.title || (update.rawInput && Object.keys(update.rawInput).length > 0)) {
            updateToolInfo(toolEl, update.title || toolEl.querySelector('.tool-name')?.textContent || '?', update.rawInput || null, toolType(update) || null);
          }
          updateToolStatus(toolEl, update.status || 'completed', toolOutputText(update));
          // If it becomes interactive in an update
          if (update.kind === 'switch_mode' && update.rawInput && update.rawInput.plan && !update.status) {
            if (!toolEl.querySelector('.perm-options')) {
              addPlanApprovalButtons(toolEl);
              playNotification();
            }
          }
        }
        break;
      }

      case 'user_message_chunk':
        currentAgentMsg = null;
        if (text) addUserMsg(text, 'sent');
        break;

      case 'turn_complete':
        if (autoSpeakEnabled && currentAgentMsg) {
          speakMsg(currentAgentMsg, stripMarkdownForSpeech(currentAgentMsg._text));
        }
        currentAgentMsg = null;
        setProcessing(false);
        if (lastSentMsg) { markSent(lastSentMsg); lastSentMsg = null; }
        playNotification();
        flushMessageQueue();
        break;

      case 'available_commands_update':
        if (sessionId) sendBtn.disabled = false;
        setProcessing(false);
        playNotification();
        flushMessageQueue();
        break;

      case 'current_mode_update':
        if (update.currentModeId) {
          currentMode = update.currentModeId;
          updateModeBtn();
        }
        break;
    }
    return;
  }

  // Reverse call from agent
  if (msg.method === 'session/request_permission' && msg.id !== undefined) {
    addPermissionMsg(msg, true);
    playNotification();
    return;
  }
  if (msg.method && msg.id !== undefined) {
    // Unknown reverse call — respond with error so agent doesn't hang
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32601, message: 'Method not supported: ' + msg.method }
    }));
    addSystemMsg('Unsupported: ' + msg.method);
  }
}

// --- User interaction ---

let lastSentMsg = null;
let messageQueue = [];

function sendPrompt() {
  const text = promptEl.value.trim();
  if (!text || !sessionId) return;

  promptEl.value = '';
  promptEl.style.height = 'auto';

  if (processing) {
    // Queue message for when agent finishes
    messageQueue.push(text);
    addUserMsg(text, 'queued');
    return;
  }

  sendPromptText(text);
}

function sendPromptText(text) {
  currentAgentMsg = null;
  lastSentMsg = addUserMsg(text, 'sending');
  setProcessing(true);

  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: nextId++,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text }] }
  }));
}

function flushMessageQueue() {
  if (messageQueue.length > 0) {
    const text = messageQueue.shift();
    // Message was already displayed when queued, just send it
    currentAgentMsg = null;
    setProcessing(true);
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text }] }
    }));
  }
}

function cancelPrompt() {
  if (!sessionId) return;
  // Cancel all pending permission requests
  for (const p of pendingPermissions) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: p.id,
      result: { outcome: { outcome: 'cancelled' } }
    }));
    p.element.classList.add('resolved');
    const btns = p.element.querySelectorAll('.perm-btn');
    btns.forEach(b => { b.disabled = true; });
  }
  pendingPermissions = [];
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/cancel',
    params: { sessionId }
  }));
  messageQueue = [];
  setProcessing(false);
  addSystemMsg('Cancelled');
}

promptEl.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
};

promptEl.oninput = () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px';
};

// --- File browser ---

const fbEl = document.getElementById('file-browser');
const fbListEl = document.getElementById('fb-list');
const fbPathEl = document.getElementById('fb-path');
const fbViewerEl = document.getElementById('fb-viewer');
const fbvPathEl = document.getElementById('fbv-path');
const fbvContentEl = document.getElementById('fbv-content');
const fbHiddenToggle = document.getElementById('fb-hidden-toggle');

let fbCurrentPath = '';
let fbHistory = [];
let fbShowHidden = false;

const FB_EXT_ICONS = {
  js: '{}', ts: '{}', tsx: '{}', jsx: '{}',
  py: '#', rb: '#', go: '#', rs: '#', c: '#', h: '#', cpp: '#',
  json: '{}', yaml: '~', yml: '~', toml: '~',
  md: 'M', txt: 'T', org: 'O',
  sh: '$', bash: '$', zsh: '$',
  html: '<>', css: '#', svg: '<>',
  el: 'L', clj: 'L', lisp: 'L',
};

function fbFileIcon(name, isDir) {
  if (isDir) return '\uD83D\uDCC1';
  const ext = name.split('.').pop().toLowerCase();
  return FB_EXT_ICONS[ext] || '\uD83D\uDCC4';
}

function fbFormatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function openFileBrowser() {
  if (!projectCwd) return;
  const startPath = projectCwd;
  fbHistory = [];
  await fbNavigate(startPath);
  fbEl.classList.add('visible');
}

function closeFileBrowser() {
  fbEl.classList.remove('visible');
}

function closeFileViewer() {
  fbViewerEl.classList.remove('visible');
}

async function fbNavigate(dirPath) {
  fbCurrentPath = dirPath;
  fbPathEl.textContent = shortPath(dirPath);
  fbListEl.innerHTML = '<div style="padding:16px;color:#888">Loading...</div>';

  try {
    const resp = await fetch(basePath + '/files/list', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ path: dirPath, showHidden: fbShowHidden })
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    fbCurrentPath = data.path;
    fbPathEl.textContent = shortPath(data.path);
    renderFileList(data.files || []);
  } catch (err) {
    fbListEl.innerHTML = '<div style="padding:16px;color:#F44336">' + escHtml(err.message) + '</div>';
  }
}

function renderFileList(files) {
  fbListEl.innerHTML = '';
  if (files.length === 0) {
    fbListEl.innerHTML = '<div style="padding:16px;color:#666;text-align:center">Empty directory</div>';
    return;
  }
  for (const f of files) {
    const d = document.createElement('div');
    d.className = 'fb-item' + (f.isDir ? ' dir' : '');
    const icon = fbFileIcon(f.name, f.isDir);
    const sizeStr = f.isDir ? '' : fbFormatSize(f.size || 0);
    d.innerHTML =
      '<span class="fb-icon">' + icon + '</span>' +
      '<span class="fb-name">' + escHtml(f.name) + '</span>' +
      '<span class="fb-size">' + sizeStr + '</span>';
    if (f.isDir) {
      d.onclick = () => {
        fbHistory.push(fbCurrentPath);
        fbNavigate(fbCurrentPath + '/' + f.name);
      };
    } else {
      d.onclick = () => fbOpenFile(fbCurrentPath + '/' + f.name);
    }
    fbListEl.appendChild(d);
  }
}

function fbNavigateUp() {
  if (fbHistory.length > 0) {
    fbNavigate(fbHistory.pop());
  } else if (fbCurrentPath !== '/') {
    const parent = fbCurrentPath.replace(/\/[^/]+$/, '') || '/';
    fbNavigate(parent);
  }
}

function fbToggleHidden() {
  fbShowHidden = !fbShowHidden;
  fbHiddenToggle.classList.toggle('active', fbShowHidden);
  fbNavigate(fbCurrentPath);
}

async function fbOpenFile(filePath) {
  fbvPathEl.textContent = shortPath(filePath);
  fbvContentEl.textContent = 'Loading...';
  fbViewerEl.classList.add('visible');

  try {
    const resp = await fetch(basePath + '/files/read', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ path: filePath })
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    fbvContentEl.textContent = data.content;
  } catch (err) {
    fbvContentEl.textContent = 'Error: ' + err.message;
  }
}

// --- Navigator ---

let discoverMode = false;
let sortMode = localStorage.getItem('acp-sort') || 'project'; // 'project' or 'recent'
let lastSessions = [];

function getLastViewed(pid) {
  return parseInt(localStorage.getItem('acp-viewed-' + pid) || '0', 10);
}
function markViewed(pid) {
  localStorage.setItem('acp-viewed-' + pid, String(Math.floor(Date.now() / 1000)));
}
function isUnread(session) {
  if (!session.lastActivity) return false;
  return session.lastActivity > getLastViewed(session.pid);
}
function toggleSort() {
  sortMode = sortMode === 'project' ? 'recent' : 'project';
  localStorage.setItem('acp-sort', sortMode);
  document.getElementById('sort-btn').textContent = sortMode === 'project' ? 'Recent' : 'Project';
  renderSessions(lastSessions);
}

function timeAgo(ts) {
  if (!ts) return '';
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60) return 'now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h';
  return Math.floor(secs / 86400) + 'd';
}

async function loadSessions() {
  navListEl.innerHTML = '<div id="nav-empty">Loading...</div>';
  try {
    const resp = await fetch(basePath + '/api/sessions', { method: 'POST' });
    if (!resp.ok) {
      // Not in discover mode -- single socket, go straight to chat
      discoverMode = false;
      showChat();
      connect();
      return;
    }
    const data = await resp.json();
    const sessions = data.sessions || [];
    if (sessions.length === 0) {
      navListEl.innerHTML = '<div id="nav-empty">No active sessions</div>';
      return;
    }
    discoverMode = true;
    renderSessions(sessions);
  } catch (err) {
    // /api/sessions not available -- single socket mode
    discoverMode = false;
    showChat();
    connect();
  }
}

function renderSessions(sessions) {
  lastSessions = sessions;
  navListEl.innerHTML = '';
  document.getElementById('sort-btn').textContent = sortMode === 'project' ? 'Recent' : 'Project';

  if (sortMode === 'recent') {
    // Flat list sorted by lastActivity descending
    const sorted = [...sessions].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    for (const s of sorted) {
      navListEl.appendChild(makeSessionCard(s, s.bufferName || sessionDisplayName(s)));
    }
    return;
  }

  // Group by project
  const groups = new Map();
  for (const s of sessions) {
    const proj = s.project || 'unknown';
    if (!groups.has(proj)) groups.set(proj, []);
    groups.get(proj).push(s);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  for (const proj of sortedKeys) {
    const group = groups.get(proj);
    const groupEl = document.createElement('div');
    groupEl.className = 'project-group';

    const header = document.createElement('div');
    header.className = 'project-header';
    const headerLabel = document.createElement('span');
    headerLabel.textContent = proj;
    header.appendChild(headerLabel);
    const addBtn = document.createElement('button');
    addBtn.className = 'ph-add';
    addBtn.textContent = '+';
    addBtn.onclick = (e) => { e.stopPropagation(); spawnInProject(group[0].cwd); };
    header.appendChild(addBtn);
    groupEl.appendChild(header);

    for (let i = 0; i < group.length; i++) {
      const s = group[i];
      const suffix = group.length > 1 ? (i === 0 ? '' : '<' + (i + 1) + '>') : '';
      const name = s.bufferName
        || ((s.title || 'Claude Code') + ' Agent @ ' + proj + suffix);
      groupEl.appendChild(makeSessionCard(s, name));
    }

    navListEl.appendChild(groupEl);
  }
}

function sessionDisplayName(s) {
  const proj = s.project || 'unknown';
  return (s.title || 'Claude Code') + ' Agent @ ' + proj;
}

function makeSessionCard(s, name) {
  const unread = isUnread(s);
  const isSelected = selectedSessions.has(s.bufferName);
  const d = document.createElement('div');
  d.className = 'session-card' + (unread ? ' unread' : '') + (selecting ? ' selecting' : '') + (isSelected ? ' selected' : '');
  d.innerHTML =
    '<div class="sc-checkbox"></div>' +
    '<div class="sc-dot"></div>' +
    '<div class="sc-info">' +
      '<div class="sc-name">' + escHtml(name) + '</div>' +
      (s.cwd ? '<div class="sc-path">' + escHtml(shortPath(s.cwd)) + '</div>' : '') +
      (s.lastActivity ? '<div class="sc-time">' + timeAgo(s.lastActivity) + '</div>' : '') +
    '</div>';
  if (s.bufferName) {
    const del = document.createElement('button');
    del.className = 'sc-delete';
    del.textContent = '\u00d7';
    del.onclick = (e) => { e.stopPropagation(); killSessionByName(s.bufferName); };
    if (selecting) del.style.display = 'none';
    d.appendChild(del);
  }
  d.onclick = () => {
    if (selecting) {
      if (s.bufferName) toggleSessionSelection(s.bufferName, d);
    } else {
      selectSession(s);
    }
  };
  return d;
}

function toggleSessionSelection(bufferName, el) {
  if (selectedSessions.has(bufferName)) {
    selectedSessions.delete(bufferName);
    el.classList.remove('selected');
  } else {
    selectedSessions.add(bufferName);
    el.classList.add('selected');
  }
  updateBatchButtons();
}

function toggleSelecting() {
  selecting = !selecting;
  if (!selecting) selectedSessions.clear();
  document.getElementById('select-btn').textContent = selecting ? 'Cancel' : 'Select';
  document.getElementById('batch-delete-btn').style.display = selecting ? '' : 'none';
  document.getElementById('spawn-btn').style.display = selecting ? 'none' : '';
  updateBatchButtons();
  renderSessions(lastSessions);
}

function updateBatchButtons() {
  const btn = document.getElementById('batch-delete-btn');
  btn.disabled = selectedSessions.size === 0;
  btn.textContent = selectedSessions.size > 0 ? 'Delete (' + selectedSessions.size + ')' : 'Delete';
}

async function batchDelete() {
  if (selectedSessions.size === 0) return;
  if (!window.confirm('Kill ' + selectedSessions.size + ' selected sessions?')) return;

  const bufferNames = [...selectedSessions];
  try {
    const resp = await fetch(basePath + '/api/kill-batch', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ bufferNames })
    });
    const data = await resp.json();
    if (data.error) {
      alert('Batch kill failed: ' + data.error);
    }
    selectedSessions.clear();
    toggleSelecting();
    loadSessions();
  } catch (err) {
    alert('Batch kill failed: ' + err.message);
  }
}

function selectSession(session) {
  speechSynthesis.cancel();
  currentSpeakEl = null;
  markViewed(session.pid);
  currentSockPid = session.pid;
  messagesEl.innerHTML = '';
  currentAgentMsg = null;
  sessionId = null;
  projectCwd = session.cwd || null;
  currentBufferName = session.bufferName || null;
  document.getElementById('kill-btn').style.display = currentBufferName ? '' : 'none';
  availableModes = [];
  allReplayTurns = [];
  pendingPermissions = [];
  renderedTurnStart = 0;
  sendBtn.disabled = true;
  setProcessing(false);

  showChat();
  connect(String(session.pid));
}

function showChat() {
  navigatorEl.classList.add('hidden');
  chatViewEl.classList.add('visible');
  if (discoverMode) {
    backBtn.style.display = 'block';
  }
}

function showNavigator() {
  speechSynthesis.cancel();
  currentSpeakEl = null;
  chatViewEl.classList.remove('visible');
  navigatorEl.classList.remove('hidden');
  // Disconnect current websocket
  if (ws) {
    ws.onclose = null; // prevent reconnect
    ws.close();
    ws = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  loadSessions();
}

function navigateBack() {
  showNavigator();
}

async function spawnAgent() {
  // Get a cwd to spawn into — use first session's cwd or prompt
  let cwd = '';
  if (lastSessions.length > 0) {
    // Pick from existing project cwds
    const cwds = [...new Set(lastSessions.map(s => s.cwd).filter(Boolean))];
    if (cwds.length > 0) {
      const choice = window.prompt(
        'Project directory:\n' + cwds.map((c, i) => (i + 1) + '. ' + shortPath(c)).join('\n') +
        '\n\nEnter number or full path:',
        cwds.length === 1 ? '1' : '');
      if (!choice) return;
      const num = parseInt(choice);
      cwd = (num >= 1 && num <= cwds.length) ? cwds[num - 1] : choice;
    }
  }
  if (!cwd) {
    cwd = window.prompt('Project directory (full path):');
    if (!cwd) return;
  }

  const name = window.prompt('Agent name:');
  if (!name) return;

  const task = window.prompt('Initial task (optional):') || '';

  try {
    const resp = await fetch(basePath + '/api/spawn', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ cwd, name, task })
    });
    const data = await resp.json();
    if (data.error) {
      alert('Spawn failed: ' + data.error);
      return;
    }
    pollForNewSession();
  } catch (err) {
    alert('Spawn failed: ' + err.message);
  }
}

async function killSession() {
  if (!currentBufferName) {
    alert('No buffer name available for this session');
    return;
  }
  if (!window.confirm('Kill session "' + currentBufferName + '"?')) return;

  try {
    const resp = await fetch(basePath + '/api/kill', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ bufferName: currentBufferName })
    });
    const data = await resp.json();
    if (data.error) {
      alert('Kill failed: ' + data.error);
      return;
    }
    showNavigator();
  } catch (err) {
    alert('Kill failed: ' + err.message);
  }
}

async function spawnInProject(cwd) {
  const name = window.prompt('Agent name:');
  if (!name) return;
  const task = window.prompt('Initial task (optional):') || '';
  try {
    const resp = await fetch(basePath + '/api/spawn', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ cwd, name, task })
    });
    const data = await resp.json();
    if (data.error) { alert('Spawn failed: ' + data.error); return; }
    pollForNewSession();
  } catch (err) { alert('Spawn failed: ' + err.message); }
}

function pollForNewSession() {
  const before = lastSessions.length;
  let attempts = 0;
  const poll = () => {
    if (attempts++ > 10) return;
    loadSessions().then(() => {
      if (lastSessions.length <= before) setTimeout(poll, 1000);
    });
  };
  setTimeout(poll, 1000);
}

async function killSessionByName(bufferName) {
  if (!window.confirm('Kill "' + bufferName + '"?')) return;
  try {
    const resp = await fetch(basePath + '/api/kill', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ bufferName })
    });
    const data = await resp.json();
    if (data.error) { alert('Kill failed: ' + data.error); return; }
    setTimeout(loadSessions, 500);
  } catch (err) { alert('Kill failed: ' + err.message); }
}

// Wire up event listeners (no inline onclick for CSP compatibility)
document.getElementById('sort-btn').addEventListener('click', toggleSort);
document.getElementById('spawn-btn').addEventListener('click', spawnAgent);
document.getElementById('select-btn').addEventListener('click', toggleSelecting);
document.getElementById('batch-delete-btn').addEventListener('click', batchDelete);
document.getElementById('refresh-btn').addEventListener('click', loadSessions);
(function() {
  const panel = document.getElementById('settings-panel');
  const slider = document.getElementById('tts-rate-slider');
  const rateVal = document.getElementById('tts-rate-value');
  slider.value = ttsRate;
  rateVal.textContent = ttsRate.toFixed(1) + '×';
  document.getElementById('settings-btn').addEventListener('click', () => {
    panel.classList.toggle('open');
  });
  slider.addEventListener('input', () => {
    ttsRate = parseFloat(slider.value);
    rateVal.textContent = ttsRate.toFixed(1) + '×';
    localStorage.setItem('ttsRate', ttsRate);
  });
})();
document.getElementById('back-btn').addEventListener('click', navigateBack);
document.getElementById('mode-btn').addEventListener('click', cycleMode);
document.getElementById('files-btn').addEventListener('click', openFileBrowser);
document.getElementById('kill-btn').addEventListener('click', killSession);
document.getElementById('fb-back').addEventListener('click', fbNavigateUp);
document.getElementById('fb-hidden-toggle').addEventListener('click', fbToggleHidden);
document.getElementById('fb-close').addEventListener('click', closeFileBrowser);
document.getElementById('fbv-back').addEventListener('click', closeFileViewer);
document.getElementById('scroll-btn').addEventListener('click', scrollToBottom);
document.getElementById('send').addEventListener('click', sendPrompt);
document.getElementById('stop-btn').addEventListener('click', cancelPrompt);

// Start: try loading sessions (discover mode), fall back to direct connect
loadSessions();
