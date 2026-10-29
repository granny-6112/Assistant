// Assistant for Claude: a read-only MCP server that lets the Claude desktop app
// list, search and read the conversations the Assistant bar saves as JSON
// files (text only) in %APPDATA%\Assistant\history.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('fs');
const os = require('os');
const path = require('path');

function historyDir() {
  const configured = process.env.ASSISTANT_HISTORY_DIR;
  if (configured && !configured.includes('${')) return configured;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Assistant', 'history');
}

function loadAll() {
  const dir = historyDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (c && Array.isArray(c.turns)) out.push(c);
    } catch {
      // skip a file that's mid-write or damaged
    }
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function summaryLine(c) {
  const questions = c.turns.filter((t) => t.role === 'user').length;
  return `- ${c.id} · ${when(c.updatedAt)} · ${questions} question${questions === 1 ? '' : 's'} · "${c.title}"`;
}

function render(c) {
  const lines = [`# ${c.title}`, `Conversation ${c.id}, ${when(c.startedAt)} to ${when(c.updatedAt)}`, ''];
  for (const t of c.turns) {
    if (t.role === 'user') {
      const extra = [t.mode === 'agent' ? 'agent task' : null, ...(t.attachments || [])].filter(Boolean);
      lines.push(`**You** (${when(t.at)}${extra.length ? `, ${extra.join(', ')}` : ''}):`, t.text, '');
    } else {
      lines.push(`**Assistant** (${t.model || 'model'}):`, t.text, '');
    }
  }
  return lines.join('\n');
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const empty = () => text(`No saved Assistant conversations found in ${historyDir()}. In Assistant, check Settings → General → "Save conversations on this PC".`);

const server = new McpServer({ name: 'assistant-for-claude', version: '1.0.0' });

server.registerTool('list_assistant_conversations', {
  title: 'List Assistant conversations',
  description: 'List the most recent conversations the user had in the Assistant bar (a screen assistant on their PC), newest first, with ids for read_assistant_conversation. Use when the user refers to something they asked or did in Assistant.',
  inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('How many to list (default 20)') },
  annotations: { readOnlyHint: true },
}, async ({ limit = 20 }) => {
  const all = loadAll();
  if (!all.length) return empty();
  return text(`Assistant conversations (newest first):\n${all.slice(0, limit).map(summaryLine).join('\n')}`);
});

server.registerTool('search_assistant_conversations', {
  title: 'Search Assistant conversations',
  description: 'Find Assistant conversations whose questions or answers contain all the given words (case-insensitive). Returns matching snippets and conversation ids.',
  inputSchema: {
    query: z.string().min(1).describe('Words or a phrase to look for'),
    limit: z.number().int().min(1).max(50).optional().describe('Most conversations to return (default 10)'),
  },
  annotations: { readOnlyHint: true },
}, async ({ query, limit = 10 }) => {
  const all = loadAll();
  if (!all.length) return empty();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const c of all) {
    const haystack = c.turns.map((t) => t.text).join('\n').toLowerCase();
    if (!words.every((w) => haystack.includes(w))) continue;
    const snippets = [];
    for (const t of c.turns) {
      const lower = t.text.toLowerCase();
      const i = lower.indexOf(words[0]);
      if (i < 0) continue;
      const start = Math.max(0, i - 80);
      snippets.push(`  ${t.role === 'user' ? 'You' : 'Assistant'}: …${t.text.slice(start, i + 160).replace(/\s+/g, ' ')}…`);
      if (snippets.length >= 3) break;
    }
    hits.push(`${summaryLine(c)}\n${snippets.join('\n')}`);
    if (hits.length >= limit) break;
  }
  return text(hits.length ? `Matches for "${query}":\n\n${hits.join('\n\n')}` : `No Assistant conversations mention "${query}".`);
});

server.registerTool('read_assistant_conversation', {
  title: 'Read an Assistant conversation',
  description: 'Read a full Assistant conversation (every question and answer, text only). Pass an id from list or search, or "latest" for the most recent one.',
  inputSchema: { id: z.string().min(1).describe('Conversation id, or "latest"') },
  annotations: { readOnlyHint: true },
}, async ({ id }) => {
  const all = loadAll();
  if (!all.length) return empty();
  const c = id === 'latest' ? all[0] : all.find((x) => x.id === id);
  return text(c ? render(c) : `No Assistant conversation with id ${id}. Use list_assistant_conversations to see ids.`);
});

server.connect(new StdioServerTransport()).catch((err) => {
  console.error(err);
  process.exit(1);
});
