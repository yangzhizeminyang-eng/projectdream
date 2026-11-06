import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCharacterTurnaroundPrompt,
  buildCharacterAssetPackPrompt,
  buildScriptCharacterPrompt,
  buildSceneEnvironmentPrompt,
  buildScriptScenePrompt,
  buildTemporalVariantPrompt,
  inferCharacterCostumeFromScenes,
  inferSceneLocation,
  inferSceneTimeOfDay,
  isLegacyCharacterPrompt,
} from './asset-character-prompt.mjs'

const character = {
  name: '唐宁',
  role_tag: '主角',
  age_group: 'young_adult',
  gender: 'female',
  appearance: '28岁，黑色长发低马尾，面部轮廓清晰，冷静的眼神',
  costume: '浅蓝衬衫、米色西装外套、银色腕表',
  personality: '冷静克制，观察力强，在压力下坚持查明真相',
  voice_style: '清晰、克制，语速稳定，情绪压低',
}

test('character asset pack prompt locks the fixed board layout and safe crops', () => {
  const prompt = buildCharacterAssetPackPrompt({
    character,
    projectVisualStyle: '都市悬疑写实',
    projectCategory: '悬疑推理漫剧',
  })
  assert.match(prompt, /同一角色资产包基准板/)
  assert.match(prompt, /左列占画布约48%/)
  assert.match(prompt, /右上区域固定占右列上方约42%/)
  assert.match(prompt, /右下区域固定从y约47%开始，占右列下方约51%/)
  assert.match(prompt, /左列只允许一张/)
  assert.match(prompt, /只允许一张独立正面脸部特写/)
  assert.match(prompt, /右下区域固定从y约47%开始，占右列下方约51%，必须横向三等分/)
  assert.match(prompt, /缺少脸部特写或任一全身区域都视为失败/)
  assert.match(prompt, /严格90度侧面/)
  assert.match(prompt, /头发顶部、双耳、完整下颌/)
  assert.match(prompt, /禁止输出海报、标题、标签、文字/)
  assert.match(prompt, /服装漂移/)
  assert.match(prompt, /脸部特写是五官、脸型/u)
  assert.match(prompt, /正面全身照是身高比例/u)
  assert.match(prompt, /三视图必须同时回看这两个基准/u)
  assert.match(prompt, /任何一个视图五官变形/u)
})

test('builds a stable character prompt from script profile and matching scenes', () => {
  const result = buildScriptCharacterPrompt({
    character,
    scenes: [
      {
        sceneNo: 1,
        title: '合规办公室',
        location: '公司会议室',
        timeOfDay: '白天',
        content: '唐宁被要求签署离职协议，收到赵启明的邮件。',
      },
      {
        sceneNo: 2,
        title: '无关场景',
        location: '街道',
        timeOfDay: '夜',
        content: '只有路人经过。',
      },
    ],
    projectVisualStyle: '都市职场悬疑，电影感写实竖屏',
  })

  assert.equal(result.source, 'script-agent')
  assert.equal(result.version, 'script-character-prompt-v1')
  assert.match(result.prompt, /唐宁/)
  assert.match(result.prompt, /浅蓝衬衫、米色西装外套、银色腕表/)
  assert.doesNotMatch(result.prompt, /合规办公室/)
  assert.doesNotMatch(result.prompt, /公司会议室/)
  assert.match(result.prompt, /服装与随身物件/)
  assert.match(result.prompt, /完整角色资产板/)
  assert.match(result.prompt, /纯白背景/)
  assert.match(result.prompt, /单人正面完整全身|左侧基础正面全身/)
  assert.match(result.prompt, /左侧基础正面全身/)
  assert.match(result.prompt, /正面\/严格侧面\/背面三张全身视图/)
  assert.match(result.prompt, /不按固定坐标裁切/)
  assert.doesNotMatch(result.prompt, /固定服装与随身物件：未提供，等待人工补充/)
  assert.match(result.negativePrompt, /换脸/)
  assert.match(result.negativePrompt, /第二个人/)
  assert.match(result.turnaroundPrompt, /只读取已确认基础正面全身图/)
  assert.match(result.turnaroundPrompt, /严格90度侧面/)
  assert.match(result.turnaroundPrompt, /纯白背景/)
  assert.match(result.turnaroundPrompt, /自然轻微面部不对称/)
  assert.match(result.prompt, /真人结构细节/)
})

test('character prompt receives the selected genre skill without leaking scene identity', () => {
  const result = buildScriptCharacterPrompt({
    character: { name: '唐宁', appearance: '黑色长发' },
    projectCategory: '悬疑推理漫剧',
  })
  assert.match(result.prompt, /题材技能配置：悬疑推理/)
  assert.match(result.prompt, /信息差/)
  assert.doesNotMatch(result.prompt, /公司合规会议室/)
})

test('script character prompt refuses to claim unsupported plot facts', () => {
  const result = buildScriptCharacterPrompt({
    character: { name: '赵衡', role_tag: '人事总监', appearance: '黑框眼镜' },
    scenes: [
      { sceneNo: 1, title: '会议室', content: '唐宁签署离职协议。' },
    ],
  })

  assert.doesNotMatch(result.prompt, /剧本出场场景/)
  assert.doesNotMatch(result.prompt, /他在会议室逼迫唐宁/)
})

test('character prompt extracts fixed clothing and carried objects from matching script evidence', () => {
  const scenes = [{
    title: '深夜公寓客厅',
    content: '林默穿黑色丧服，领带松垮地挂在脖子上。他戴着黑框眼镜，无名指上有一枚旧戒指，握着手机的手开始发抖。他翻找咖啡杯垫，但那张咖啡杯垫林默至今留着。',
  }]
  const costume = inferCharacterCostumeFromScenes(scenes, '林默')
  assert.match(costume, /黑色丧服/)
  assert.match(costume, /领带/)
  assert.match(costume, /黑框眼镜/)
  assert.match(costume, /旧戒指/)
  assert.match(costume, /咖啡杯垫/)
  assert.doesNotMatch(costume, /手机的手/)
  assert.doesNotMatch(costume, /翻找/)
  const result = buildScriptCharacterPrompt({ character: { name: '林默' }, scenes })
  assert.match(result.prompt, /固定服装与随身物件：/)
  assert.doesNotMatch(result.prompt, /生成前必须补齐/)
  assert.match(result.turnaroundPrompt, /黑色丧服/)
})

test('only known poisoned costume lines are eligible for automatic prompt hydration', () => {
  assert.equal(isLegacyCharacterPrompt('固定服装与随身物件：手机的手开始发抖；那张咖啡杯垫；似乎也捏着一枚同款咖啡杯垫'), true)
  assert.equal(isLegacyCharacterPrompt('固定服装与随身物件：黑色丧服；松垮领带；黑框眼镜；旧戒指；咖啡杯垫'), false)
  assert.equal(isLegacyCharacterPrompt('固定服装与随身物件：用户手动改为黑色风衣；手机仅作为本镜头道具'), false)
})

test('does not invent missing character facts and keeps the negative prompt deterministic', () => {
  const result = buildScriptCharacterPrompt({
    character: { name: '赵衡', role_tag: '人事总监', personality: '表面温和，实际控制欲强' },
    scenes: [],
  })

  assert.match(result.prompt, /角色名：赵衡/)
  assert.doesNotMatch(result.prompt, /黑色长发/)
  assert.doesNotMatch(result.prompt, /默认服装：/)
  assert.match(result.prompt, /由 Agent 根据剧本场景、时代、身份和动作自动整理/)
  assert.equal(
    result.negativePrompt,
    '换脸、改变年龄、改变性别、第二个人、多人、半身裁切、缺失手脚、畸形手指、错误服装、文字、水印、Logo、低清晰度、过度模糊、重复角色',
  )
})

test('identifies temporal states from character appearances in script scenes', () => {
  const result = buildScriptCharacterPrompt({
    character: { name: '唐宁' },
    scenes: [
      { sceneNo: 1, title: '现在的合规办公室', content: '唐宁收到老板邮件。' },
      { sceneNo: 2, title: '五年前的事故现场', content: '唐宁回忆父亲事故。' },
    ],
  })

  assert.match(result.prompt, /Agent 已识别时空状态/)
  assert.match(result.prompt, /现在/)
  assert.match(result.prompt, /五年前/)
  assert.match(result.prompt, /每个状态单独排版为一组资产/)
})

test('does not treat a historical incident mentioned in a current scene as the character state', () => {
  const result = buildScriptCharacterPrompt({
    character: { name: '唐宁', appearance: '28岁，黑色长发低马尾' },
    scenes: [{
      sceneNo: 1,
      title: '别签字',
      content: '唐宁收到邮件，邮件提到她父亲五年前的事故不是意外。',
    }],
  })

  assert.match(result.prompt, /Agent 暂未识别多个时空状态/)
  assert.doesNotMatch(result.prompt, /Agent 已识别时空状态：五年前/)
})

test('builds a standalone turnaround prompt from the character asset fields', () => {
  const prompt = buildCharacterTurnaroundPrompt({
    character: {
      name: '唐宁',
      appearance: '28岁，黑色长发低马尾，清瘦鹅蛋脸',
      costume: '浅蓝衬衫、米色西装外套、银色腕表',
    },
  })

  assert.match(prompt, /唐宁/)
  assert.match(prompt, /清瘦鹅蛋脸/)
  assert.match(prompt, /浅蓝衬衫、米色西装外套、银色腕表/)
  assert.match(prompt, /不读取剧情场景/)
  assert.match(prompt, /从头顶到鞋底完整入镜/)
})

test('builds detailed scene prompts from episode script, time and project style', () => {
  const prompt = buildScriptScenePrompt({
    scene: {
      title: '赵启明办公室',
      location: '公司顶层办公室',
      time_of_day: '夜晚',
      summary: '唐宁发现老板遗留的加密邮件，桌上有一台打开的笔记本电脑。',
    },
    projectVisualStyle: '都市悬疑，冷峻电影光影',
  })

  assert.doesNotMatch(prompt, /唐宁/)
  assert.doesNotMatch(prompt, /加密邮件/)
  assert.match(prompt, /环境空间证据/)
  assert.match(prompt, /公司顶层办公室/)
  assert.match(prompt, /时空：夜晚/)
  assert.match(prompt, /建筑\/开口方位/)
  assert.match(prompt, /先生成并采用唯一母版/u)
})

test('scene asset prompt keeps spatial clues but excludes character identity and performance', () => {
  const prompt = buildScriptScenePrompt({
    scene: {
      title: '深夜公寓客厅',
      content: '林默穿黑色丧服陷在沙发里，窗外霓虹透过百叶窗形成冷蓝光条；茶几上有冷咖啡，电脑桌靠近右侧墙面。',
    },
  })

  assert.match(prompt, /沙发/)
  assert.match(prompt, /百叶窗/)
  assert.match(prompt, /茶几/)
  assert.match(prompt, /电脑桌靠近右侧墙面/)
  assert.doesNotMatch(prompt, /林默/)
  assert.doesNotMatch(prompt, /黑色丧服/)
  assert.doesNotMatch(prompt, /陷在沙发里/)
})

test('scene environment evidence excludes story UI text and human body fragments', () => {
  const prompt = buildSceneEnvironmentPrompt({
    scene: {
      title: '遗留视频画面',
      location: '办公室视频画面',
      content: '深色西装肩线、白衬衫袖口和银色腕表出现在画面中，显示器播放视频，邮件账号和字幕闪过。',
    },
  })
  assert.doesNotMatch(prompt, /白衬衫袖口/)
  assert.doesNotMatch(prompt, /银色腕表出现在画面/)
  assert.match(prompt, /纸张与屏幕如属空间物件，只呈现无字状态/u)
})

test('scene environment prompt preserves explicit fixed fixtures even when their clause also describes an action', () => {
  const prompt = buildSceneEnvironmentPrompt({
    scene: {
      title: '失物招领处夜班值班台',
      location: '市失物招领处夜班值班台',
      time_of_day: '深夜23:40',
      content: '值班台右上方的台灯是唯一主光。传送窗口滑出一枚红色发卡，发卡停在窗口下沿。窗外走廊尽头亮着绿色安全出口灯。',
    },
  })

  assert.match(prompt, /剧本明确固定设施（必须在场景资产中出现）：[\s\S]*传送窗口/u)
  assert.match(prompt, /值班台/u)
  assert.match(prompt, /绿色安全出口灯/u)
  assert.doesNotMatch(prompt, /林知夏|红色发卡滑出/u)
})

test('scene prompts scope an episode-level location list to the active screenplay section', () => {
  const scene = {
    title: '场景01 · 夜 · 电脑异常启动',
    location: '市失物招领处夜班值班台、监控回放区、档案柜前、走廊尽头的旧储物柜',
    time_of_day: '夜',
    content: '【23:40 失物招领处·夜班值班台】台灯为唯一主光，传送窗口滑出一枚红色发卡。\n【监控回放·23:37】监控屏幕暂停。\n【档案柜前】打开档案柜。',
  }

  const prompt = buildSceneEnvironmentPrompt({ scene })
  assert.match(prompt, /空间类型与功能：.*夜班值班台/u)
  assert.doesNotMatch(prompt, /对应视频\/监控\/回忆内容/u)
  assert.doesNotMatch(prompt, /档案柜、走廊尽头的旧储物柜/u)
})

test('video and flashback scene assets normalize close-up locations to an empty panorama', () => {
  const prompt = buildSceneEnvironmentPrompt({
    scene: {
      title: '赵启明遗留视频',
      location: '办公室视频画面—办公桌肩手近景（视频画面）',
      content: '视频画面发生在办公室。',
    },
  })
  assert.match(prompt, /完整室内空间空场全景/)
  assert.match(prompt, /忽略原文中的肩手近景/)
})

test('scene prompt prefers the full screenplay content over a short summary', () => {
  const prompt = buildScriptScenePrompt({
    scene: {
      title: '死后三天',
      summary: '老板葬礼后第三天，林默收到一封来自亡者的邮件。',
      content: '深夜，公寓里没有开灯。窗外城市霓虹透过百叶窗切成冷蓝色的光条，落在茶几上的一杯冷咖啡上。电脑屏幕自动亮起，林默断开网线并用手机热点连接。',
    },
  })

  assert.match(prompt, /公寓里没有开灯/)
  assert.match(prompt, /百叶窗/)
  assert.match(prompt, /冷咖啡/)
  assert.doesNotMatch(prompt, /剧情内容与功能：老板葬礼后第三天，林默收到一封来自亡者的邮件。/)
})

test('scene prompts include the selected genre skill profile', () => {
  const prompt = buildScriptScenePrompt({
    scene: {
      title: '合规机房',
      content: '冷白灯下，服务器机柜沿东墙排列，红色状态灯周期性闪烁。',
    },
    projectCategory: '科幻悬疑',
  })

  assert.match(prompt, /题材技能配置：悬疑推理/)
  assert.match(prompt, /连续性规则/)
  assert.match(prompt, /服务器机柜沿东墙排列/)
})

test('scene prompt derives actionable defaults when the screenplay omits location and time', () => {
  const prompt = buildScriptScenePrompt({
    scene: {
      title: '死后三天',
      summary: '林默深夜回家，电脑自动亮起，收到已故老板的邮件。',
    },
    projectVisualStyle: '冷峻科幻，冷蓝金属与红色警示灯',
  })

  assert.match(prompt, /地点未明确/)
  assert.match(prompt, /深夜（根据正文光线与时间线推断）/)
  assert.match(prompt, /环境空间证据/)
  assert.match(prompt, /角色、人物照片\/遗像\/倒影/u)
  assert.match(prompt, /空间功能与尺度、建筑\/开口方位/u)
  assert.match(prompt, /最小可拍摄布局/u)
  assert.match(prompt, /电脑自动亮起/)
})

test('scene prompt infers an actionable room and time from screenplay evidence', () => {
  const scene = {
    title: '别签字',
    content: '夜。冷蓝会议室里，离职协议压在会议桌上，红色警示灯每三秒闪一次。',
  }

  assert.match(inferSceneLocation(scene), /公司合规会议室/)
  assert.match(inferSceneTimeOfDay(scene), /深夜/)
  assert.match(buildScriptScenePrompt({ scene }), /公司合规会议室/)
  assert.match(buildSceneEnvironmentPrompt({ scene }), /红色警示灯/)
})

test('builds a separate costume and prop constraint for each temporal variant', () => {
  const prompt = buildTemporalVariantPrompt('角色基础提示词', '五年前的学生时期')
  assert.match(prompt, /五年前的学生时期/)
  assert.match(prompt, /固定服饰/)
  assert.match(prompt, /随身物件/)
  assert.match(prompt, /单独成组/)
})

test('scene environment prompt keeps Agent spatial evidence but removes character action evidence', () => {
  const prompt = buildSceneEnvironmentPrompt({
    scene: {
      title: '丧服与挂钟',
      location: '深夜公寓客厅',
      time_of_day: '深夜',
      content: '构图锚点：沙发占据前景，林默半陷其中；身后百叶窗和城市霓虹构成冷蓝色背景光源。固定结构：墙面挂钟、大面积窗户/百叶窗、茶几。主要道具：黑色丧服、松垮领带、冷咖啡杯、沙发。动作：林默盯住挂钟，随后起身走向电脑区；同期声含葬礼悼词回响。',
    },
    projectVisualStyle: '冷峻科幻，冷蓝金属与红色警示灯',
  })

  assert.match(prompt, /沙发|百叶窗|挂钟|茶几|电脑工作区/)
  assert.doesNotMatch(prompt, /林默/)
  assert.doesNotMatch(prompt, /黑色丧服|松垮领带/)
  assert.doesNotMatch(prompt, /随后起身|同期声|悼词/)
})

test('scene environment prompt reads persisted spatial anchor JSON', () => {
  const spatialAnchors = {
    version: 1,
    anchors: [{ id: 'L1', category: 'light', label: '屏幕光', narrative_reason: '剧情需要' }],
    view_bindings: {},
  }
  const prompt = buildSceneEnvironmentPrompt({
    scene: { title: '深夜机房', spatial_anchors_json: JSON.stringify(spatialAnchors) },
  })

  assert.match(prompt, /空间锚点 JSON（唯一结构来源）：\{"version":1,"anchors":\[\{"id":"L1"/u)
})

test('scene prompt composes one canonical scene skill and keeps plot evidence environment-only', () => {
  const prompt = buildScriptScenePrompt({
    characterNames: ['林知夏', '周砚'],
    scene: {
      title: '失物招领处夜班',
      location: '市失物招领处值班台',
      time_of_day: '夜',
      content: '林知夏按下暂停，周砚走到档案柜前说：“我要比对入库时间。”值班台右上方台灯照亮登记台，走廊尽头亮着绿色安全出口灯。',
    },
  })

  assert.equal((prompt.match(/提示词模板技能：prompt-template-skill-v2/g) || []).length, 1)
  assert.equal((prompt.match(/全景阶段必须输出可持久化的 spatial_anchors JSON/g) || []).length, 1)
  assert.doesNotMatch(prompt, /林知夏|周砚|我要比对入库时间/u)
  assert.match(prompt, /台灯|登记台|绿色安全出口灯/u)
  assert.doesNotMatch(prompt, /只改变摄像机位置/u)
})

test('full episode scene evidence excludes named characters, dialogue and performance while retaining spatial anchors', () => {
  const prompt = buildScriptScenePrompt({
    characterNames: ['林知夏', '周砚', '陈默', '小满'],
    scene: {
      title: '明日凌晨遗失',
      location: '失物招领处值班室与后门走廊',
      time_of_day: '夜',
      content: '00:47。值班室左侧监控屏冷蓝，右侧台灯暖黄，光在登记台中央切开一条窄界。林知夏把红色发卡放在登记簿上，标签朝上：“明日凌晨遗失”。周砚站在监控屏冷光里，腰间钥匙轻响。她起身去后门走廊，铁皮归还箱在尽头。',
    },
  })

  const evidence = prompt.match(/环境空间证据：([^\n]+)/u)?.[1] || ''
  assert.match(evidence, /监控屏冷蓝|台灯暖黄|登记台|后门走廊|归还箱/)
  assert.doesNotMatch(evidence, /林知夏|周砚|明日凌晨遗失|腰间钥匙轻响|起身去/u)
})

test('scene evidence remains isolated when the caller has no character catalog', () => {
  const prompt = buildScriptScenePrompt({
    scene: {
      title: '夜班值守',
      location: '失物招领处值班室',
      content: '林知夏把发卡放在登记台上。周砚站在监控屏旁，腰间钥匙轻响。值班室左侧监控屏冷蓝，右侧台灯暖黄。划痕是去湖边那天刮的。',
    },
  })
  const evidence = prompt.match(/环境空间证据：([^\n]+)/u)?.[1] || ''
  assert.match(evidence, /监控屏冷蓝|台灯暖黄/)
  assert.doesNotMatch(evidence, /林知夏|周砚|钥匙轻响|把发卡|站在|失主栏|无名指|戒指|划痕|去湖边|刮的|系统|空白/u)
})
