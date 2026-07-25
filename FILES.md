# 项目文件清单

## 项目结构

```
apikey-test-tool/
├── package.json              # 项目配置
├── vite.config.js            # Vite配置
├── tailwind.config.js        # TailwindCSS配置
├── postcss.config.js         # PostCSS配置
├── index.html                # HTML入口
├── README.md                 # 项目说明
├── FILES.md                  # 本文件
│
├── electron/                  # Electron相关
│   ├── main.js              # 主进程
│   └── preload.js           # 预加载脚本
│
├── src/                      # Vue源代码
│   ├── main.js              # Vue入口
│   ├── App.vue              # 主组件
│   ├── style.css            # 全局样式
│   │
│   ├── api/                 # API测试服务
│   │   ├── openai.js       # OpenAI兼容测试
│   │   └── anthropic.js    # Anthropic测试
│   │
│   ├── components/          # Vue组件
│   │   ├── ConfigPanel.vue  # 配置面板
│   │   ├── ResultPanel.vue  # 结果展示
│   │   └── HistoryPanel.vue # 历史记录
│   │
│   └── utils/               # 工具函数
│       └── storage.js       # JSON存储
│
├── build/                    # 构建资源
│
└── dist-electron/            # 打包输出
    ├── APIKey测试工具 Setup 1.0.0.exe  # 安装包
    └── win-unpacked/         # 便携版
        └── APIKey测试工具.exe           # 可执行文件
```

## 生成的文件

### 可执行文件

1. **安装包**: `dist-electron/APIKey测试工具 Setup 1.0.0.exe` (~75MB)
   - NSIS安装包，可自定义安装位置

2. **便携版**: `dist-electron/win-unpacked/APIKey测试工具.exe` (~168MB)
   - 无需安装，直接运行

## 功能列表

- [x] 自定义提供商名称
- [x] 自定义 Base URL
- [x] 支持 OpenAI API 模式
- [x] 支持 Anthropic API 模式
- [x] 支持 OpenAI-like 模式
- [x] 测试 API 连通性
- [x] 获取可用模型列表
- [x] 并发测试多个模型响应速率
- [x] 测试结果统计（成功/失败/平均延迟）
- [x] 保存测试记录到 JSON 文件
- [x] 查看历史测试记录
- [x] 重新测试历史配置
- [x] 删除历史记录
- [x] 清空所有历史记录

## 使用说明

### 开发模式

```bash
npm install
npm run dev
```

### 打包

```bash
npm run build
```

打包后的文件位于 `dist-electron/` 目录。
