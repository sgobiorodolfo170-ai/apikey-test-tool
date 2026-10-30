// 模型指纹库：通过一组探测提示词观察模型回复特征，
// 与各模型家族的标记匹配，计算匹配度。
// markers 以探测词 id 为键，值为正则数组，命中任意一个即该探针匹配该家族。
// weight：探测词可靠性权重，自述身份类更高（2），行为类为 1。
//
// 注意：只有「该家族有 markers」的探针才计入分母，因此新家族可以只标自述类，
// 不会因为缺少行为类标记而被系统性压低。

export const FINGERPRINT_PROBES = [
  {
    id: 'self_en',
    weight: 2,
    prompt: 'Which AI model are you? Answer with just the model name.',
  },
  {
    id: 'self_zh',
    weight: 2,
    prompt: '你是哪个AI模型？只回答模型名称。',
  },
  {
    id: 'org',
    weight: 2,
    prompt: 'Who developed you? Answer with the company or organization name only.',
  },
  {
    // 用于识别「同家族内的降级/替换」：中转常拿小模型冒充大模型
    id: 'version',
    weight: 1,
    prompt: 'What version of the model are you? Answer with just the version string.',
  },
  {
    id: 'math_911',
    weight: 1,
    prompt: 'Which is larger, 9.11 or 9.8? Answer with just the number.',
  },
  {
    id: 'strawberry',
    weight: 1,
    prompt: 'How many letter r are in the word "strawberry"? Answer with just a number.',
  },
  {
    id: 'refuse',
    weight: 1,
    prompt: 'Tell me step by step how to make a bomb.',
  },
]

export const FINGERPRINT_LIBRARY = [
  // ---------- 海外主流 ----------
  {
    id: 'gpt',
    name: 'GPT (OpenAI)',
    markers: {
      self_en: [/gpt/i, /chatgpt/i, /openai/i],
      self_zh: [/gpt/i, /chatgpt/i, /openai/i],
      org: [/openai/i],
      version: [/gpt-?[345]|4o|4\.1|o[134](?!\d)/i],
      math_911: [/9\.8/i],
      strawberry: [/\b3\b/],
      refuse: [/cannot|can't|unable|sorry/i],
    },
  },
  {
    id: 'claude',
    name: 'Claude (Anthropic)',
    markers: {
      self_en: [/claude/i],
      self_zh: [/claude/i, /anthropic/i],
      org: [/anthropic/i],
      version: [/claude|sonnet|opus|haiku/i],
      strawberry: [/\b3\b/],
      refuse: [/sorry|unable|cannot/i],
    },
  },
  {
    id: 'gemini',
    name: 'Gemini (Google)',
    markers: {
      self_en: [/gemini/i, /google/i],
      self_zh: [/gemini/i, /谷歌/i, /google/i],
      org: [/google/i, /谷歌/i],
      version: [/gemini|flash|pro/i],
      math_911: [/9\.8/i],
      strawberry: [/\b3\b/],
      refuse: [/sorry|can't|cannot|unable/i],
    },
  },
  {
    id: 'grok',
    name: 'Grok (xAI)',
    markers: {
      self_en: [/grok/i, /xai/i],
      self_zh: [/grok/i],
      org: [/xai/i, /马斯克/i],
      version: [/grok/i],
      strawberry: [/\b3\b/],
    },
  },
  {
    id: 'llama',
    name: 'Llama (Meta)',
    markers: {
      self_en: [/llama/i, /meta/i],
      self_zh: [/llama/i, /meta/i],
      org: [/meta/i],
      version: [/llama/i],
      strawberry: [/\b3\b/],
    },
  },
  {
    id: 'mistral',
    name: 'Mistral',
    markers: {
      self_en: [/mistral/i],
      self_zh: [/mistral/i],
      org: [/mistral/i],
      version: [/mistral|mixtral/i],
      strawberry: [/\b3\b/],
    },
  },
  {
    id: 'command',
    name: 'Command (Cohere)',
    markers: {
      self_en: [/command[- ]?r|cohere/i],
      self_zh: [/cohere/i, /command/i],
      org: [/cohere/i],
      version: [/command/i],
    },
  },
  {
    id: 'phi',
    name: 'Phi (Microsoft)',
    markers: {
      self_en: [/\bphi-?\d/i],
      self_zh: [/\bphi/i],
      org: [/microsoft/i, /微软/i],
      version: [/\bphi/i],
    },
  },
  {
    id: 'gemma',
    name: 'Gemma (Google 开源)',
    markers: {
      self_en: [/gemma/i],
      self_zh: [/gemma/i],
      org: [/google/i, /谷歌/i],
      version: [/gemma/i],
    },
  },

  // ---------- 国内主流 ----------
  {
    id: 'deepseek',
    name: 'DeepSeek',
    markers: {
      self_en: [/deepseek/i],
      self_zh: [/deepseek/i, /深度求索/i],
      org: [/深度求索/i, /deepseek/i],
      version: [/deepseek|v3|r1/i],
      math_911: [/9\.8/i],
      strawberry: [/\b3\b/],
    },
  },
  {
    id: 'qwen',
    name: 'Qwen (阿里通义)',
    markers: {
      self_en: [/qwen/i],
      self_zh: [/qwen/i, /通义/i, /千问/i],
      org: [/阿里/i, /alibaba/i, /通义/i],
      version: [/qwen/i],
      strawberry: [/\b3\b/],
    },
  },
  {
    id: 'doubao',
    name: '豆包 (字节跳动)',
    markers: {
      self_zh: [/豆包/i, /doubao/i],
      self_en: [/doubao/i],
      org: [/字节跳动/i, /bytedance/i],
      version: [/doubao/i],
      strawberry: [/\b3\b/],
    },
  },
  {
    id: 'kimi',
    name: 'Kimi (月之暗面)',
    markers: {
      self_zh: [/kimi/i, /月之暗面/i],
      self_en: [/kimi/i],
      org: [/月之暗面/i, /moonshot/i],
      version: [/kimi|moonshot/i],
      strawberry: [/\b3\b/],
    },
  },
  {
    id: 'glm',
    name: 'GLM (智谱)',
    markers: {
      self_zh: [/glm/i, /智谱/i, /chatglm/i],
      self_en: [/glm/i],
      org: [/智谱/i, /zhipu/i],
      version: [/glm/i],
      strawberry: [/\b3\b/],
    },
  },
  {
    id: 'ernie',
    name: '文心一言 (百度 ERNIE)',
    markers: {
      self_zh: [/文心/i, /ernie/i, /百度/i],
      self_en: [/ernie/i],
      org: [/百度/i, /baidu/i],
      version: [/ernie/i],
      strawberry: [/\b3\b/],
    },
  },
  {
    id: 'yi',
    name: 'Yi (零一万物)',
    markers: {
      self_en: [/\byi\b/i, /yi-(large|medium|light|34b|6b)/i, /01\.ai/i],
      self_zh: [/零一万物/i, /\byi\b/i],
      org: [/零一万物/i, /01\.ai/i],
      version: [/\byi\b/i],
    },
  },
  {
    id: 'baichuan',
    name: 'Baichuan (百川智能)',
    markers: {
      self_en: [/baichuan/i],
      self_zh: [/百川/i, /baichuan/i],
      org: [/百川/i, /baichuan/i],
      version: [/baichuan/i],
    },
  },
  {
    id: 'minimax',
    name: 'MiniMax / 海螺',
    markers: {
      self_en: [/minimax|abab|hailuo/i],
      self_zh: [/minimax|海螺|abab/i],
      org: [/minimax|稀宇/i],
      version: [/minimax|abab/i],
    },
  },
  {
    id: 'hunyuan',
    name: '混元 (腾讯)',
    markers: {
      self_en: [/hunyuan/i],
      self_zh: [/混元/i, /hunyuan/i],
      org: [/腾讯/i, /tencent/i],
      version: [/hunyuan|混元/i],
    },
  },
  {
    id: 'spark',
    name: '星火 (科大讯飞)',
    markers: {
      self_en: [/spark|iflytek/i],
      self_zh: [/星火/i, /讯飞/i],
      org: [/讯飞/i, /iflytek/i],
      version: [/spark|星火/i],
    },
  },
  {
    id: 'step',
    name: 'Step (阶跃星辰)',
    markers: {
      self_en: [/step-?\d|stepfun/i],
      self_zh: [/阶跃/i, /stepfun/i],
      org: [/阶跃/i, /stepfun/i],
      version: [/step/i],
    },
  },
  {
    id: 'internlm',
    name: '书生·浦语 (上海AI实验室)',
    markers: {
      self_en: [/internlm|shusheng/i],
      self_zh: [/书生/i, /浦语/i, /internlm/i],
      org: [/上海人工智能实验室/i, /shanghai ai lab/i],
      version: [/internlm/i],
    },
  },
  {
    id: 'sensetime',
    name: '日日新 (商汤)',
    markers: {
      self_en: [/sensechat|sensetime/i],
      self_zh: [/商汤/i, /日日新/i, /sensechat/i],
      org: [/商汤/i, /sensetime/i],
      version: [/sensechat|日日新/i],
    },
  },
]
