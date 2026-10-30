// 模型能力题库：多维度、带难度（1-5）、客观可自动判分的题目。
// type:
//   number  -> 回复中出现过该数字即算对（容忍“17 × 43 - 29 = 702”这类中间数字）
//   choice  -> 回复包含任一正确答案（并列说法/选项字母）
//   keyword -> 回复须同时包含全部关键词（用于需要列全的题）
//   regex   -> 回复匹配任一正则
// dimension: reasoning 逻辑推理 / math 数学 / coding 代码 / knowledge 中文知识
//            / comprehension 语义理解 / instruction 指令遵循 / extraction 信息抽取

export const CAPABILITY_DIMENSIONS = [
  { id: 'reasoning', name: '逻辑推理' },
  { id: 'math', name: '数学' },
  { id: 'coding', name: '代码' },
  { id: 'knowledge', name: '中文知识' },
  { id: 'comprehension', name: '语义理解' },
  { id: 'instruction', name: '指令遵循' },
  { id: 'extraction', name: '信息抽取' },
]

export const QUESTION_BANK = [
  // ---------- 逻辑推理 ----------
  {
    id: 'logic_guarantee',
    dimension: 'reasoning',
    difficulty: 3,
    title: '保证取球',
    prompt:
      '一个袋子里有5个红球和3个蓝球，每次随机拿出一个且不放回。至少要拿几次才能保证一定拿到一个红球？只回答数字。',
    type: 'number',
    answer: 4,
  },
  {
    id: 'logic_cats',
    dimension: 'reasoning',
    difficulty: 3,
    title: '猫叫推理',
    prompt: '前提：所有猫都会喵叫。这只动物不会喵叫。请问这只动物最可能是什么？只回答一个词。',
    type: 'choice',
    answer: ['不是猫', '非猫', '猫以外', '不是', '其它动物', '其他动物'],
  },
  {
    id: 'logic_consecutive',
    dimension: 'reasoning',
    difficulty: 3,
    title: '连续自然数',
    prompt:
      '三个连续自然数的乘积是 504，这三个数分别是多少？按从小到大只回答三个数字，用空格分隔。',
    type: 'keyword',
    answer: ['7', '8', '9'],
  },
  {
    id: 'logic_knights',
    dimension: 'reasoning',
    difficulty: 4,
    title: '骑士与无赖',
    prompt:
      '岛上只有骑士（永远说真话）和无赖（永远说假话）。A 说：“我们两个都是无赖。”请问 A 是什么？只回答“骑士”或“无赖”。',
    type: 'choice',
    answer: ['无赖'],
  },
  {
    id: 'logic_liars',
    dimension: 'reasoning',
    difficulty: 4,
    title: '三人真假话',
    prompt:
      '甲乙丙三人中只有一人说真话。甲说：“乙在说谎。”乙说：“丙在说谎。”丙说：“甲和乙都在说谎。”谁说真话？只回答甲、乙或丙。',
    type: 'choice',
    answer: ['乙'],
  },
  {
    id: 'logic_sequence',
    dimension: 'reasoning',
    difficulty: 2,
    title: '数列补全',
    prompt: '数列 2, 6, 12, 20, 30, ? 的下一项是多少？只回答数字。',
    type: 'number',
    answer: 42,
  },

  // ---------- 数学 ----------
  {
    id: 'math_chase',
    dimension: 'math',
    difficulty: 3,
    title: '追及问题',
    prompt:
      '甲车速度90km/h，乙车速度60km/h，甲车落后乙车60公里并同向追赶。多久能追上？只回答小时数。',
    type: 'number',
    answer: 2,
  },
  {
    id: 'math_exp',
    dimension: 'math',
    difficulty: 2,
    title: '指数方程',
    prompt: '若 2 的 x 次方等于 64，x 等于多少？只回答数字。',
    type: 'number',
    answer: 6,
  },
  {
    id: 'math_ops',
    dimension: 'math',
    difficulty: 2,
    title: '混合运算',
    prompt: '计算：17 × 43 - 29 = ？只回答数字。',
    type: 'number',
    answer: 702,
  },
  {
    id: 'math_percent',
    dimension: 'math',
    difficulty: 3,
    title: '涨跌还原',
    prompt:
      '一件商品先涨价 20%，再在涨价后的价格上降价 20%。最终价格是原价的百分之多少？只回答数字。',
    type: 'number',
    answer: 96,
  },
  {
    id: 'math_work',
    dimension: 'math',
    difficulty: 3,
    title: '工程问题',
    prompt: '一项工作甲单独做要 6 天，乙单独做要 12 天。两人合作需要几天完成？只回答数字。',
    type: 'number',
    answer: 4,
  },
  {
    id: 'math_sum',
    dimension: 'math',
    difficulty: 2,
    title: '等差数列求和',
    prompt: '1 + 2 + 3 + … + 100 等于多少？只回答数字。',
    type: 'number',
    answer: 5050,
  },

  // ---------- 代码 ----------
  {
    id: 'coding_palindrome',
    dimension: 'coding',
    difficulty: 4,
    title: '回文函数',
    prompt:
      '用 JavaScript 写一个函数 isPalindrome(s)，判断字符串是否为回文，忽略大小写与空格。只输出函数代码。',
    type: 'keyword',
    answer: ['isPalindrome', 'reverse'],
  },
  {
    id: 'coding_output',
    dimension: 'coding',
    difficulty: 3,
    title: '代码输出',
    prompt: '以下代码输出什么？console.log([1,2,3].map(x=>x*2).filter(x=>x>3)) 只回答输出结果。',
    type: 'choice',
    answer: ['[4,6]', '4,6'],
  },
  {
    id: 'coding_counter',
    dimension: 'coding',
    difficulty: 4,
    title: '词频统计',
    prompt: '用 Python 找出字符串中出现次数最多的字符，只给出实现这一功能的核心一行代码。',
    type: 'keyword',
    answer: ['max(', 'count'],
  },
  {
    id: 'coding_closure',
    dimension: 'coding',
    difficulty: 3,
    title: '数组展开',
    prompt: '以下代码输出什么？console.log([...Array(3).keys()].map(i=>i*2)) 只回答输出结果。',
    type: 'choice',
    answer: ['[0,2,4]', '0,2,4'],
  },
  {
    id: 'coding_bug',
    dimension: 'coding',
    difficulty: 3,
    title: '定位报错原因',
    prompt: '这段代码报错，原因是什么？const a = {}; a.b.c = 1; 只回答核心原因（一个词即可）。',
    type: 'choice',
    answer: ['undefined', '未定义', 'a.b 不存在', 'a.b不存在'],
  },

  // ---------- 中文知识 ----------
  {
    id: 'knowledge_four',
    dimension: 'knowledge',
    difficulty: 2,
    title: '四大发明',
    prompt: '中国古代四大发明是什么？请列出名称。',
    type: 'keyword',
    answer: ['造纸', '印刷', '火药', '指南针'],
  },
  {
    id: 'knowledge_honglou',
    dimension: 'knowledge',
    difficulty: 2,
    title: '红楼梦作者',
    prompt: '《红楼梦》的作者是谁？只回答姓名。',
    type: 'choice',
    answer: ['曹雪芹'],
  },
  {
    id: 'knowledge_light',
    dimension: 'knowledge',
    difficulty: 2,
    title: '光速',
    prompt: '光在真空中的速度约是多少万公里每秒？只回答数字（万公里/秒）。',
    type: 'number',
    answer: 30,
  },
  {
    id: 'knowledge_tang',
    dimension: 'knowledge',
    difficulty: 1,
    title: '静夜思作者',
    prompt: '《静夜思》的作者是谁？只回答姓名。',
    type: 'choice',
    answer: ['李白'],
  },
  {
    id: 'knowledge_dynasty',
    dimension: 'knowledge',
    difficulty: 2,
    title: '首个大一统王朝',
    prompt: '中国历史上第一个统一的中央集权王朝是哪个朝代？只回答朝代名。',
    type: 'choice',
    answer: ['秦朝', '秦'],
  },
  {
    id: 'knowledge_chem',
    dimension: 'knowledge',
    difficulty: 1,
    title: '水的化学式',
    prompt: '水的化学式是什么？只回答化学式。',
    type: 'choice',
    answer: ['H2O', 'H₂O'],
  },

  // ---------- 语义理解 ----------
  {
    id: 'comp_causal',
    dimension: 'comprehension',
    difficulty: 3,
    title: '因果关系',
    prompt: '哪句话表达因果关系？A. 天在下雨，所以我带伞。B. 天在下雨，我也带伞。只回答选项字母。',
    type: 'choice',
    answer: ['A'],
  },
  {
    id: 'comp_passive',
    dimension: 'comprehension',
    difficulty: 3,
    title: '被动语态',
    prompt: '把句子改成被动语态（保持原意）："猫吃了鱼"。只回答改写后的句子。',
    type: 'choice',
    answer: ['鱼被猫吃', '鱼被吃', '被猫吃掉', '被吃掉了'],
  },
  {
    id: 'comp_idiom',
    dimension: 'comprehension',
    difficulty: 2,
    title: '成语含义',
    prompt: '“画蛇添足”比喻什么？A. 多此一举 B. 锦上添花 只回答选项字母。',
    type: 'choice',
    answer: ['A'],
  },
  {
    id: 'comp_antonym',
    dimension: 'comprehension',
    difficulty: 2,
    title: '反义词',
    prompt: '“慷慨”的反义词是？A. 吝啬 B. 大方 只回答选项字母。',
    type: 'choice',
    answer: ['A'],
  },
  {
    id: 'comp_refer',
    dimension: 'comprehension',
    difficulty: 3,
    title: '指代消解',
    prompt: '“小明告诉小红，他的书丢了。”句中的“他”最可能指谁？A. 小明 B. 小红 只回答选项字母。',
    type: 'choice',
    answer: ['A'],
  },

  // ---------- 指令遵循 ----------
  {
    id: 'instr_format',
    dimension: 'instruction',
    difficulty: 4,
    title: '格式遵循',
    prompt:
      '请严格按照此格式回答："答案：X"，其中 X 为 10 以内（含1和10）质数的个数。只输出该格式，不要多余内容。',
    type: 'choice',
    answer: ['答案：4', '答案:4', '答案：4个', '答案是4'],
  },
  {
    id: 'instr_negation',
    dimension: 'instruction',
    difficulty: 4,
    title: '禁用词约束',
    prompt: '在回答中不要使用任何数字，请回答：1+1 等于几？',
    type: 'choice',
    answer: ['二', '两个', '两'],
  },
  {
    id: 'instr_json',
    dimension: 'instruction',
    difficulty: 3,
    title: '结构化输出',
    prompt: '只输出一个 JSON 对象，包含键 ok，值为布尔真值，不要输出任何其他内容。',
    type: 'keyword',
    answer: ['"ok"', 'true'],
  },
  {
    id: 'instr_lower',
    dimension: 'instruction',
    difficulty: 1,
    title: '大小写转换',
    prompt: '把 HELLO 转成小写，只回答结果。',
    type: 'choice',
    answer: ['hello'],
  },
  {
    id: 'instr_count',
    dimension: 'instruction',
    difficulty: 2,
    title: '字符计数',
    prompt: '单词 banana 中字母 a 出现了几次？只回答数字。',
    type: 'number',
    answer: 3,
  },

  // ---------- 信息抽取 ----------
  {
    id: 'extract_date',
    dimension: 'extraction',
    difficulty: 3,
    title: '日期提取',
    prompt: '从这句话中提取日期并只回答日期："会议定于2026年5月20日周三下午3点举行。"',
    type: 'choice',
    answer: ['2026年5月20日', '2026-05-20', '5月20日', '2026/5/20'],
  },
  {
    id: 'extract_email',
    dimension: 'extraction',
    difficulty: 3,
    title: '邮箱提取',
    prompt: '从文本中提取邮箱并只回答邮箱："请联系 support@example.cn 或致电 400。"',
    type: 'choice',
    answer: ['support@example.cn'],
  },
  {
    id: 'extract_amount',
    dimension: 'extraction',
    difficulty: 3,
    title: '金额提取',
    prompt: '从文本中提取订单总额并只回答数字："订单总额 1,280.50 元，已付 300 元。"',
    type: 'number',
    answer: 1280.5,
    tolerance: 0.01,
  },
  {
    id: 'extract_name',
    dimension: 'extraction',
    difficulty: 1,
    title: '姓名提取',
    prompt: '从文本中提取联系人姓名并只回答姓名："联系人：张伟，电话 13800138000"',
    type: 'choice',
    answer: ['张伟'],
  },
  {
    id: 'extract_json_field',
    dimension: 'extraction',
    difficulty: 1,
    title: 'JSON 字段提取',
    prompt: '以下 JSON 中 count 的值是多少？{"status":"ok","count":7} 只回答数字。',
    type: 'number',
    answer: 7,
  },

  // ---------- 代码题：本地沙箱执行校验（不靠关键词，直接跑测试用例） ----------
  {
    id: 'code_js_odd_sum',
    dimension: 'coding',
    difficulty: 3,
    title: '奇数求和',
    prompt:
      '用 JavaScript 写一个函数 solve(n)，返回 1 到 n（含 n）之间所有奇数的和。只输出函数定义，不要解释、不要代码块标记。',
    type: 'code',
    language: 'js',
    tests: [
      { input: 5, expected: 9 },
      { input: 10, expected: 25 },
      { input: 1, expected: 1 },
    ],
  },
  {
    id: 'code_js_max',
    dimension: 'coding',
    difficulty: 2,
    title: '数组最大值',
    prompt: '用 JavaScript 写一个函数 solve(arr)，返回数组中的最大值。只输出函数定义。',
    type: 'code',
    language: 'js',
    tests: [
      { input: [3, 9, 2], expected: 9 },
      { input: [-5, -1, -9], expected: -1 },
    ],
  },
  {
    id: 'code_js_reverse',
    dimension: 'coding',
    difficulty: 2,
    title: '字符串反转',
    prompt: '用 JavaScript 写一个函数 solve(s)，返回字符串反转后的结果。只输出函数定义。',
    type: 'code',
    language: 'js',
    tests: [
      { input: 'abc', expected: 'cba' },
      { input: '你好', expected: '好你' },
    ],
  },
]

// ---------- 参数化模板（抗污染） ----------
// 固定题库容易被训练数据记住，这里每次运行用随机参数生成新题：
// 题目结构不变、难度等价，但数字每次都不同，背答案无法通过。
// 用带种子的 PRNG，保证同一种子可复现（便于对比与回归）。

export function createSeededRng(seed) {
  let state = (Number(seed) || 1) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1))
const pickOne = (rng, list) => list[Math.floor(rng() * list.length)]

export const QUESTION_TEMPLATES = [
  {
    id: 'tpl_chase',
    dimension: 'reasoning',
    difficulty: 3,
    build(rng) {
      const slow = randInt(rng, 50, 80)
      const gapSpeed = pickOne(rng, [20, 30, 40])
      const hours = randInt(rng, 2, 5)
      const distance = gapSpeed * hours
      return {
        title: '追及问题',
        prompt: `甲车速度${slow + gapSpeed}km/h，乙车速度${slow}km/h，甲车落后乙车${distance}公里并同向追赶。多久能追上？只回答小时数。`,
        type: 'number',
        answer: hours,
      }
    },
  },
  {
    id: 'tpl_work',
    dimension: 'math',
    difficulty: 3,
    build(rng) {
      const [a, b, answer] = pickOne(rng, [
        [6, 12, 4],
        [4, 12, 3],
        [10, 15, 6],
        [6, 3, 2],
        [8, 8, 4],
        [9, 18, 6],
        [12, 4, 3],
      ])
      return {
        title: '工程问题',
        prompt: `一项工作甲单独做要 ${a} 天，乙单独做要 ${b} 天。两人合作需要几天完成？只回答数字。`,
        type: 'number',
        answer,
      }
    },
  },
  {
    id: 'tpl_percent',
    dimension: 'math',
    difficulty: 3,
    build(rng) {
      const [up, down] = pickOne(rng, [
        [10, 10],
        [20, 20],
        [25, 20],
        [50, 50],
        [20, 10],
        [30, 30],
      ])
      const answer = Math.round((1 + up / 100) * (1 - down / 100) * 100)
      return {
        title: '涨跌还原',
        prompt: `一件商品先涨价 ${up}%，再在涨价后的价格上降价 ${down}%。最终价格是原价的百分之多少？只回答数字。`,
        type: 'number',
        answer,
      }
    },
  },
  {
    id: 'tpl_age',
    dimension: 'math',
    difficulty: 3,
    build(rng) {
      const son = randInt(rng, 8, 14)
      const years = randInt(rng, 3, 8)
      const father = 2 * son + years
      return {
        title: '年龄问题',
        prompt: `父亲今年${father}岁，儿子今年${son}岁。多少年后父亲的年龄正好是儿子的 2 倍？只回答数字。`,
        type: 'number',
        answer: years,
      }
    },
  },
  {
    id: 'tpl_chicken',
    dimension: 'math',
    difficulty: 2,
    build(rng) {
      const heads = randInt(rng, 10, 20)
      const rabbits = randInt(rng, 2, 7)
      const legs = 2 * heads + 2 * rabbits
      return {
        title: '鸡兔同笼',
        prompt: `鸡兔同笼，共有${heads}个头、${legs}条腿，问兔有几只？只回答数字。`,
        type: 'number',
        answer: rabbits,
      }
    },
  },
  {
    id: 'tpl_clock',
    dimension: 'math',
    difficulty: 3,
    build(rng) {
      const hour = randInt(rng, 1, 11)
      const minute = pickOne(rng, [0, 20, 40])
      const raw = Math.abs(30 * hour - 5.5 * minute)
      const answer = Math.round(raw > 180 ? 360 - raw : raw)
      const minuteText = String(minute).padStart(2, '0')
      return {
        title: '钟面夹角',
        prompt: `时钟显示 ${hour}:${minuteText} 时，时针与分针的较小夹角是多少度？只回答数字。`,
        type: 'number',
        answer,
      }
    },
  },
  {
    id: 'tpl_sequence',
    dimension: 'reasoning',
    difficulty: 2,
    build(rng) {
      const first = randInt(rng, 2, 9)
      const step = randInt(rng, 3, 9)
      const terms = Array.from({ length: 5 }, (_, i) => first + i * step)
      return {
        title: '数列补全',
        prompt: `数列 ${terms.join(', ')}, ? 的下一项是多少？只回答数字。`,
        type: 'number',
        answer: first + 5 * step,
      }
    },
  },
  {
    id: 'tpl_guarantee',
    dimension: 'reasoning',
    difficulty: 3,
    build(rng) {
      const red = randInt(rng, 4, 9)
      const blue = randInt(rng, 2, 6)
      return {
        title: '保证取球',
        prompt: `袋子里有${red}个红球和${blue}个蓝球，每次随机拿出一个且不放回。至少要拿几次才能保证一定拿到一个红球？只回答数字。`,
        type: 'number',
        answer: blue + 1,
      }
    },
  },
  {
    id: 'tpl_interference',
    dimension: 'instruction',
    difficulty: 3,
    build(rng) {
      const odds = Array.from({ length: 3 }, () => randInt(rng, 1, 9) * 2 + 1)
      const evens = Array.from({ length: 3 }, () => randInt(rng, 1, 9) * 2)
      // 用 Fisher-Yates 洗牌，保证同一种子下顺序可复现（sort 的比较器方案不确定）
      const numbers = [...odds, ...evens]
      for (let i = numbers.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[numbers[i], numbers[j]] = [numbers[j], numbers[i]]
      }
      const answer = odds.reduce((sum, n) => sum + n, 0)
      return {
        title: '条件筛选求和',
        prompt: `把下面这些数相加，但只加奇数、跳过偶数：${numbers.join(', ')}。只回答结果。`,
        type: 'number',
        answer,
      }
    },
  },
  {
    id: 'tpl_unit',
    dimension: 'math',
    difficulty: 1,
    build(rng) {
      const meters = randInt(rng, 1, 9) + pickOne(rng, [0, 0.5])
      return {
        title: '单位换算',
        prompt: `${meters} 米等于多少厘米？只回答数字。`,
        type: 'number',
        answer: Math.round(meters * 100),
      }
    },
  },
]

// 静态题的「同义改写」池：同一个知识点换几种问法，按种子随机取一条。
// 目的是打断「题干原文 → 答案」的死记硬背，同时保持答案不变。
export const PROMPT_VARIANTS = {
  knowledge_four: [
    '中国古代四大发明是什么？请列出名称。',
    '请说出中国四大发明的具体名称。',
    '四大发明指哪四项？只列名称。',
  ],
  knowledge_honglou: [
    '《红楼梦》的作者是谁？只回答姓名。',
    '《红楼梦》是谁写的？只回答姓名。',
    '中国古典名著《红楼梦》出自哪位作家之手？只回答姓名。',
  ],
  knowledge_light: [
    '光在真空中的速度约是多少万公里每秒？只回答数字（万公里/秒）。',
    '真空中的光速约为多少万公里每秒？只回答数字。',
    '光速约为每秒多少万公里？只回答数字。',
  ],
  knowledge_tang: [
    '《静夜思》的作者是谁？只回答姓名。',
    '“床前明月光”出自哪位诗人？只回答姓名。',
    '《静夜思》是谁的作品？只回答姓名。',
  ],
  knowledge_dynasty: [
    '中国历史上第一个统一的中央集权王朝是哪个朝代？只回答朝代名。',
    '中国历史上第一个大一统王朝是哪个朝代？只回答朝代名。',
    '秦始皇建立的是中国第一个统一的中央集权王朝，它叫什么？只回答朝代名。',
  ],
  knowledge_chem: [
    '水的化学式是什么？只回答化学式。',
    '水分子由两个氢原子和一个氧原子构成，它的化学式是？只回答化学式。',
    '请写出水的化学式，只回答化学式本身。',
  ],
  comp_idiom: [
    '“画蛇添足”比喻什么？A. 多此一举 B. 锦上添花 只回答选项字母。',
    '成语“画蛇添足”的意思接近哪一项？A. 多此一举 B. 锦上添花 只回答选项字母。',
  ],
  extract_name: [
    '从文本中提取联系人姓名并只回答姓名："联系人：张伟，电话 13800138000"',
    '下面这段话里的联系人叫什么？只回答姓名。"联系人：张伟，电话 13800138000"',
  ],
  logic_guarantee: [
    '一个袋子里有5个红球和3个蓝球，每次随机拿出一个且不放回。至少要拿几次才能保证一定拿到一个红球？只回答数字。',
    '袋中有5个红球、3个蓝球，不放回地随机取球。要保证拿到红球，至少取几次？只回答数字。',
  ],
}

export const BANK_VERSION = 2

function materializeQuestion(question, rng) {
  const pool = PROMPT_VARIANTS[question.id]
  if (!Array.isArray(pool) || pool.length === 0) return question
  const prompt = pool[Math.floor(rng() * pool.length)]
  return { ...question, prompt, variant: prompt }
}

// 静态题 + 每次随机生成的模板题；seed 相同则结果完全一致
export function buildQuestionSet({ seed = Date.now(), includeStatic = true } = {}) {
  const rng = createSeededRng(seed)
  const staticQuestions = includeStatic ? QUESTION_BANK.map((q) => materializeQuestion(q, rng)) : []

  const generated = QUESTION_TEMPLATES.map((tpl) => {
    const built = tpl.build(rng)
    return {
      id: tpl.id,
      dimension: tpl.dimension,
      difficulty: tpl.difficulty,
      generated: true,
      ...built,
    }
  })

  return [...staticQuestions, ...generated]
}
