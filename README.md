# API Key 测试工具

大模型 API Key 连通性测试工具，支持多提供商、多API模式。

## 功能特性

- ✅ 自定义提供商名称和 Base URL
- ✅ 支持 OpenAI / Anthropic / OpenAI-like 三种API模式
- ✅ 获取可用模型列表
- ✅ 测试每个模型的响应速率（并发测试）
- ✅ 测试历史记录保存与查看
- ✅ Windows 桌面应用 (.exe)

## 技术栈

- Electron 28
- Vue 3
- Vite
- TailwindCSS
- electron-builder

## 项目结构

```
apikey-test-tool/
├── package.json          # 项目配置
├── vite.config.js        # Vite配置
├── electron/
│   ├── main.js           # 主进程
│   └── preload.js        # 预加载脚本
├── index.html
├── src/
│   ├── main.js           # Vue入口
│   ├── App.vue           # 主组件
│   ├── api/
│   │   ├── openai.js     # OpenAI测试
│   │   └── anthropic.js # Anthropic测试
│   ├── components/
│   │   ├── ConfigPanel.vue   # 配置面板
│   │   ├── ResultPanel.vue   # 结果展示
│   │   └── HistoryPanel.vue  # 历史记录
│   └── utils/
│       └── storage.js    # JSON存储
└── README.md
```

## 使用说明

### 开发模式

```bash
npm install
npm run dev
```

### 打包发布

```bash
npm run build
```

打包后的exe文件位于 `dist/` 目录。

## 配置说明

| 参数 | 说明 |
|------|------|
| 提供商 | 自定义名称，如 "OpenAI"、"硅基流动" |
| Base URL | API地址，如 `https://api.openai.com/v1` |
| API模式 | OpenAI / Anthropic / OpenAI-like |
| API Key | 您的API密钥 |
| 并发数量 | 同时测试的模型数量 |

## 测试Prompt

固定测试内容：`"这是大模型连通性测试"`

## 数据存储

测试历史保存在 `userData/history.json` 文件中。
