function text(value) {
  return String(value ?? '').trim()
}

function first(value, fallback = '') {
  return text(value) || fallback
}

function inferLocation(scene) {
  const explicit = first(scene?.location)
  if (explicit) return explicit
  const source = [scene?.title, scene?.summary, scene?.content].map(text).join(' ')
  if (/会议室|离职协议|人事|合规/u.test(source)) return '公司合规会议室'
  if (/公寓|沙发|百叶窗|冷咖啡|冰箱/u.test(source)) return '深夜公寓客厅'
  if (/办公室|书架|办公椅|摄像头/u.test(source)) return '公司办公室视频空间'
  if (/机房|服务器|主节点/u.test(source)) return '公司核心机房'
  if (/葬礼|灵堂|花圈|遗照/u.test(source)) return '葬礼灵堂'
  return '未命名空间'
}

function inferTime(scene) {
  const explicit = first(scene?.timeOfDay ?? scene?.time_of_day)
  if (explicit) return explicit
  const source = [scene?.title, scene?.summary, scene?.content].map(text).join(' ')
  if (/深夜|凌晨|午夜|00:00|夜晚|夜里/u.test(source)) return '深夜'
  if (/傍晚|黄昏/u.test(source)) return '傍晚'
  if (/清晨|早晨|黎明/u.test(source)) return '清晨'
  return '当前时段'
}

function inferHook(scene) {
  const source = `${text(scene?.title)} ${text(scene?.summary)} ${text(scene?.content)}`
  if (/签字|签署|签名栏/u.test(source)) return '离职协议签字前'
  if (/邮件|发件人/u.test(source)) return '收到亡者邮件'
  if (/电脑|屏幕|代码|系统/u.test(source)) return '电脑异常启动'
  if (/视频|监控|摄像头/u.test(source)) return '遗留视频画面'
  if (/档案|日志|文件/u.test(source)) return '关键档案线索'
  return first(scene?.title, '剧情关键空间')
}

export function buildSceneDisplayLabel(scene = {}) {
  const sceneNo = Number(scene?.sceneNo ?? scene?.scene_no)
  const prefix = Number.isInteger(sceneNo) && sceneNo > 0 ? `场景${String(sceneNo).padStart(2, '0')}` : '场景'
  const location = inferLocation(scene)
  const time = inferTime(scene)
  const hook = inferHook(scene)
  return `${prefix} · ${time}${time === '当前时段' ? '' : ' · '}${hook}`
}

export { inferLocation as inferSceneLabelLocation }
