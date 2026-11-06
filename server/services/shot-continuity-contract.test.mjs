import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSceneContinuityContracts,
  buildShotContinuityPrompt,
  selectShotContinuityContract,
  validateSceneContinuityContracts,
} from './shot-continuity-contract.mjs'

const sceneShots = [
  {
    id: 284,
    scene_id: 883,
    shot_no: '14',
    shot_type: '大特写',
    character_name: '林夏',
    action_text: '林夏听见“小夏”后瞳孔骤缩，手指在绝缘手套里慢慢收紧。',
    visual_prompt: '林夏大特写，背景只有红灯虚化，不出现完整设备。',
    start_visual_prompt: '林夏仍盯着画外广播机。',
    end_visual_prompt: '她的视线锁定画外广播机，手部向画面外靠近后停住。',
    sort_order: 8,
  },
  {
    id: 285,
    scene_id: 883,
    shot_no: '15',
    shot_type: '手部与红灯特写',
    character_name: '林夏',
    action_text: '林夏的手碰到广播机边缘又立刻收回，红灯持续亮着。',
    visual_prompt: '手部与广播机红灯特写，广播机主体进入画面。',
    start_visual_prompt: '林夏的手指靠近广播机边缘，红灯稳定。',
    end_visual_prompt: '手指收回，红灯仍亮。',
    sort_order: 9,
  },
]

test('requires the previous reaction shot to foreshadow a newly revealed broadcast machine', () => {
  const contracts = buildSceneContinuityContracts(sceneShots)
  const reaction = contracts[0]
  const reveal = contracts[1]

  assert.deepEqual(reveal.reveal.entities, ['广播机'])
  assert.equal(reveal.reveal.requiresForeshadow, true)
  assert.deepEqual(reaction.nextShotForeshadow.entities, ['广播机'])
  assert.match(reaction.nextShotForeshadow.prompt, /视线/)
  assert.match(reaction.nextShotForeshadow.prompt, /手/)
})

test('continuity prompt forbids unannounced objects and extra speech', () => {
  const contracts = buildSceneContinuityContracts(sceneShots)
  const prompt = buildShotContinuityPrompt(contracts[1])

  assert.match(prompt, /本镜头唯一主动作/)
  assert.match(prompt, /不得新增未声明道具/)
  assert.match(prompt, /不得新增人物/)
  assert.match(prompt, /不得添加未写入对白的声音/)
})

test('invalid continuity sequence is blocked when a reveal is not foreshadowed', () => {
  const contracts = buildSceneContinuityContracts(sceneShots)
  contracts[0].nextShotForeshadow = {
    entities: [],
    prompt: '',
  }

  const report = validateSceneContinuityContracts(contracts)

  assert.equal(report.valid, false)
  assert.match(report.errors.join('；'), /广播机/)
})

test('selects the continuity contract by the requested storyboard id', () => {
  const contracts = buildSceneContinuityContracts(sceneShots)

  assert.equal(selectShotContinuityContract(contracts, 284)?.shotNo, '14')
  assert.equal(selectShotContinuityContract(contracts, 999), null)
})
