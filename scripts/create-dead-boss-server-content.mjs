const origin = process.env.API_ORIGIN || 'http://127.0.0.1:8002'
const login = await fetch(`${origin}/api/auth/login-password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone: '13912345678', password: '123456' }),
})
const loginBody = await login.json()
if (!login.ok || loginBody.code) throw new Error(loginBody.message || `login failed: ${login.status}`)
const token = loginBody.data.token
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const characters = [
  {
    name: '唐宁',
    roleTag: '主角',
    personality: '冷静克制，观察力强，面对压力不轻易失控',
    appearance: '28岁女性，黑色长发低马尾，浅蓝衬衫，米色西装外套，银色腕表',
    voiceSetting: '女声，冷静克制，低声压迫',
    ageGroup: 'young_adult',
    gender: 'female',
    voiceStyle: '冷静、清晰、克制',
  },
  {
    name: '赵衡',
    roleTag: '人事总监',
    personality: '表面温和，实际控制欲强',
    appearance: '38岁男性，深灰色西装，黑框眼镜，黑色皮带',
    voiceSetting: '男声，低沉温和但带压力',
    ageGroup: 'young_adult',
    gender: 'male',
    voiceStyle: '冷静、克制、压迫',
  },
  {
    name: '赵启明',
    roleTag: '已故老板',
    personality: '神秘、审慎，只通过视频和语音出现',
    appearance: '50岁男性，始终不直接露脸，办公室老板气质',
    voiceSetting: '男声，低沉、疏离、带秘密感',
    ageGroup: 'young_adult',
    gender: 'male',
    voiceStyle: '低沉、神秘',
  },
]

for (const character of characters) {
  const response = await fetch(`${origin}/api/projects/2/characters`, {
    method: 'POST',
    headers,
    body: JSON.stringify(character),
  })
  const body = await response.json()
  if (!response.ok || body.code) {
    if (body.code === 4009) continue
    throw new Error(`character ${character.name}: ${body.message || response.status}`)
  }
}

const list = await fetch(`${origin}/api/projects/2/characters`, { headers })
console.log(JSON.stringify(await list.json(), null, 2))

