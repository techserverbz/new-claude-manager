#!/usr/bin/env node
// claude-manager MCP server — gives every Claude chat launched by Christopher
// OS the ability to SHARE CONTEXT with its sibling chats in the same project.
//
// Two halves (the hybrid distilled from the cross-tool research):
//   LIVE RELAY  (simple-code-gui's orchestrator pattern): list sibling chats,
//               read their live terminal output, send/broadcast input.
//   SHARED MEMORY (claude-os / claude-flow pattern): save + search a persisted
//               per-project memory that every chat reads AND writes.
//
// Transport: hand-rolled newline-delimited JSON-RPC 2.0 over stdio — zero
// dependencies, same approach simple-code-gui ships. All real work happens in
// the Christopher OS server (port 4020) via localhost HTTP; this script is a
// thin proxy that adds the calling chat's cwd so every tool is automatically
// scoped to the right project (the claude CLI spawns MCP servers with its own
// cwd — the claude-flow cwd-scoping trick).
//
// Registration (idempotent, done by the app / once by hand):
//   claude mcp add --scope user claude-manager -- node "<abs path to this file>"

import readline from 'node:readline'

const PORT = 4040
const API = `http://127.0.0.1:${PORT}`
// claude spawns stdio MCP servers in its own working directory; fall back to
// the hook-style env var if a future version changes that.
const CWD = process.env.CLAUDE_PROJECT_DIR || process.cwd()
// Self-identity, injected by the 9b server when it spawns the parent claude.
// Lets the server exclude THIS chat from broadcasts and reject self-messages,
// and tags every relayed message with its origin (the provenance envelope).
const SELF_KEY = process.env.COS_SESSION_KEY || ''

const SERVER_INFO = { name: 'claude-manager', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

// ---------------------------------------------------------------------------
// Tools — descriptions are the discoverability layer: they must make Claude
// reach for these when the user says "the other chat/window" or "remember".
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_chats',
    description:
      'List the OTHER live Claude chats (sibling terminals/windows) running in this same Christopher OS project right now. Use this first whenever the user refers to "the other chat", "the other window", "my other terminal", or you need to coordinate work across chats. Returns each sibling\'s sessionId and title.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_chat',
    description:
      'Read the recent live terminal output of a sibling Claude chat in this project (what that chat is doing/saying right now). Use after list_chats to check on another chat\'s progress or see what the user discussed there. Returns the last N lines, ANSI-stripped.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The sibling session id from list_chats (use "new" for an unsaved fresh session).' },
        lines: { type: 'number', description: 'How many trailing lines to read (default 100, max 500).' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_to_chat',
    description:
      'Type a message into a sibling Claude chat\'s terminal and submit it — the sibling chat will receive it as user input and respond. Use to delegate a task to or ask a question of another chat. Never target your own session, and do not tell the receiving chat to broadcast (that creates loops).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The sibling session id from list_chats.' },
        text: { type: 'string', description: 'The message/prompt to send to that chat.' },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'broadcast_to_chats',
    description:
      'Send one message to EVERY live sibling chat in this project at once (each receives it as user input). Use sparingly — e.g. "stop current work", or announcing a decision all chats must know. Never instruct recipients to broadcast back (loop risk).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send to all sibling chats.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_save',
    description:
      'Save a note to this project\'s SHARED MEMORY — persisted knowledge that every chat (current and future) in this project can search. Save decisions, conventions, gotchas, task hand-offs, and anything the user says to "remember" or that siblings/future chats will need. Keep each note self-contained.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact/decision/note to persist (self-contained, 1-4 sentences).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase topic tags (e.g. ["auth","decision"]).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description:
      'Search this project\'s SHARED MEMORY (notes saved by ANY chat in this project, past or present). Use before starting work on a topic, and whenever the user asks "did we decide/discuss X" or context from another chat might exist.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for.' },
        limit: { type: 'number', description: 'Max results (default 10).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_recent',
    description:
      'List the most recent entries in this project\'s SHARED MEMORY — what the chats of this project have learned/decided lately. Useful at the start of a task to pick up where sibling chats left off.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries (default 10).' },
      },
      additionalProperties: false,
    },
  },
]

// ---------------------------------------------------------------------------
// HTTP helpers (the 9b server does the real work)
// ---------------------------------------------------------------------------

// Every call carries cwd (directory scoping) AND self (identity scoping): the
// server uses self's sessionId to widen the sibling set to this chat's project
// group, whose members may live in entirely different directories.
async function apiGet(path, params) {
  const qs = new URLSearchParams({ cwd: CWD, self: SELF_KEY, ...params })
  const res = await fetch(`${API}${path}?${qs}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

async function apiPost(path, payload) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: CWD, self: SELF_KEY, ...payload }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

function fmtMemory(entries) {
  if (!entries.length) return 'No shared memory entries found.'
  return entries
    .map((e) => {
      const when = String(e.ts || '').slice(0, 16).replace('T', ' ')
      const tags = e.tags && e.tags.length ? ` [${e.tags.join(', ')}]` : ''
      return `- (${when})${tags} ${e.text}`
    })
    .join('\n')
}

async function callTool(name, args) {
  const a = args && typeof args === 'object' ? args : {}
  switch (name) {
    case 'list_chats': {
      const { project, sessions } = await apiGet('/api/orchestrator/context')
      if (!sessions.length) {
        return `No other live chats in project "${project.name}" right now. (A sibling chat appears here once its terminal is open in Christopher OS.)`
      }
      const rows = sessions.map(
        (s) => `- sessionId: ${s.sessionId ?? 'new'} — "${s.title}"${s.attached ? ' (on screen)' : ''}`,
      )
      return `Live chats in project "${project.name}":\n${rows.join('\n')}`
    }
    case 'read_chat': {
      const { output } = await apiGet('/api/orchestrator/output', {
        sessionId: String(a.sessionId || ''),
        lines: String(Math.min(Number(a.lines) || 100, 500)),
      })
      return output || '(no output yet)'
    }
    case 'send_to_chat': {
      await apiPost('/api/orchestrator/input', {
        sessionId: String(a.sessionId || ''),
        text: String(a.text || ''),
        from: SELF_KEY || undefined,
      })
      return `Sent to chat ${a.sessionId}. It will respond in its own window — use read_chat in a moment to see its reply.`
    }
    case 'broadcast_to_chats': {
      const { sentTo } = await apiPost('/api/orchestrator/broadcast', {
        text: String(a.text || ''),
        from: SELF_KEY || undefined,
      })
      return sentTo.length ? `Broadcast sent to ${sentTo.length} chat(s): ${sentTo.join(', ')}` : 'No live sibling chats to broadcast to.'
    }
    case 'memory_save': {
      const { entry } = await apiPost('/api/orchestrator/memory/save', {
        text: String(a.text || ''),
        tags: Array.isArray(a.tags) ? a.tags : [],
      })
      return `Saved to shared project memory (id ${entry.id.slice(0, 8)}).`
    }
    case 'memory_search': {
      const { entries } = await apiGet('/api/orchestrator/memory/search', {
        q: String(a.query || ''),
        limit: String(Number(a.limit) || 10),
      })
      return fmtMemory(entries)
    }
    case 'memory_recent': {
      const { entries } = await apiGet('/api/orchestrator/memory/recent', {
        limit: String(Number(a.limit) || 10),
      })
      return fmtMemory(entries)
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Newline-delimited JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

// In-flight async tool calls — stdin EOF must not kill the process mid-call.
let pending = 0
let stdinClosed = false
function maybeExit() {
  // deferred so undici's pooled sockets settle first (avoids a libuv assert on win32)
  if (stdinClosed && pending === 0) setImmediate(() => process.exit(0))
}

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return // not JSON — ignore
  }
  const { id, method, params } = msg

  // Notifications (no id) need no response.
  if (id === undefined || id === null) return

  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS })
    } else if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments
      pending++
      try {
        const text = await callTool(name, args)
        reply(id, { content: [{ type: 'text', text }] })
      } catch (err) {
        const hint = /fetch failed|ECONNREFUSED/i.test(String(err?.message))
          ? `Christopher OS server is not reachable on port ${PORT} — is the app running?`
          : err?.message || 'Tool call failed'
        reply(id, { content: [{ type: 'text', text: `Error: ${hint}` }], isError: true })
      } finally {
        pending--
        maybeExit()
      }
    } else if (method === 'ping') {
      reply(id, {})
    } else {
      replyError(id, -32601, `Method not found: ${method}`)
    }
  } catch (err) {
    replyError(id, -32603, err?.message || 'Internal error')
  }
})

// Exit cleanly when claude closes our stdin — after in-flight calls drain.
rl.on('close', () => {
  stdinClosed = true
  maybeExit()
})
