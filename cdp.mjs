import { setTimeout as delay } from 'node:timers/promises'

export const DEFAULT_PORT = Number(process.env.CHATGPT_CDP_PORT || 9223)
export const DEFAULT_HOST = process.env.CHATGPT_CDP_HOST || '127.0.0.1'

export function resolveConfig() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const localAppData = process.env.CHATGPT_REA_LOCALAPPDATA
    || process.env.LOCALAPPDATA
    || (home ? `${home}\\AppData\\Local` : '')

  const defaultAppDir = process.platform === 'win32' && localAppData
    ? `${localAppData}\\ChatGPT-REA\\app`
    : ''
  const defaultProfile = process.platform === 'win32' && localAppData
    ? `${localAppData}\\ChatGPT-REA\\profile`
    : ''

  const appDir = process.env.CHATGPT_APP_DIR
    || process.env.CHATGPT_REA_APP
    || defaultAppDir
  const profile = process.env.CHATGPT_PROFILE
    || process.env.CHATGPT_REA_PROFILE
    || defaultProfile
  const exe = process.env.CHATGPT_EXE
    || (appDir ? `${appDir}${process.platform === 'win32' ? '\\' : '/'}${process.platform === 'win32' ? 'ChatGPT.exe' : 'ChatGPT'}` : '')

  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    appDir,
    exe,
    profile,
    appdata: process.env.CHATGPT_REA_APPDATA || '',
    localappdata: process.env.CHATGPT_REA_LOCALAPPDATA || '',
  }
}

export async function getTargets({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 3000 } = {}) {
  const res = await fetch(`http://${host}:${port}/json`, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`CDP /json HTTP ${res.status}`)
  const data = await res.json()
  return Array.isArray(data) ? data : (Array.isArray(data?.targets) ? data.targets : [])
}

export function pickTarget(list) {
  if (!Array.isArray(list)) return null
  const isChatGPT = (t) => typeof t?.url === 'string' && /chatgpt\.com/i.test(t.url)
  return list.find((t) => t.type === 'webview' && isChatGPT(t))
    || list.find((t) => isChatGPT(t))
    || null
}

export class CDPSession {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.closed = false

    ws.addEventListener('message', (event) => {
      let data
      try { data = JSON.parse(String(event.data)) } catch { return }
      if (!data?.id) return
      const entry = this.pending.get(data.id)
      if (!entry) return
      this.pending.delete(data.id)
      if (data.error) entry.reject(new Error(`${data.error.message || 'CDP error'} (${data.error.code ?? 'unknown'})`))
      else entry.resolve(data.result)
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const entry of this.pending.values()) entry.reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
  }

  static connect(wsUrl, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => {
        try { ws.close() } catch {}
        reject(new Error('CDP connect timeout'))
      }, timeoutMs)

      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new CDPSession(ws))
      }, { once: true })
      ws.addEventListener('error', (event) => {
        clearTimeout(timer)
        reject(new Error(`WebSocket error: ${event?.error?.message || event?.message || 'unknown'}`))
      }, { once: true })
    })
  }

  send(method, params = {}, { timeoutMs = 90000 } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise,
      userGesture: true,
    })
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'Runtime exception')
    }
    const remote = result?.result
    return remote?.value ?? remote?.description ?? null
  }

  close() {
    this.closed = true
    try { this.ws.close() } catch {}
  }
}

export async function connectToChatGPT({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const list = await getTargets({ host, port })
  const target = pickTarget(list)
  if (!target) throw new Error('CDP_OFFLINE: start the ChatGPT desktop app with --remote-debugging-port first')
  const session = await CDPSession.connect(target.webSocketDebuggerUrl)
  return { session, target }
}

export function readPageExpression() {
  return `(() => {
    const visible = Array.from(document.querySelectorAll('main')).filter((e) => e.getBoundingClientRect().width > 0);
    return {
      title: document.title,
      url: location.href,
      text: ((visible[visible.length - 1] || document.body).innerText || '').slice(0, 500000),
      busy: !!Array.from(document.querySelectorAll('button')).find((b) => {
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        return (label.includes('stop') || label.includes('停止')) && b.getBoundingClientRect().width > 0;
      }),
    };
  })()`
}

export async function waitForStable(session, {
  timeoutMs = Number(process.env.CHATGPT_WAIT_TIMEOUT_MS || 300000),
  stableMs = Number(process.env.CHATGPT_WAIT_STABLE_MS || 2500),
  intervalMs = Number(process.env.CHATGPT_WAIT_INTERVAL_MS || 1000),
} = {}) {
  const started = Date.now()
  let lastText = ''
  let lastChange = Date.now()
  let sawChange = false

  while (Date.now() - started < timeoutMs) {
    const page = await session.evaluate(readPageExpression())
    const text = String(page?.text || '')
    if (text !== lastText) {
      lastText = text
      lastChange = Date.now()
      sawChange = true
    }
    const stable = sawChange && !page?.busy && Date.now() - lastChange >= stableMs
    if (stable) {
      return { ...page, stable: true, waitedMs: Date.now() - started }
    }
    await delay(intervalMs)
  }
  throw new Error(`WAIT_TIMEOUT: no stable reply within ${timeoutMs}ms`)
}
