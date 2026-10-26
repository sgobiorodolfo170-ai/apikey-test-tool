// 代码题的本地执行校验。
// 模型返回的代码属于「不可信输入」，这里做三层防护：
//   1. 静态黑名单：出现 require / process / eval / Function / 死循环等直接拒绝执行
//   2. 主进程子进程执行：带硬超时，执行完立刻杀掉，且不向子进程传任何密钥
//   3. vm 上下文禁用代码生成（codeGeneration.strings=false），阻断 constructor 逃逸
// 说明：这不是严格的安全沙箱，仅用于本地诊断；无法在纯浏览器环境执行时自动降级为「未执行」。

export const MAX_CODE_LENGTH = 4000

const FORBIDDEN_PATTERNS = [
  { re: /\brequire\s*\(/, reason: '禁止 require' },
  { re: /\bimport\s*[({'"]/, reason: '禁止 import' },
  { re: /\bprocess\b/, reason: '禁止访问 process' },
  { re: /\bglobalThis\b/, reason: '禁止访问 globalThis' },
  { re: /\bchild_process\b/, reason: '禁止访问子进程' },
  { re: /\bFunction\s*\(/, reason: '禁止 Function 构造器' },
  { re: /\beval\s*\(/, reason: '禁止 eval' },
  { re: /__proto__/, reason: '禁止操作原型' },
  { re: /\bconstructor\b/, reason: '禁止访问 constructor' },
  { re: /\bfetch\s*\(/, reason: '禁止网络请求' },
  { re: /\bXMLHttpRequest\b/, reason: '禁止网络请求' },
  { re: /while\s*\(\s*(true|1)\s*\)/, reason: '禁止死循环' },
  { re: /for\s*\(\s*;\s*;\s*\)/, reason: '禁止死循环' },
]

// 去掉 markdown 代码块包裹，只保留代码本体
export function stripCodeFences(text) {
  const raw = String(text || '')
  const fenced = raw.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i)
  return (fenced ? fenced[1] : raw).trim()
}

export function staticCheckCode(code) {
  if (!code) return { ok: false, reason: '未返回代码' }
  if (code.length > MAX_CODE_LENGTH) return { ok: false, reason: '代码过长' }
  for (const { re, reason } of FORBIDDEN_PATTERNS) {
    if (re.test(code)) return { ok: false, reason }
  }
  return { ok: true }
}

export function getCodeRunner() {
  if (typeof window === 'undefined') return null
  const api = window.electronAPI
  return api && typeof api.runCode === 'function' ? api : null
}

// 返回 { executed, passed, reason, results }
export async function verifyCodeAnswer(question, answer) {
  const code = stripCodeFences(answer)
  const staticResult = staticCheckCode(code)
  if (!staticResult.ok) {
    return { executed: false, passed: false, reason: staticResult.reason, code }
  }

  const runner = getCodeRunner()
  if (!runner) {
    return { executed: false, passed: false, reason: '当前环境不支持本地执行', code }
  }

  try {
    const result = await runner.runCode({
      language: question.language || 'js',
      code,
      tests: question.tests || [],
    })

    if (!result?.ok) {
      return { executed: false, passed: false, reason: result?.error || '执行失败', code }
    }

    const results = result.results || []
    const passed = results.length > 0 && results.every((r) => r.pass)
    return {
      executed: true,
      passed,
      reason: result.error || undefined,
      code,
      results,
    }
  } catch (error) {
    return { executed: false, passed: false, reason: error.message, code }
  }
}
