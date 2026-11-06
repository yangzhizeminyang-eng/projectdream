// FastAPI-Only 迁移第六阶段：种子脚本默认上游由 Node API 切换为 FastAPI（api 服务，默认 8000，API_ORIGIN 可覆盖）。
const origin = process.env.API_ORIGIN || 'http://api:8000'
const login = await fetch(`${origin}/api/auth/login-password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone: '13912345678', password: '123456' }),
})
const loginBody = await login.json()
if (!login.ok || loginBody.code) throw new Error(loginBody.message || `login failed: ${login.status}`)
const headers = { Authorization: `Bearer ${loginBody.data.token}`, 'Content-Type': 'application/json' }

const outline = await fetch(`${origin}/api/projects/2/outline`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    title: '第一集：别签字',
    logline: '死去三天的老板给唐宁发来一封只有三个字的邮件：别签字。',
    premise: '唐宁被迫签署离职协议时，收到已故老板赵启明的警告，随后发现邮件来自自己的电脑。',
    acts: [
      { summary: '唐宁在合规办公室被赵衡逼迫签署离职协议。' },
      { summary: '邮件弹出，发件人是已故老板赵启明，正文只有别签字。' },
      { summary: '赵衡说邮件来自唐宁自己的电脑，唐宁看见父亲事故的文件。' },
    ],
    visualStyle: '都市职场悬疑电影感，冷白荧光灯，竖屏 9:16',
  }),
})
const outlineBody = await outline.json()
if (!outline.ok || outlineBody.code) throw new Error(`outline: ${outlineBody.message || outline.status}`)

const scenes = await fetch(`${origin}/api/projects/2/scenes`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    scenes: [{
      sceneNo: 1,
      title: '合规办公室：别签字',
      summary: '唐宁在公司合规办公室被人事总监赵衡逼迫签署离职协议，邮件警告和父亲事故文件相继出现。',
      location: '公司合规办公室',
      timeOfDay: '夜晚',
      estimatedDuration: 60,
    }],
  }),
})
const scenesBody = await scenes.json()
if (!scenes.ok || scenesBody.code) throw new Error(`scenes: ${scenesBody.message || scenes.status}`)
console.log(JSON.stringify({ outline: outlineBody.data, scenes: scenesBody.data }, null, 2))
