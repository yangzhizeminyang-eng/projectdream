import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAssetNodeGenerationPrompt,
  buildAssetNodeViewPrompt,
  buildAssetNodeIdentityLock,
  buildAssetNodePromptSnapshot,
  buildCharacterViewNegativePrompt,
  resolveAssetNodeGenerationPrompt,
} from './asset-node-prompt.mjs'

const character = {
  id: 30,
  name: '小光',
  role_tag: '主角',
  gender: '男',
  age_group: '儿童',
  appearance: '东亚汉族男性，单眼皮，短发，体格偏瘦',
  costume: '蓝白校服，黑色双肩书包',
  reference_image_url: 'https://cdn.test/xiaoguang.png',
}

test('same-identity node keeps the strict no-age-change lock', () => {
  const lock = buildAssetNodeIdentityLock({ character })

  assert.match(lock, /小光/)
  assert.match(lock, /同一张脸/)
  // 没有声明时空变体时，禁止改龄必须保留
  assert.match(lock, /改龄/)
})

test('time-shifted variant allows the declared age change instead of contradicting itself', () => {
  const lock = buildAssetNodeIdentityLock({
    character,
    appearanceLabel: '十八年前的老陈',
  })

  // 脸和体态始终锁死
  assert.match(lock, /同一张脸/)
  assert.match(lock, /同一体态/)
  // 但不能再禁止改龄——否则和「十八年前」自相矛盾，模型必然出错
  assert.doesNotMatch(lock, /不得换脸、改龄、改性别/)
  assert.match(lock, /十八年前的老陈/)
  assert.match(lock, /年龄呈现/)
})

test('scene node carries no character identity lock', () => {
  const lock = buildAssetNodeIdentityLock({ character: null })
  assert.equal(lock, '')

  const prompt = buildAssetNodeGenerationPrompt({
    node: { nodeType: 'scene', label: '县城医院病房', promptText: '九十年代县医院病房，白墙绿漆，铁架床' },
    projectVisualStyle: '写实电影感',
  })
  assert.match(prompt, /九十年代县医院病房/)
  assert.match(prompt, /写实电影感/)
  assert.doesNotMatch(prompt, /同一张脸/)
  assert.match(prompt, /这是场景资产，不是角色肖像/)
  assert.match(prompt, /九宫格多角度/)
})

test('scene snapshots describe panorama-to-multi-angle locking instead of character variants', () => {
  const snapshot = buildAssetNodePromptSnapshot({
    node: {
      nodeType: 'scene',
      label: '时间裂缝',
      appearanceLabel: '不要被误用的旧字段',
      promptText: '废弃车站候车厅，全景空间，锈蚀铁梁和高窗',
    },
  })

  assert.doesNotMatch(snapshot, /形象变体/)
  assert.match(snapshot, /九宫格固定视角组图/)
  assert.match(snapshot, /不生成角色肖像/)
})

test('generation prompt refuses to run on an empty node instead of inventing content', () => {
  // 既没有提示词也没有角色身份：必须返回 null，由路由如实报 400
  assert.equal(buildAssetNodeGenerationPrompt({ node: { nodeType: 'prop', label: '' } }), null)
  assert.equal(buildAssetNodeGenerationPrompt({}), null)
})

test('prop prompt asks for one complete object without character framing', () => {
  const prompt = buildAssetNodeGenerationPrompt({
    node: {
      nodeType: 'prop',
      label: '红色发卡',
      promptText: '红色蝴蝶结发卡，左侧有细斜划痕，塑料与金属夹片结构',
    },
  })

  assert.match(prompt, /单件道具/)
  assert.match(prompt, /完整.*边缘|边缘.*完整/)
  assert.match(prompt, /底部接触面/)
  assert.doesNotMatch(prompt, /从头到鞋|单人站立|角色基础正面全身图/)
})

test('document-like props default to blank surfaces instead of generated text', () => {
  const prompt = buildAssetNodeGenerationPrompt({
    node: {
      nodeType: 'prop',
      label: '离职协议',
      promptText: 'A4纸打印文件，放在深灰文件夹内，最后一页有签名栏',
    },
  })

  assert.match(prompt, /纸张、文件、文件夹、标签、屏幕和其他文档类道具默认完全无字/)
  assert.match(prompt, /不得出现.*标题.*字母.*数字.*乱码/)
  assert.match(prompt, /只生成不含文字的几何结构|只保留不含文字的几何线条/)
})

test('character node can still generate from identity alone when the prompt is empty', () => {
  const prompt = buildAssetNodeGenerationPrompt({
    node: { nodeType: 'character', refId: 30, label: '小光', promptText: '' },
    character,
  })
  assert.ok(prompt)
  assert.match(prompt, /同一张脸/)
  assert.match(prompt, /小光/)
})

test('character turnaround prompt requests front, side and back views of one locked identity', async () => {
  const result = buildAssetNodeViewPrompt({
    node: { nodeType: 'character', label: '小光', promptText: '短发，蓝白校服' },
    character,
    viewType: 'character-turnaround',
    viewKey: 'front',
    baseReferenceImageUrl: 'https://cdn.test/xiaoguang-base-full-body.png',
  })

  assert.match(result.prompt, /正面/)
  assert.match(result.prompt, /正面一个视角/)
  assert.match(result.prompt, /同一角色/)
  assert.match(result.prompt, /基础正面全身图/)
  assert.match(result.prompt, /纯白色摄影棚背景/)
  assert.match(result.prompt, /不得输出拼贴/)
  assert.deepEqual(result.referenceImageUrls, ['https://cdn.test/xiaoguang-base-full-body.png'])
  assert.equal(result.candidateCount, 1)
})

test('character turnaround prompt enforces a clean white-background full-body sheet', () => {
  const result = buildAssetNodeViewPrompt({
    node: { nodeType: 'character', label: '唐宁', promptText: '黑色短发，深灰外套，银色腕表' },
    character,
    viewType: 'character-turnaround',
    viewKey: 'front',
    baseReferenceImageUrl: 'https://cdn.test/tangning-base.png',
  })

  assert.match(result.prompt, /纯白色摄影棚背景/)
  assert.match(result.prompt, /正面一个视角/)
  assert.match(result.prompt, /只能出现一个该角色/)
  assert.match(result.prompt, /无室内环境/)
  assert.match(result.prompt, /不得输出拼贴/)
  assert.match(result.prompt, /从头顶到鞋底的完整全身照/)
  assert.match(result.prompt, /手掌和五指自然成形/)
  assert.match(result.prompt, /禁止半身照/)
})

test('base character prompt makes full head-to-shoe framing and natural anatomy explicit', () => {
  const prompt = buildAssetNodeGenerationPrompt({
    node: { nodeType: 'character', label: '林默', promptText: '28岁男性，黑框眼镜' },
    character,
  })

  assert.match(prompt, /从头顶到鞋底完整全身照/)
  assert.match(prompt, /鞋子全部入镜/)
  assert.match(prompt, /禁止半身/)
})

test('base character prompt never permits half-body framing and locks the white-background wardrobe baseline', () => {
  const prompt = buildAssetNodeGenerationPrompt({
    node: { nodeType: 'character', label: '唐宁', promptText: '浅蓝衬衫，米色西装外套，银色腕表' },
    character: { name: '唐宁', appearance: '黑色长发，低马尾', costume: '浅蓝衬衫，米色西装外套，银色腕表' },
  })

  assert.match(prompt, /纯白背景/)
  assert.match(prompt, /基础正面全身图/)
  assert.match(prompt, /服装.*唯一|唯一.*服装/)
  assert.match(prompt, /头顶到鞋底/)
  assert.match(prompt, /不得.*半身|禁止半身/)
})

test('character turnaround prompt excludes project style and story-scene context', () => {
  const result = buildAssetNodeViewPrompt({
    node: {
      nodeType: 'character',
      label: '林默',
      promptText: '约28岁，黑框眼镜，黑色短发，黑色卫衣，旧戒指',
    },
    character: {
      name: '林默',
      roleTag: '主角·收到死者邮件的程序员',
      appearance: '瘦削长脸，眼下疲惫，黑色短发略凌乱，惯于佝背',
      costume: '黑色卫衣、旧戒指、黑框眼镜',
    },
    projectVisualStyle: '冷峻科幻，冷蓝金属与红色警示灯',
    viewType: 'character-turnaround',
    viewKey: 'side',
    baseReferenceImageUrl: 'https://cdn.test/linmo-base.png',
  })

  assert.doesNotMatch(result.prompt, /冷峻科幻/)
  assert.doesNotMatch(result.prompt, /红色警示灯/)
  assert.doesNotMatch(result.prompt, /王总设下障碍|停电|电梯故障/)
  assert.match(result.prompt, /纯白色摄影棚背景/)
  assert.match(result.prompt, /只生成角色本身/)
  assert.deepEqual(result.referenceImageUrls, ['https://cdn.test/linmo-base.png'])
})

test('character turnaround prompt generates exactly one requested angle and rejects missing angles', () => {
  const result = buildAssetNodeViewPrompt({
    node: { nodeType: 'character', label: '小光', promptText: '黑色短发，蓝白校服' },
    character,
    viewType: 'character-turnaround',
    viewKey: 'side',
    baseReferenceImageUrl: 'https://cdn.test/xiaoguang-base.png',
  })

  assert.match(result.prompt, /只输出严格左侧面一个视角/)
  assert.equal(result.viewKey, 'side')
  assert.equal(result.viewIndex, 2)
  assert.equal(result.viewLabel, '严格侧面')
  assert.throws(
    () => buildAssetNodeViewPrompt({
      node: { nodeType: 'character', label: '小光', promptText: '黑色短发' },
      character,
      viewType: 'character-turnaround',
      baseReferenceImageUrl: 'https://cdn.test/xiaoguang-base.png',
    }),
    /必须指定正面、侧面或背面/,
  )
})

test('character turnaround prompt adds hard constraints for every requested angle', () => {
  for (const [viewKey, phrase] of [
    ['front', '正面硬约束'],
    ['side', '侧面硬约束'],
    ['back', '背面硬约束'],
  ]) {
    const result = buildAssetNodeViewPrompt({
      node: { nodeType: 'character', label: '小光', promptText: '黑色短发，蓝白校服' },
      character,
      viewType: 'character-turnaround',
      viewKey,
      baseReferenceImageUrl: 'https://cdn.test/xiaoguang-base.png',
    })
    assert.match(result.prompt, new RegExp(phrase))
  }
})

test('character view negative prompts reject contradictory angle features', () => {
  assert.match(buildCharacterViewNegativePrompt('side'), /正面脸|双眼/)
  assert.match(buildCharacterViewNegativePrompt('back'), /可见脸部|正面视角/)
  assert.doesNotMatch(buildCharacterViewNegativePrompt('front'), /可见脸部/)
  assert.match(buildCharacterViewNegativePrompt('front', { noFace: true }), /清晰正脸|可辨识脸部/)
})

test('character turnaround prompt refuses to bypass the confirmed base image', async () => {
  const { buildAssetNodeViewPrompt } = await import('./asset-node-prompt.mjs')

  assert.throws(
    () => buildAssetNodeViewPrompt({
      node: { nodeType: 'character', label: '小光', promptText: '短发，蓝白校服' },
      character,
      viewType: 'character-turnaround',
    }),
    /基础正面全身图/,
  )
})

test('face closeup prompt is isolated from story context and requires the confirmed base image', () => {
  const result = buildAssetNodeViewPrompt({
    node: { nodeType: 'character', label: '唐宁', promptText: '黑色长发，低马尾，浅蓝衬衫' },
    character: { name: '唐宁', appearance: '自然眉眼，长脸，黑色长发', costume: '浅蓝衬衫' },
    projectVisualStyle: '冷峻科幻，红色警示灯',
    viewType: 'character-face-closeup',
    baseReferenceImageUrl: 'https://cdn.test/tangning-base.png',
  })
  assert.match(result.prompt, /脸部特写专用资产生成/)
  assert.match(result.prompt, /双耳、下颌线/)
  assert.match(result.prompt, /基础正面全身图为唯一形象基准/)
  assert.doesNotMatch(result.prompt, /红色警示灯/)
  assert.deepEqual(result.referenceImageUrls, ['https://cdn.test/tangning-base.png'])
  assert.equal(result.viewKey, 'face')
  assert.throws(
    () => buildAssetNodeViewPrompt({
      node: { nodeType: 'character', label: '唐宁' },
      character: { name: '唐宁' },
      viewType: 'character-face-closeup',
    }),
    /基础正面全身图/,
  )
})

test('scene nine-grid prompt uses a confirmed panorama and requests one source view', async () => {
  const result = buildAssetNodeViewPrompt({
    node: { nodeType: 'scene', label: '旧车站', promptText: '锈蚀铁梁和高窗' },
    viewType: 'scene-nine-grid',
    referenceImageUrl: 'https://cdn.test/station-panorama.png',
  })

  assert.match(result.prompt, /单一环境视角/)
  assert.match(result.prompt, /不能输出九宫格/)
  assert.match(result.prompt, /全景基准图/)
  assert.match(result.prompt, /单一视角|单一环境视角/)
  assert.match(result.prompt, /锈蚀铁梁和高窗/)
  assert.doesNotMatch(result.prompt, /深夜城市公寓客厅与电脑工作区/)
  assert.deepEqual(result.referenceImageUrls, ['https://cdn.test/station-panorama.png'])
  assert.equal(result.candidateCount, 1)
  assert.throws(
    () => buildAssetNodeViewPrompt({
      node: { nodeType: 'scene', label: '旧车站', promptText: '锈蚀铁梁和高窗' },
      viewType: 'scene-nine-grid',
    }),
    /全景基准图/,
  )
})

test('scene panorama prompt preserves detailed spatial prompt and marks it as the base-image stage', () => {
  const prompt = buildAssetNodeGenerationPrompt({
    node: {
      nodeType: 'scene',
      label: '赵启明办公室',
      promptText: '现代科技公司顶层办公室，整面落地窗，黑胡桃木办公桌位于中央偏右',
    },
    projectVisualStyle: '都市悬疑，冷峻电影光影',
  })

  assert.match(prompt, /现代科技公司顶层办公室/)
  assert.match(prompt, /办公桌位于中央偏右/)
  assert.match(prompt, /全景基准图/)
  assert.match(prompt, /空间结构/)
  assert.match(prompt, /真实摄影质感/)
  assert.doesNotMatch(prompt, /深夜城市公寓客厅与电脑工作区/)
})

test('scene panorama prompt carries a stable color bible into the image request', () => {
  const prompt = buildAssetNodeGenerationPrompt({
    node: {
      nodeType: 'scene',
      label: '深夜公寓客厅',
      environmentPromptText: '深夜公寓客厅，百叶窗投下冷蓝色光条，电脑冷白屏幕光。',
    },
    projectVisualStyle: '冷峻科幻，冷蓝金属与红色警示灯',
  })

  assert.match(prompt, /主色锚点：冷蓝、青蓝、低饱和金属灰/)
  assert.match(prompt, /红色仅限局部警示灯/)
  assert.match(prompt, /禁止全画面单色滤镜/)
})

test('scene prompts encode real-space anchors and layered practical lighting', () => {
  const prompt = buildAssetNodeGenerationPrompt({
    node: {
      nodeType: 'scene',
      label: '安保值班室',
      environmentPromptText: '安保值班室，中央深色办公桌，左侧文件柜与红色警示灯，右侧暖黄色落地灯，左右各一扇关闭的金属门。',
    },
  })

  assert.match(prompt, /空间类型与功能/)
  assert.match(prompt, /固定家具[\\/]设备的数量、位置、朝向/)
  assert.match(prompt, /冷蓝环境光、暖黄灯光和局部红色警示光/)
  assert.match(prompt, /禁止全画面青蓝\/红色滤镜/)
  assert.match(prompt, /现实场地勘景照片/)
  assert.match(prompt, /真实建筑尺度/)
  assert.match(prompt, /门扇开启范围与通行宽度符合现实/)
  assert.match(prompt, /禁止无来源的装饰性布景/)
})

test('scene panorama generation prefers the isolated environment prompt over screenplay actions', () => {
  const prompt = buildAssetNodeGenerationPrompt({
    node: {
      nodeType: 'scene',
      label: '深夜公寓客厅',
      promptText: '剧情内容与功能：林默穿着黑色丧服陷在沙发里，电脑屏幕自动亮起。',
      environmentPromptText: '环境资产场景：深夜公寓客厅\n固定家具：沙发、茶几、墙上挂钟\n空场环境，禁止人物。',
    },
  })

  assert.match(prompt, /环境资产场景：深夜公寓客厅/)
  assert.match(prompt, /固定家具：沙发、茶几、墙上挂钟/)
  assert.doesNotMatch(prompt, /林默穿着黑色丧服/)
  assert.doesNotMatch(prompt, /剧情内容与功能：/)
})

test('scene panorama prompt cannot be overridden by a legacy full screenplay body prompt', () => {
  const prompt = resolveAssetNodeGenerationPrompt({
    node: {
      nodeType: 'scene',
      promptText: '完整剧本：林默穿着丧服坐在沙发上。',
      environmentPromptText: '空场公寓客厅，沙发、茶几、电脑工作区和百叶窗固定布局。',
    },
    requestedViewType: 'single',
    promptOverride: '完整剧本：林默穿着丧服坐在沙发上。',
  })

  assert.equal(prompt, '空场公寓客厅，沙发、茶几、电脑工作区和百叶窗固定布局。')
})

test('a variant may not quietly step around a locked appearance baseline', () => {
  const lock = buildAssetNodeIdentityLock({
    character,
    appearanceLabel: '5 岁的小光',
    appearanceLocked: true,
  })

  // 已锁定外貌时，变体必须在锁定基准上演绎，不能重新发明长相
  assert.match(lock, /外貌基准已锁定/)
  assert.match(lock, /同一张脸/)
  assert.match(lock, /5 岁的小光/)
})

test('prompt snapshot records what the creator actually wrote', () => {
  const snapshot = buildAssetNodePromptSnapshot({
    node: {
      nodeType: 'character',
      label: '小光',
      appearanceLabel: '5 岁的小光',
      promptText: '五岁左右的东亚汉族男性，站姿挺拔，纯白棉质衬衫',
    },
    character,
    projectVisualStyle: '写实电影感',
  })

  assert.match(snapshot, /五岁左右的东亚汉族男性/)
  assert.match(snapshot, /5 岁的小光/)
  assert.match(snapshot, /小光/)
  assert.match(snapshot, /写实电影感/)
})
