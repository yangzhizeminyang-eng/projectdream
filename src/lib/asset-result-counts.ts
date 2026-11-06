import {
  selectSceneNineGridImages,
  type AssetImageGroup,
  type AssetImageLike,
} from './asset-image-groups.ts'

function hasImageUrl(image: AssetImageLike): boolean {
  return Boolean(image.imageUrl || image.thumbnailUrl)
}

function isDisplayable(image: AssetImageLike): boolean {
  const status = String(image.status || '').toLowerCase()
  const visionStatus = String(image.visionStatus || '').toLowerCase()
  return status !== 'failed'
    && status !== 'superseded'
    && visionStatus !== 'failed'
    && hasImageUrl(image)
}

/** 统一统计画布当前真正可展示的图片，不把失败或历史替代记录算进去。 */
export function countAssetImageGroupResults<T extends AssetImageLike>(
  group: Pick<AssetImageGroup<T>, 'key' | 'images'>,
): number {
  if (group.key === 'scene-nine-grid') {
    return selectSceneNineGridImages(group.images).filter(isDisplayable).length
  }
  return group.images.filter(isDisplayable).length
}

export function countAssetImageGroupsResults<T extends AssetImageLike>(
  groups: Array<Pick<AssetImageGroup<T>, 'key' | 'images'>>,
): number {
  return groups.reduce((total, group) => total + countAssetImageGroupResults(group), 0)
}
