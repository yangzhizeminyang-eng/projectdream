export type StudioScriptAgentCommand =
  | { type: 'generate-bible' }
  | { type: 'generate-season' }
  | { type: 'generate-script' }
  | { type: 'parse-assets' }
  | { type: 'save-script' }
  | { type: 'guidance'; text: string }

const COMMANDS: Array<{ type: Exclude<StudioScriptAgentCommand['type'], 'guidance'>; pattern: RegExp }> = [
  { type: 'generate-bible', pattern: /(生成|设计|重做|完善).*(故事设定|人物设定|世界观|设定)/ },
  { type: 'generate-season', pattern: /(生成|设计|整理|重做).*(分集大纲|大纲)/ },
  { type: 'generate-script', pattern: /(生成|设计|重做|直接).*(全剧正文|剧本正文|剧本)/ },
  { type: 'parse-assets', pattern: /(解析|提取|拆解).*(角色|场景|资产|人物)/ },
  { type: 'save-script', pattern: /(保存|提交|保留).*(当前|本次|剧本|正文|修改)/ },
]

export function resolveAgentCommand(input: string): StudioScriptAgentCommand {
  const text = input.trim()
  for (const command of COMMANDS) {
    if (command.pattern.test(text)) return { type: command.type }
  }
  return { type: 'guidance', text }
}
