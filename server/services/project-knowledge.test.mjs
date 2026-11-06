import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildProjectKnowledgeChunks,
  buildRagDocuments,
  formatRetrievedProjectContext,
  retrieveProjectContext,
} from './project-knowledge.mjs'

test('project memory chunks can be converted into project-isolated RAG documents', () => {
  const chunks = buildProjectKnowledgeChunks({
    scene: { episode_no: 3, title: '值班台', content: '红色发卡在窗口' },
  })
  const documents = buildRagDocuments({ projectId: 9, episodeNo: 3, chunks })
  assert.ok(documents.length > 0)
  assert.equal(documents[0].metadata.project_id, 9)
  assert.equal(documents[0].metadata.episode_id, 3)
  assert.equal(documents[0].metadata.source, 'node-project-knowledge')
})

test('retrieves current scene and character memory without inventing a vector dependency', () => {
  const chunks = buildProjectKnowledgeChunks({
    scene: { episode_no: 2, scene_no: 1, title: '后门走廊', content: '林知夏拿起红色发卡' },
    characters: [{ name: '林知夏', appearance: '黑发', voice_style: '克制' }],
  })
  const result = retrieveProjectContext(chunks, '林知夏 红色发卡')
  assert.equal(result[0].kind, 'scene')
  assert.match(formatRetrievedProjectContext(result), /林知夏/)
  assert.equal(retrieveProjectContext(chunks, '林知夏', 8, { episodeNo: 2 })[0].kind, 'scene')
  assert.deepEqual(retrieveProjectContext(chunks, '林知夏', 8, { episodeNo: 3 }), [])
})

test('does not return unrelated memory for a focused query', () => {
  const chunks = buildProjectKnowledgeChunks({
    scene: { title: '公寓客厅', content: '电脑亮起' },
    characters: [{ name: '唐宁', appearance: '浅蓝衬衫' }],
  })
  assert.deepEqual(retrieveProjectContext(chunks, '不存在的道具'), [])
})

test('RAG metadata uses stable asset identity and the real asset version', () => {
  const chunks = buildProjectKnowledgeChunks({
    scene: { id: 77, episode_no: 2, title: '值班台', content: '红色发卡在窗口' },
    assetCatalog: {
      props: [{
        name: '红色发卡',
        assetNodeId: 901,
        versionNo: 4,
        viewSetVersion: 2,
        assetPrompt: '暗红塑料一字夹',
        confirmedImages: [{ imageId: 3001 }],
      }],
    },
  })
  const documents = buildRagDocuments({ projectId: 9, episodeNo: 2, chunks })
  const prop = documents.find((item) => item.metadata.asset_type === 'prop-asset')
  assert.equal(prop.metadata.asset_id, '901')
  assert.equal(prop.metadata.asset_version, 4)
  assert.match(prop.text, /image:3001/)
})
