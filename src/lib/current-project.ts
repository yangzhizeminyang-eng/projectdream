import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { getProject, type ProjectDTO } from '@/api/project'
import { getWorkspaceContext } from '@/lib/context'

function resolveProjectStatusLabel(status?: string | null): string {
  if (status === 'outlined') return '总纲已生成'
  if (status === 'scripting') return '剧本生成中'
  if (status === 'storyboarding') return '分镜制作中'
  if (status === 'draft') return '筹备中'
  if (status && status.trim()) return status
  return '项目进行中'
}

export function useCurrentProjectMeta() {
  const route = useRoute()

  const project = ref<ProjectDTO | null>(null)
  const projectLoading = ref(false)

  const currentProjectId = computed(() => {
    const fromQuery = Number(route.query.projectId) || 0
    if (fromQuery > 0) return fromQuery
    return getWorkspaceContext()?.projectId || 0
  })

  const projectName = computed(() => {
    if (projectLoading.value && currentProjectId.value > 0) return '加载项目中...'
    if (project.value?.name?.trim()) return project.value.name.trim()
    if (currentProjectId.value > 0) return `项目 #${currentProjectId.value}`
    return '未选择项目'
  })

  const projectStatusLabel = computed(() => {
    if (projectLoading.value && currentProjectId.value > 0) return '读取项目中'
    if (!currentProjectId.value) return '等待进入项目'
    return resolveProjectStatusLabel(project.value?.status)
  })

  async function loadCurrentProject(): Promise<void> {
    const projectId = currentProjectId.value
    if (!projectId) {
      project.value = null
      return
    }

    projectLoading.value = true
    try {
      const nextProject = await getProject(projectId)
      if (currentProjectId.value !== projectId) return
      project.value = nextProject
    } catch {
      if (currentProjectId.value !== projectId) return
      project.value = null
    } finally {
      if (currentProjectId.value === projectId) {
        projectLoading.value = false
      }
    }
  }

  watch(
    () => route.fullPath,
    () => {
      void loadCurrentProject()
    },
    { immediate: true },
  )

  return {
    currentProjectId,
    project,
    projectLoading,
    projectName,
    projectStatusLabel,
  }
}
