export const DEAD_BOSS_PROJECT_NAME = '死去的老板给我发邮件'
export const DEAD_BOSS_PRODUCTION_BATCH = 'dead-boss-episode-one-v1'
export const DEAD_BOSS_ASPECT_RATIO = '9:16'

export const DEAD_BOSS_CHARACTERS = [
  {
    key: 'tang-ning',
    name: '唐宁',
    roleTag: '女主角 / 公司合规专员',
    personality: '冷静、克制、观察力强；压力越大越会先确认事实再行动。',
    appearance: '28岁中国女性，黑色长发低马尾，清冷利落的脸型，眼神克制，身形修长。',
    costume: '浅蓝色衬衫、米色西装外套和米色西裤、银色腕表、简洁白色低跟鞋。',
    ageGroup: 'young_adult',
    gender: 'female',
    voiceProfileKey: 'female-young-warm',
    voiceStyle: '年轻成年女性，清晰自然，克制中带有逐步升高的紧张感；不撒娇，不夸张尖叫。',
    voiceSetting: '中文对白，近距离办公室实录感；前段冷静，中段压低呼吸，结尾进入警觉和反击。',
    sourceMatcher: (fileName) => fileName.includes('女主') && fileName.includes('唐宁'),
  },
  {
    key: 'zhao-heng',
    name: '赵衡',
    roleTag: '反派 / 人事总监',
    personality: '表面温和，实际控制欲强；从不提高音量，但每句话都带压力。',
    appearance: '38岁中国男性，短黑发，黑框眼镜，面部线条清晰，神情冷静克制。',
    costume: '深灰色西装、白色衬衫、黑色皮带、黑色皮鞋、黑框眼镜。',
    ageGroup: 'middle_aged',
    gender: 'male',
    voiceProfileKey: 'male-middle-authority',
    voiceStyle: '成年男性低沉、稳定、礼貌表面下带控制感；不咆哮，尾音略压低。',
    voiceSetting: '中文对白，近距离办公室声场；像在用流程和规则逼迫对方，情绪从催签转为危险的冷静。',
    sourceMatcher: (fileName) => fileName === '赵衡.png',
  },
  {
    key: 'zhao-qiming',
    name: '赵启明',
    roleTag: '已故老板 / 视频与语音信息发布者',
    personality: '谨慎、深沉，像提前为最坏结果留下证据。',
    appearance: '50岁中国男性；本集只允许出现肩膀、手和手表，不出现正脸、不出现完整头部。',
    costume: '深色西装袖口、白色衬衫袖口、银色机械腕表；画面只聚焦手部和肩部。',
    ageGroup: 'middle_aged',
    gender: 'male',
    voiceProfileKey: 'male-adult-calm',
    voiceStyle: '50岁左右男性，低沉、疲惫、清晰，像录下遗言；重要信息前有短暂停顿。',
    voiceSetting: '中文语音，带轻微设备电流和旧录音质感；绝不加入英文、额外解释或随机台词。',
    sourceMatcher: (fileName) => fileName.startsWith('jimeng-'),
  },
]

const officeStyle =
  '写实都市悬疑漫剧，电影级办公室夜景，冷白顶灯与电脑蓝光，少量深红警示光，低饱和、真实材质、竖屏 9:16 原生构图，画面边缘不留黑边，不要水印，不要英文。'

function shot({
  key,
  sceneNo,
  shotNo,
  durationSeconds,
  shotType,
  cameraAngle,
  composition,
  characterName,
  characterKey,
  actionText,
  dialogueText,
  visualPrompt,
  shotPurpose,
  actingBeat,
  audioDirection,
  startVisualPrompt,
  endVisualPrompt,
  primarySubject,
  visibleEntities,
  referencedEntities,
  forbiddenEntities,
  reactionShot = false,
}) {
  return {
    key,
    sceneNo,
    shotNo,
    durationSeconds,
    shotType,
    cameraAngle,
    composition,
    characterName,
    characterKey,
    actionText,
    dialogueText,
    visualPrompt: `${officeStyle} ${visualPrompt}`,
    shotPurpose,
    actingBeat,
    audioDirection,
    startVisualPrompt,
    endVisualPrompt,
    reactionShot,
    continuityOverrides: {
      primarySubject,
      primaryAction: actionText,
      visibleEntities,
      referencedEntities,
      forbiddenEntities: [
        '未声明人物',
        '未声明道具',
        '英文对白或字幕',
        '随机新增台词',
        ...forbiddenEntities,
      ],
    },
  }
}

export const DEAD_BOSS_SCENES = [
  {
    sceneNo: 1,
    title: '办公室：别签字与U盘',
    location: '公司合规办公室',
    timeOfDay: '深夜',
    estimatedDuration: 33,
    mood: '从即将签字的压迫，进入死亡信息和七分钟倒计时。',
    summary: '唐宁即将签署离职及保密协议，收到死去三天的赵启明发来的“别签字”，并按语音指令找到第三层抽屉和黑色U盘。',
    content:
      '唐宁在深夜办公室签署离职及保密协议。手机亮起，发件人显示赵启明，死亡时间为三天前。赵衡画外音催促她签字。赵启明语音要求她打开办公桌第三层抽屉，底板下有黑色U盘，并说她只有七分钟。唐宁走向抽屉，赵衡在玻璃门边观察。唐宁掀开底板取出U盘并插入电脑。',
  },
  {
    sceneNo: 2,
    title: '办公室：父亲事故不是意外',
    location: '公司合规办公室',
    timeOfDay: '深夜',
    estimatedDuration: 27,
    mood: '从发现证据的紧张，升级到父亲事故真相和赵衡封锁现场的悬念。',
    summary: '唐宁找到黑色U盘，赵启明的视频只露肩膀和手，揭示她父亲的事故不是意外；赵衡闯入并将她锁在办公室。',
    content:
      '电脑里的赵启明视频只出现肩膀和手，告诉唐宁她父亲五年前的事故不是意外。赵衡突然出现，按住电脑屏幕。最后一段语音中断，赵衡反锁办公室，电脑却显示邮件从唐宁自己的电脑发出。',
  },
]

export const DEAD_BOSS_SHOTS = [
  shot({
    key: 's1-01',
    sceneNo: 1,
    shotNo: '01',
    durationSeconds: 3,
    shotType: '特写 / 极近景',
    cameraAngle: '桌面低角度微推',
    composition: '签字笔与协议占下半部，手机亮起成为唯一高亮主体',
    characterName: '唐宁',
    characterKey: 'tang-ning',
    actionText: '黑色签字笔停在《离职及保密协议》签字线前，唐宁即将落笔；手机突然震动亮起。',
    dialogueText: '',
    visualPrompt:
      '只拍唐宁的手、签字笔、协议和手机，不出现其他人物；手机屏幕清楚显示“赵启明：别签字。”，屏幕文字必须为简体中文且只出现这一句。',
    shotPurpose: 'hook',
    actingBeat: '笔尖即将落下时立刻被手机震动打断，异常在前三秒内明确出现。',
    audioDirection: '签字笔轻触纸面声，手机震动声，悬疑低频音乐从极轻开始；无对白。',
    startVisualPrompt: '签字笔尖距签字线不到一厘米，协议和办公室桌面静止。',
    endVisualPrompt: '手机亮起并震动，屏幕显示“赵启明：别签字。”，笔尖停住。',
    primarySubject: '手机与签字笔',
    visibleEntities: ['签字笔', '离职及保密协议', '手机'],
    referencedEntities: ['唐宁'],
    forbiddenEntities: ['赵启明实体正脸', '多余通知', '英文界面文字'],
  }),
  shot({
    key: 's1-02',
    sceneNo: 1,
    shotNo: '02',
    durationSeconds: 5,
    shotType: '手机特写 + 面部近景',
    cameraAngle: '手机屏幕切唐宁眼神，快速切换',
    composition: '先让手机信息占满画面，再切唐宁眼神，玻璃办公室作为虚化背景',
    characterName: '唐宁',
    characterKey: 'tang-ning',
    actionText: '手机显示发件人“赵启明”，资料旁标注死亡时间“三天前”；唐宁抬眼确认信息。',
    dialogueText: '赵衡（画外音）：签了，责任归你，公司不追究赔偿。',
    visualPrompt:
      '唐宁严格使用唯一参考图的脸型、黑色低马尾、浅蓝衬衫和米色西装；手机界面只显示中文发件人“赵启明”和“死亡时间：三天前”，赵衡只作为画外音，不在画面中出现。',
    shotPurpose: 'reversal',
    actingBeat: '唐宁先读屏幕，再抬眼；赵衡的催签声平稳进入，令她从困惑进入被逼迫状态。',
    audioDirection: '赵衡声音低沉、礼貌但带压力；办公室空调底噪和悬疑音乐持续，不加入其他人物声音。',
    startVisualPrompt: '手机仍停在“别签字”信息，唐宁的手握住手机边缘。',
    endVisualPrompt: '唐宁抬眼，表情从疑惑转为警觉，赵衡画外音落完。',
    primarySubject: '唐宁的确认反应',
    visibleEntities: ['手机', '唐宁'],
    referencedEntities: ['唐宁', '赵启明', '赵衡'],
    forbiddenEntities: ['赵衡出镜', '赵启明正脸', '英文声音'],
    reactionShot: true,
  }),
  shot({
    key: 's1-03',
    sceneNo: 1,
    shotNo: '03',
    durationSeconds: 8,
    shotType: '中近景 / 过肩镜头',
    cameraAngle: '从唐宁肩后缓慢推向手机',
    composition: '唐宁肩部在前景，手机和电脑桌面在中心，背景保持办公室纵深',
    characterName: '唐宁',
    characterKey: 'tang-ning',
    actionText: '手机自动播放赵启明语音；唐宁听到内容，脸色变化并锁定办公桌方向。',
    dialogueText: '赵启明（语音）：唐宁，别签。打开你办公桌第三层抽屉，底板下面有个黑色U盘。你只有七分钟。',
    visualPrompt:
      '赵启明只以手机播放语音存在，绝不出现实体人物；唐宁保持同一套浅蓝衬衫和米色西装，手机屏幕出现中文倒计时“07:00”，但不要生成其他数字或英文。',
    shotPurpose: 'mission',
    actingBeat: '赵启明说“别签”时唐宁仍克制；听到“黑色U盘”时眼神转向抽屉；“七分钟”落下后呼吸明显收紧。',
    audioDirection: '赵启明使用固定低沉遗言声，带轻微电流和旧录音压缩；倒计时提示音一次；七分钟必须清晰，禁止英文。',
    startVisualPrompt: '手机在唐宁手中自动播放，唐宁仍面对桌面。',
    endVisualPrompt: '语音停在七分钟，唐宁视线明确落向办公桌第三层抽屉。',
    primarySubject: '唐宁听取手机语音',
    visibleEntities: ['唐宁', '手机', '办公桌', '第三层抽屉'],
    referencedEntities: ['赵启明'],
    forbiddenEntities: ['赵启明实体出镜', '英文语音', '自动新增倒计时台词'],
  }),
  shot({
    key: 's1-04',
    sceneNo: 1,
    shotNo: '04',
    durationSeconds: 8,
    shotType: '中景 + 抽屉特写',
    cameraAngle: '跟拍唐宁起身，切第三层抽屉',
    composition: '唐宁从桌边移动到办公桌前，玻璃门边的赵衡位于背景右侧',
    characterName: '唐宁',
    characterKey: 'tang-ning',
    actionText: '唐宁快步走到办公桌前，拉开第三层抽屉，手指摸到底板；赵衡站在玻璃门边观察。',
    dialogueText: '赵衡：你在找什么？\n唐宁：找一个能让我签字的理由。',
    visualPrompt:
      '唐宁与赵衡同框，二人必须分别保持各自参考图；赵衡站在玻璃门边不靠近、不新增动作，唐宁只完成“走到桌边并拉开第三层抽屉”这一主动作。',
    shotPurpose: 'confrontation',
    actingBeat: '唐宁动作快但不慌；赵衡只问一句，像早知道她会去找；唐宁不回头，用冷静反击压住恐惧。',
    audioDirection: '脚步、抽屉滑轨和办公室空调声清楚；赵衡平稳发问，唐宁回答更冷，音乐节奏略加快。',
    startVisualPrompt: '唐宁从手机方向抬眼，办公桌第三层抽屉仍关闭，赵衡在玻璃门边。',
    endVisualPrompt: '抽屉拉开，唐宁手指触到底板；赵衡仍停在门边，双方空间关系不变。',
    primarySubject: '唐宁打开第三层抽屉',
    visibleEntities: ['唐宁', '赵衡', '办公桌', '第三层抽屉', '玻璃门'],
    referencedEntities: ['唐宁', '赵衡'],
    forbiddenEntities: ['额外同事', '黑色U盘提前露出', '赵衡突然靠近'],
  }),
  shot({
    key: 's2-01',
    sceneNo: 1,
    shotNo: '05',
    durationSeconds: 9,
    shotType: '手部特写 + 电脑中近景',
    cameraAngle: '手持轻微跟随，随后快速推近U盘',
    composition: '唐宁的手、底板、黑色U盘和电脑形成连续动作轴线',
    characterName: '唐宁',
    characterKey: 'tang-ning',
    actionText: '唐宁掀开抽屉底板，取出黑色U盘并插入电脑；电脑自动播放视频，只出现赵启明的肩膀和手。',
    dialogueText: '赵启明（视频）：如果唐宁已经看到这段视频，说明我死得比计划早。',
    visualPrompt:
      '黑色U盘直到唐宁掀开底板后才第一次完整出现；电脑视频画面严格只出现赵启明的肩膀、深色西装袖口、手和银色腕表，不出现脸、眼睛、嘴、完整头部或任何正面人物肖像。',
    shotPurpose: 'evidence',
    actingBeat: '唐宁取出U盘时短暂停顿确认，再插入电脑；视频亮起时她没有后退，只盯住屏幕。',
    audioDirection: '底板轻响、U盘插入声、电脑启动声；赵启明视频声低沉且像遗言，带轻微电流；音乐第一次压低给对白让位。',
    startVisualPrompt: '底板仍覆盖第三层抽屉，黑色U盘尚未出现。',
    endVisualPrompt: '视频亮起，画面只有赵启明肩膀和手，唐宁在屏幕边缘保持警觉。',
    primarySubject: '黑色U盘插入电脑',
    visibleEntities: ['唐宁', '黑色U盘', '电脑', '赵启明的肩膀和手'],
    referencedEntities: ['唐宁', '赵启明'],
    forbiddenEntities: ['赵启明正脸', '完整头部', '提前出现U盘', '英文视频界面'],
  }),
  shot({
    key: 's2-02',
    sceneNo: 2,
    shotNo: '06',
    durationSeconds: 10,
    shotType: '电脑屏幕特写 + 唐宁近景',
    cameraAngle: '电脑画面缓慢推近，切唐宁反应',
    composition: '电脑屏幕占画面主要区域，唐宁的眼神和手部反应作为切换落点',
    characterName: '唐宁',
    characterKey: 'tang-ning',
    actionText: '电脑视频出现雪花和卡顿；赵启明继续说，唐宁迅速调高音量并盯住屏幕。',
    dialogueText: '赵启明（视频）：她父亲五年前的事故，不是意外……',
    visualPrompt:
      '电脑视频仍只展示赵启明的肩膀和手，不得出现正脸；屏幕雪花和卡顿只作为短暂故障，中文关键词“不是意外”可以作为后期字幕，不在模型画面里生成英文或随机文字。',
    shotPurpose: 'truth-reveal',
    actingBeat: '唐宁先因卡顿皱眉，听到“父亲”时调高音量，听到“不是意外”后完全停住。',
    audioDirection: '电流杂音短暂增强，赵启明在“父亲”和“不是意外”前留停顿；音乐压低后留下低频持续音。',
    startVisualPrompt: '电脑视频有轻微雪花，赵启明肩膀和手仍在画面内。',
    endVisualPrompt: '唐宁手停在音量键上，眼神被“不是意外”钉住，画面不再添加信息。',
    primarySubject: '唐宁听见父亲事故真相',
    visibleEntities: ['电脑屏幕', '唐宁', '赵启明的肩膀和手'],
    referencedEntities: ['唐宁', '赵启明'],
    forbiddenEntities: ['赵启明正脸', '父亲事故画面', '额外解释对白', '英文声音'],
    reactionShot: true,
  }),
  shot({
    key: 's2-03',
    sceneNo: 2,
    shotNo: '07',
    durationSeconds: 9,
    shotType: '双人中近景 / 近景',
    cameraAngle: '赵衡从后方进入，快速推近；切唐宁护住U盘',
    composition: '赵衡从唐宁后方压入前景，唐宁和电脑形成被截断的动作关系',
    characterName: '唐宁',
    characterKey: 'tang-ning',
    actionText: '赵衡从后方突然进入画面并按住电脑屏幕；唐宁转身护住U盘。',
    dialogueText: '赵衡：够了。\n唐宁：你怕我听见什么？',
    visualPrompt:
      '唐宁与赵衡同框且严格使用各自参考图；赵衡只完成“伸手按住电脑屏幕”这一动作，唐宁只完成“转身护住黑色U盘”，不增加打斗、不增加第三个人。',
    shotPurpose: 'pressure',
    actingBeat: '赵衡的“够了”很轻却像命令；唐宁先护住U盘，再抬眼反问，情绪从震惊转为主动对抗。',
    audioDirection: '电脑关闭声与音乐重击同时发生；赵衡声音近而冷，唐宁声音明显更硬；对白不能被音乐盖住。',
    startVisualPrompt: '唐宁仍面对电脑，赵衡从玻璃门方向逼近但尚未触碰屏幕。',
    endVisualPrompt: '赵衡手按住屏幕，唐宁把黑色U盘护在身侧，双方形成近距离对峙。',
    primarySubject: '赵衡截断电脑视频',
    visibleEntities: ['唐宁', '赵衡', '电脑', '黑色U盘'],
    referencedEntities: ['唐宁', '赵衡'],
    forbiddenEntities: ['第三个人', '肢体冲突', '赵启明正脸', '随机台词'],
  }),
  shot({
    key: 's2-04',
    sceneNo: 2,
    shotNo: '08',
    durationSeconds: 5,
    shotType: '电脑黑屏特写 / 人物近景',
    cameraAngle: '缓慢推向黑屏，随后切唐宁眼睛',
    composition: '黑屏先占满画面，再用唐宁眼睛接住被截断的信息',
    characterName: '唐宁',
    characterKey: 'tang-ning',
    actionText: '电脑黑屏，U盘自动播放最后一段语音；画面只剩声音，语音在“他会——”处突然中断。',
    dialogueText: '赵启明（语音）：不要信赵衡。他会——',
    visualPrompt:
      '先展示无文字的电脑黑屏，再切唐宁眼睛；赵启明只通过语音存在，不出现任何实体、脸、手或视频画面；后期字幕“语音文件损坏”由剪辑添加，模型画面不得生成文字。',
    shotPurpose: 'interruption',
    actingBeat: '赵启明的声音在“他会——”处被硬切；唐宁的眼神先追声音，再意识到文件损坏。',
    audioDirection: '语音突然中断，音乐瞬间抽空半拍后恢复低频；必须保留电脑电流余音，不加入任何补全台词。',
    startVisualPrompt: '电脑屏幕刚被按黑，办公室仍有赵衡和唐宁的近距离关系。',
    endVisualPrompt: '屏幕保持黑色，唐宁眼睛停住，语音文件损坏的空白成为悬念。',
    primarySubject: '被中断的语音',
    visibleEntities: ['电脑黑屏', '唐宁'],
    referencedEntities: ['赵启明', '赵衡'],
    forbiddenEntities: ['赵启明实体出现', '补全“他会”之后的台词', '英文错误提示'],
    reactionShot: true,
  }),
  shot({
    key: 's2-05',
    sceneNo: 2,
    shotNo: '09',
    durationSeconds: 3,
    shotType: '中景转电脑特写',
    cameraAngle: '赵衡反锁玻璃门，镜头快速摇向电脑',
    composition: '先看门锁闭合，再摇向电脑邮件详情，赵衡声音压在画面末端',
    characterName: '赵衡',
    characterKey: 'zhao-heng',
    actionText: '赵衡反锁办公室玻璃门；电脑重新亮起，邮件详情显示发件设备为唐宁电脑。',
    dialogueText: '赵衡（低声）：赵总死了三天。可这封邮件，是从你的电脑发出去的。',
    visualPrompt:
      '赵衡只完成反锁玻璃门，随后电脑屏幕显示中文邮件详情“发件设备：唐宁电脑”；唐宁在背景保持不动，赵衡不靠近她，不出现其他人物和英文界面。',
    shotPurpose: 'cliffhanger',
    actingBeat: '门锁声先落下，赵衡在画外或画面边缘低声说出反转；唐宁听到“你的电脑”后僵住。',
    audioDirection: '门锁咔哒声、低沉重击音；赵衡压低声音清楚说完整句，音乐戛然而止，结尾保留半秒余响。',
    startVisualPrompt: '赵衡站在玻璃门前，手刚抬向门锁；电脑仍是黑屏。',
    endVisualPrompt: '玻璃门锁死，电脑亮起显示“发件设备：唐宁电脑”，唐宁与赵衡都被悬念钉住。',
    primarySubject: '邮件发件设备反转',
    visibleEntities: ['赵衡', '唐宁', '玻璃门', '电脑'],
    referencedEntities: ['赵衡', '唐宁'],
    forbiddenEntities: ['新增人物', '英文界面', '随机邮件内容', '赵启明正脸'],
  }),
]

export const DEAD_BOSS_AUDIO_SEGMENTS = [
  { shotKey: 's1-02', speakerKey: 'zhao-heng', text: '签了，责任归你，公司不追究赔偿。', trackType: 'dialogue' },
  {
    shotKey: 's1-03',
    speakerKey: 'zhao-qiming',
    text: '唐宁，别签。打开你办公桌第三层抽屉，底板下面有个黑色U盘。你只有七分钟。',
    trackType: 'dialogue',
  },
  { shotKey: 's1-04', speakerKey: 'zhao-heng', text: '你在找什么？', trackType: 'dialogue' },
  { shotKey: 's1-04', speakerKey: 'tang-ning', text: '找一个能让我签字的理由。', trackType: 'dialogue' },
  {
    shotKey: 's2-01',
    speakerKey: 'zhao-qiming',
    text: '如果唐宁已经看到这段视频，说明我死得比计划早。',
    trackType: 'dialogue',
  },
  {
    shotKey: 's2-02',
    speakerKey: 'zhao-qiming',
    text: '她父亲五年前的事故，不是意外。',
    trackType: 'dialogue',
  },
  { shotKey: 's2-03', speakerKey: 'zhao-heng', text: '够了。', trackType: 'dialogue' },
  { shotKey: 's2-03', speakerKey: 'tang-ning', text: '你怕我听见什么？', trackType: 'dialogue' },
  {
    shotKey: 's2-04',
    speakerKey: 'zhao-qiming',
    text: '不要信赵衡。他会——',
    trackType: 'dialogue',
  },
  {
    shotKey: 's2-05',
    speakerKey: 'zhao-heng',
    text: '赵总死了三天。可这封邮件，是从你的电脑发出去的。',
    trackType: 'dialogue',
  },
]

export function validateDeadBossEpisodePlan({
  characters = DEAD_BOSS_CHARACTERS,
  scenes = DEAD_BOSS_SCENES,
  shots = DEAD_BOSS_SHOTS,
  audioSegments = DEAD_BOSS_AUDIO_SEGMENTS,
} = {}) {
  const errors = []
  const characterKeys = new Set(characters.map((character) => character.key))
  const shotKeys = new Set()
  const shotNumbers = new Set()

  if (scenes.length !== 2) errors.push(`第一集应包含 2 个场景，当前为 ${scenes.length} 个`)
  if (shots.length !== 9) errors.push(`第一集主分镜应包含 9 个镜头，当前为 ${shots.length} 个`)
  if (!scenes.every((scene) => scene.sceneNo === 1 || scene.sceneNo === 2)) {
    errors.push('场景编号必须是 1 和 2')
  }

  for (const item of characters) {
    if (!item.key || !item.name || !item.referenceImageUrl) {
      // setup 脚本会在写入数据库前补齐 referenceImageUrl，这里只校验结构字段。
    }
    if (!item.voiceProfileKey || !item.voiceSetting) {
      errors.push(`角色 ${item.name || item.key} 缺少固定声线配置`)
    }
  }

  for (const item of shots) {
    if (!item.key || shotKeys.has(item.key)) errors.push(`镜头 key 重复：${item.key}`)
    shotKeys.add(item.key)
    if (shotNumbers.has(item.shotNo)) errors.push(`镜号重复：${item.shotNo}`)
    shotNumbers.add(item.shotNo)
    if (!characterKeys.has(item.characterKey)) errors.push(`镜头 ${item.shotNo} 的角色绑定无效`)
    if (!item.actionText || !item.visualPrompt || !item.startVisualPrompt || !item.endVisualPrompt) {
      errors.push(`镜头 ${item.shotNo} 缺少动作或连续性提示词`)
    }
    if (!item.continuityOverrides?.primaryAction) {
      errors.push(`镜头 ${item.shotNo} 缺少唯一主动作`)
    }
  }

  for (const segment of audioSegments) {
    if (!shotKeys.has(segment.shotKey)) errors.push(`声音段落引用不存在的镜头：${segment.shotKey}`)
    if (!characterKeys.has(segment.speakerKey)) errors.push(`声音段落角色无效：${segment.speakerKey}`)
    const normalizedText = segment.text.replaceAll('U盘', '盘')
    if (!segment.text || /[A-Za-z]/.test(normalizedText)) {
      errors.push(`声音段落必须为中文：${segment.shotKey}`)
    }
  }

  if (!audioSegments.some((segment) => segment.speakerKey === 'zhao-qiming')) {
    errors.push('缺少赵启明固定声线')
  }
  if (!shots.some((item) => item.shotKey === 's2-05' || item.key === 's2-05')) {
    errors.push('缺少结尾反转镜头')
  }

  return { valid: errors.length === 0, errors }
}

const validation = validateDeadBossEpisodePlan()
if (!validation.valid) {
  throw new Error(`《死去的老板给我发邮件》第1集蓝图无效：${validation.errors.join('；')}`)
}
