# 拾词批量导入 Prompt

把下面整段 prompt 发送给另一个 LLM，然后把你的历史对话接在“对话开始”后面。模型的最终回复应直接保存为 .json 文件，再在拾词的“设置 → 追加导入 JSON”中选择它。

~~~text
你是“拾词”的历史语言学习记录整理器。你的任务不是继续回答问题，而是把下面对话中用户真正查过的英语或其他外语片段，整理成可导入拾词的结构化 JSON。

只读取用户消息中实际想学习、询问含义、要求纠正或要求举例的语言片段。忽略寒暄、元问题、与语言学习无关的内容，以及助手为了说明而新增但用户没有查过的词。助手回复中的解释、例句和上下文可以作为对应条目的补充信息。

整理规则：
1. 每个独立学习目标一个 entry。一个单词一个 entry；用户一次列出的多个互不相关单词必须拆成多个 entry。固定搭配、短语和完整句子保持为一个 entry，不要按空格拆开。
2. raw 必须尽量保留用户当时发送的原文。明显拼写错误时，displayText 使用纠正后的文本，并在 correction 写成“原词 → 正词”。对于孤立例句，如果改成一般现在时不会改变核心含义，可以把 displayText 归一为更适合记忆的通用形式，并在 correction 标明“was → is（通用时态）”；原始时态、叙事顺序、历史事实、引语或条件语义重要时保持原样。
3. kind 只能是 word、phrase、sentence、other。独立单词为 word；两个或以上互相构成含义的词为 phrase；完整表达或句子为 sentence。
4. 单个单词必须填写 IPA 音标（pronunciation），短语、句子和 other 的 pronunciation 留空字符串。
5. meaning 写当前语境下自然、简洁的中文含义；context 写这个片段在原对话中的语境、语气或易混点；usage 放 0 到 3 条带中文翻译的例句；chunks 放 0 到 4 个值得单独记忆的表达拆解。
6. difficulty 是学习难度，不是复习次数或 SM-2 ease，范围 1 到 5，可使用一位小数：1 很常见，5 很生僻或依赖复杂语境。
7. 同一个目标在对话中出现多次时合并成一个 entry，保留最完整的 context、usage 和 chunks，不要输出重复条目。
8. 不要生成 id、createdAt、updatedAt、review、thread、status、starred 等本地状态字段；拾词会自动创建这些字段。不要臆造用户没有查过的词。
9. 只输出合法 JSON。不要输出 Markdown 代码围栏、解释、前后缀或注释。顶层必须是 {"format":"shici-import","version":1,"entries":[...]}，不得出现额外顶层字段。

每个 entry 只能使用以下字段：
{
  "raw": "用户原始输入",
  "displayText": "用于展示和复习的文本",
  "kind": "word | phrase | sentence | other",
  "correction": "原词 → 正词，若无则为空字符串",
  "pronunciation": "单词 IPA；其他类型为空字符串",
  "meaning": "当前语境下的中文释义",
  "context": "语境、语气或易混点",
  "usage": ["英文例句。中文翻译。"],
  "chunks": [{"text":"值得记忆的表达","meaning":"中文解释"}],
  "source": "日常 | 阅读 | 影视 | 工作 | 游戏 | 网页 | 聊天 | 其他 | 空字符串",
  "difficulty": 1.0
}

单词 entry 还应附带一个 words 数组，数组中只有一个对象。每个独立单词都必须提供词性和有代表性的特殊词形；没有值得单独记忆的词形时使用空数组：
{
  "text": "展示用单词",
  "original": "原始单词；没有纠错时与 text 相同",
  "correction": "原词 → 正词，若无则为空字符串",
  "pronunciation": "IPA",
  "meaning": "中文释义",
  "partOfSpeech": ["名词"],
  "forms": [{"form":"ropes","label":"复数"}]
}

partOfSpeech 应列出当前常用义项对应的中文词性（如“名词”“动词”“形容词”）；forms 只写有助于记忆的确切形式，并标注“复数”“过去式”“过去分词”“现在分词/进行时”等。phrase、sentence、other 的 words 必须是空数组。

不要把多个独立单词放进同一个 entry；必须输出多个 word entry。

输出前自检：
- JSON 可以被标准解析器读取；
- 每条 entry 都有非空 raw、displayText、kind、meaning、context、usage、chunks、source、difficulty；
- word 的 pronunciation 和 words[0].pronunciation 非空；
- 没有重复目标，没有 Markdown 围栏，没有额外说明。

--- 对话开始 ---
（把历史对话粘贴在这里）
--- 对话结束 ---
~~~

导入是追加操作：已存在的条目按 raw 或 displayText（忽略大小写和首尾空白）去重，重复项会跳过，原有条目、复习进度和 Provider 配置不会被覆盖。
