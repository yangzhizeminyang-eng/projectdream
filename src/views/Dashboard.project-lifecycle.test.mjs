import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./Dashboard.vue', import.meta.url), 'utf8')

test('dashboard keeps project lifecycle controls separate from opening a project', () => {
  assert.match(source, /archiveProject, deleteProject, listProjects, restoreProject/)
  assert.match(source, /@click\.stop="toggleProjectActions\(p\.id\)"/)
  assert.match(source, /@click\.stop="onArchiveProject\(p\)"/)
  assert.match(source, /@click\.stop="onRestoreProject\(p\)"/)
  assert.match(source, /@click\.stop="openDeleteDialog\(p\)"/)
})

test('dashboard requires the full project name before enabling permanent deletion', () => {
  assert.match(source, /v-model="deleteConfirmName"/)
  assert.match(source, /const canDeleteProject = computed\(/)
  assert.match(source, /deleteConfirmName\.value\.trim\(\) === projectDisplayName\(deleteTarget\.value\)/)
  assert.match(source, /请输入页面显示的完整项目名称/)
  assert.match(source, /:placeholder="`请输入：\$\{projectDisplayName\(deleteTarget\)\}`"/)
  assert.match(source, /@input="deleteDialogError = ''"/)
  assert.match(source, /:disabled="deletingProject \|\| !canDeleteProject"/)
})

test('dashboard explains the fallback name used for unnamed projects', () => {
  assert.match(source, /未命名项目 \$\{projectCode\(project\.id\)\}/)
  assert.match(source, /deleteDialogError/)
})

test('dashboard keeps the project stream fully visible above the viewport bottom', () => {
  assert.match(source, /class="dashboard-content[^"]*dashboard-content--scroll-safe/)
  assert.match(source, /\.dashboard-content--scroll-safe \{[\s\S]*?padding-bottom: max\(8rem, env\(safe-area-inset-bottom\)\);/)
  assert.match(source, /\.project-list \{[\s\S]*?padding-bottom: 2rem;/)
})

test('dashboard feedback stays visible while scrolling and dismisses automatically', () => {
  assert.match(source, /watch\(\[lifecycleMessage, lifecycleError\], scheduleLifecycleFeedbackDismissal\)/)
  assert.match(source, /window\.setTimeout\(\(\) =>/)
  assert.match(source, /}, 4000\)/)
  assert.match(source, /onUnmounted\(clearLifecycleFeedbackTimer\)/)
  assert.match(source, /\.lifecycle-feedback \{[\s\S]*?position: fixed;/)
  assert.match(source, /top: calc\(64px \+ 1rem\)/)
  assert.match(source, /background: #24231f;/)
  assert.match(source, /aria-live="polite"/)
})

test('continue production panel keeps project copy and actions in separate non-overlapping regions', () => {
  assert.match(source, /class="continue-panel-copy"/)
  assert.match(source, /class="continue-panel-actions"/)
  assert.match(source, /\.continue-panel \{[\s\S]*?overflow: hidden;/)
  assert.match(source, /\.continue-panel h2 \{[\s\S]*?overflow-wrap: anywhere;/)
  assert.match(source, /play_circle/)
})

test('project console keeps live production context beside the project stream on wide screens', () => {
  assert.match(source, /class="studio-sidebar lg:col-span-4"/)
  assert.match(source, /class="studio-card studio-card--summary/)
  assert.match(source, /class="studio-card studio-card--activity/)
  assert.match(source, /class="studio-card studio-card--actions/)
  assert.doesNotMatch(source, /\.dashboard-grid\s*\{[^}]*display:\s*block\s*!important/s)
  assert.doesNotMatch(source, /\.studio-sidebar\s*\{\s*display:\s*none\s*;/)
})

test('project cards expose progress, descriptions, and latest video rather than hiding production evidence', () => {
  assert.match(source, /class="project-progress-ring relative h-20 w-20 shrink-0"/)
  assert.match(source, /class="project-latest-video mt-4/)
  assert.match(source, /class="project-card-progress flex items-center gap-3"/)
  assert.doesNotMatch(source, /\.project-progress-ring,[\s\S]*?\.project-latest-video,[\s\S]*?display:\s*none;/)
})

test('continue project is not repeated in the regular project stream', () => {
  assert.match(source, /const featuredProject = computed[\s\S]*?activeFilter\.value === 'all' \|\| activeFilter\.value === 'active'/)
  assert.match(source, /const listedProjects = computed[\s\S]*?project\.id !== featuredProject\.value\?\.id/)
  assert.match(source, /v-for="p in activeListedProjects"/)
  assert.match(source, /:title="projectDisplayName\(p\)"/)
  assert.match(source, /function projectTitle\(project: ProjectDTO \| null\)/)
  assert.match(source, /projectDisplayName\(project\)\.replace\(\/\[・·\]\\s\*\\d\{10,\}\$\//)
})

test('same-title projects beside the featured project are grouped there without deleting their routes', () => {
  assert.match(source, /function projectTitleKey\(project: ProjectDTO\): string/)
  assert.match(source, /const featuredTitleProjects = computed[\s\S]*?projectTitleKey\(project\) === projectTitleKey\(featuredProject\.value!\)/)
  assert.match(source, /const listedProjects = computed[\s\S]*?projectTitleKey\(project\) !== projectTitleKey\(featuredProject\.value\)/)
  assert.match(source, /class="featured-title-group"/)
  assert.match(source, /v-for="project in featuredTitleProjects"/)
  assert.match(source, /@click="openStudio\(project\)"/)
})

test('dashboard deduplicates repeated API rows by project id', () => {
  assert.match(source, /new Map\(list\.map\(\(project\) => \[project\.id, project\]\)\)/)
})

test('featured title duplicates stay independently accessible and do not repeat in recent activity', () => {
  assert.match(source, /const featuredTitleProjects = computed[\s\S]*?projectTitleKey\(project\) === projectTitleKey\(featuredProject\.value!\)/)
  assert.match(source, /const recentProjects = computed[\s\S]*?projectTitleKey\(project\) !== projectTitleKey\(featuredProject\.value\)/)
  assert.match(source, /v-for="project in featuredTitleProjects"/)
  assert.match(source, /@click="openStudio\(project\)"/)
})

test('only confirmed zero-output drafts are folded into the collapsed not-started group', () => {
  assert.match(source, /function isPristineProject\(project: ProjectDTO\): boolean/)
  assert.match(source, /project\.status === 'draft'[\s\S]*?typeof project\.progressPercent === 'number'[\s\S]*?project\.progressPercent === 0[\s\S]*?Object\.values\(details\)\.every\(\(value\) => typeof value === 'number' && value === 0\)/)
  assert.match(source, /const emptyProjects = computed[\s\S]*?isPristineProject\(project\)/)
  assert.match(source, /<details[^>]*class="empty-projects-group"/)
  assert.match(source, /class="empty-projects-title">尚未开始/)
  assert.match(source, /v-for="p in emptyProjects"/)
  assert.match(source, /@click\.stop="openStudio\(p\)"/)
  assert.match(source, /@click\.stop="onArchiveProject\(p\)"/)
  assert.match(source, /@click\.stop="openDeleteDialog\(p\)"/)
})

test('archived projects remain in their archive view instead of the not-started group', () => {
  assert.match(source, /function isPristineProject\(project: ProjectDTO\): boolean[\s\S]*?!showArchived\.value/)
  assert.match(source, /const emptyProjects = computed[\s\S]*?isPristineProject\(project\)/)
})

test('project cards use a real 9:16 visual cover when available and keep a designed fallback', () => {
  assert.match(source, /class="project-cover"/)
  assert.match(source, /projectCoverCandidates\(project: ProjectDTO\)[\s\S]*project\.coverUrl, project\.latestVideo\?\.coverUrl/)
  assert.match(source, /project-cover--empty/)
  assert.match(source, /\.project-cover\s*\{[\s\S]*?width:\s*4\.6rem;[\s\S]*?height:\s*7\.5rem;/)
  assert.match(source, /\.empty-project-cover\s*\{[\s\S]*?background:\s*var\(--project-cover-fallback\)/)
  assert.match(source, /--project-cover-fallback:\s*linear-gradient\(155deg, #292923, #111412 68%\)/)
})

test('featured project is omitted from recent activity while latest-project shortcuts stay current', () => {
  assert.match(source, /const latestProjects = computed[\s\S]*?\.sort\(\(a, b\) => \+new Date\(b\.updatedAt\) - \+new Date\(a\.updatedAt\)\)/)
  assert.match(source, /const recentProjects = computed[\s\S]*?project\.id !== featuredProject\.value\?\.id[\s\S]*?projectTitleKey\(project\) !== projectTitleKey\(featuredProject\.value\)[\s\S]*?\.slice\(0, 3\)/)
  assert.match(source, /featuredProject \? '当前重点项目已置顶' : '暂无活动'/)
  assert.match(source, /latestProjects\[0\]/)
})

test('project cover errors fall back to another real cover before showing a placeholder', () => {
  assert.match(source, /function projectCoverUrl\(project: ProjectDTO\)/)
  assert.match(source, /function advanceProjectCover\(project: ProjectDTO\)/)
  assert.match(source, /@error="advanceProjectCover\(p\)"/)
  assert.match(source, /@error="advanceProjectCover\(featuredProject\)"/)
})

test('studio note metrics are prominent and project cards have a breathable rhythm', () => {
  assert.match(source, /class="stat-value/)
  assert.match(source, /\.stat-value\s*\{[^}]*font-size:\s*2rem/s)
  assert.match(source, /\.project-list\s*\{[^}]*gap:\s*1\.75rem/s)
})
