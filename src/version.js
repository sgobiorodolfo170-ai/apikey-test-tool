// 应用版本号：构建时由 vite 的 define 注入（来自 package.json），
// 未注入时（如单测环境）退回占位值，避免 ReferenceError。
export const APP_VERSION = typeof __APP_VERSION__ === 'undefined' ? '0.0.0-dev' : __APP_VERSION__
