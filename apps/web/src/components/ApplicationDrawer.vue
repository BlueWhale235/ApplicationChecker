<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ApplicationDetail, ProgressStatus, RunSummary } from "@application-checker/contracts";
import { progressLabels, runLabels } from "@application-checker/contracts";

const props = defineProps<{ detail: ApplicationDetail | null; loading: boolean }>();
const emit = defineEmits<{
  close: [];
  run: [id: string];
  progress: [id: string, status: ProgressStatus];
  unlock: [id: string];
  resumeAutomation: [id: string];
  login: [run: RunSummary];
  refreshLogin: [id: string];
  viewScreenshot: [run: RunSummary];
  deleteScreenshot: [run: RunSummary];
  remove: [id: string];
  saveNotes: [id: string, notes: string, done: (ok: boolean) => void];
  editPlan: [];
  editApplication: [];
}>();
const status = ref<ProgressStatus>("unset");
watch(() => props.detail?.application.progressStatus, (value) => { if (value) status.value = value; }, { immediate: true });

const notes = ref("");
const notesState = ref<"idle" | "pending" | "saving" | "saved" | "error">("idle");
const runsExpanded = ref(false);
let notesTimer: number | undefined;
let notesVersion = 0;
let notesApplicationId: string | undefined;

watch(
  () => [props.detail?.application.id, props.detail?.application.notes] as const,
  ([id, value]) => {
    if (id !== notesApplicationId) {
      if (notesTimer) window.clearTimeout(notesTimer);
      notesApplicationId = id;
      notes.value = value ?? "";
      notesState.value = "idle";
      runsExpanded.value = false;
      notesVersion += 1;
      return;
    }
    if (notesState.value === "idle" || notesState.value === "saved") notes.value = value ?? "";
  },
  { immediate: true },
);

watch(notes, (value) => {
  const application = props.detail?.application;
  if (notesTimer) window.clearTimeout(notesTimer);
  const version = ++notesVersion;
  if (!application) return;
  if (value === (application.notes ?? "") && notesState.value !== "saving") {
    notesState.value = "idle";
    return;
  }
  notesState.value = "pending";
  notesTimer = window.setTimeout(() => {
    notesState.value = "saving";
    emit("saveNotes", application.id, value, (ok) => {
      if (version !== notesVersion) return;
      notesState.value = ok ? "saved" : "error";
    });
  }, 800);
});

onBeforeUnmount(() => {
  if (notesTimer) window.clearTimeout(notesTimer);
});

const stages: ProgressStatus[] = ["screening", "screening_passed", "interview_pending", "interviewed", "signing_pending", "offer"];
const displayedStages = computed<ProgressStatus[]>(() => (
  props.detail?.application.progressStatus === "rejected" ? ["unset", "rejected"] : stages
));
const progressItems = Object.entries(progressLabels).map(([value, title]) => ({ value, title }));
function stageLabel(stage: ProgressStatus): string {
  if (props.detail?.application.progressStatus === "rejected" && stage === "unset") return "投递";
  return stage === "rejected" ? "淘汰" : progressLabels[stage];
}
function stageReached(stage: ProgressStatus): boolean {
  const current = props.detail?.application.progressStatus;
  if (!current) return false;
  if (current === "rejected") return stage === "unset" || stage === "rejected";
  return stages.indexOf(stage) <= stages.indexOf(current);
}
function stageInProgress(stage: ProgressStatus): boolean {
  return stage === props.detail?.application.progressStatus && !["offer", "rejected"].includes(stage);
}
function date(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
</script>

<template>
  <aside v-if="detail || loading" class="detail-drawer">
    <div v-if="loading && !detail" class="drawer-loading"><span class="spinner"></span></div>
    <template v-else-if="detail">
      <div class="drawer-scroll">
        <header class="drawer-head">
        <div>
          <h2>{{ detail.application.company }} · {{ detail.application.jobTitle }}</h2>
          <div class="drawer-links">
            <button class="drawer-edit-link" type="button" @click="$emit('editApplication')">
              <i class="mdi mdi-pencil-outline"></i>编辑投递信息
            </button>
            <a v-if="detail.application.checkUrl" :href="detail.application.resolvedUrl || detail.application.checkUrl" target="_blank" rel="noreferrer">查询链接 <i class="mdi mdi-open-in-new"></i></a>
            <a v-if="detail.application.postingUrl" :href="detail.application.postingUrl" target="_blank" rel="noreferrer">岗位链接 <i class="mdi mdi-open-in-new"></i></a>
          </div>
        </div>
        <button class="icon-button" @click="$emit('close')"><i class="mdi mdi-close"></i></button>
        </header>
      <div class="drawer-status-row">
        <span class="status-chip" :data-status="detail.application.progressStatus">
          {{ detail.application.progressStatus === "rejected" ? "投递-淘汰" : progressLabels[detail.application.progressStatus] }}
        </span>
        <div class="login-state-control">
          <span v-if="detail.application.lastRunStatus === 'needs_login'" class="login-state warning"><i class="mdi mdi-lock-alert-outline"></i>需要登录</span>
          <span v-else class="login-state ok"><i class="mdi mdi-check-circle"></i>正常</span>
          <button v-if="detail.application.checkUrl" type="button" @click="$emit('refreshLogin', detail.application.id)">刷新登录状态</button>
        </div>
      </div>
      <dl class="run-meta">
        <div><dt>上次检查</dt><dd>{{ date(detail.application.lastRunAt) }}</dd></div>
        <div>
          <dt>下次检查 <button v-if="detail.application.checkUrl && !detail.application.automationPaused" class="edit-plan-link" type="button" @click="$emit('editPlan')">编辑检查计划</button></dt>
          <dd>{{ detail.application.scheduleMode === "manual" || detail.application.automationPaused || !detail.application.checkUrl ? "" : date(detail.application.nextRunAt) }}</dd>
          <small v-if="detail.checkGroup.memberCount > 1" class="shared-plan-note">与 {{ detail.checkGroup.memberCount }} 个岗位共享</small>
        </div>
      </dl>

      <section class="drawer-section">
        <h3>当前进度</h3>
        <div class="progress-track" :class="{ terminal: detail.application.progressStatus === 'rejected' }">
          <div
            v-for="stage in displayedStages"
            :key="stage"
            :class="{
              reached: stageReached(stage),
              active: stage === detail.application.progressStatus,
              'in-progress': stageInProgress(stage),
              rejected: stage === 'rejected',
            }"
          >
            <i></i><span>{{ stageLabel(stage) }}</span>
          </div>
        </div>
        <div class="manual-progress">
          <v-select v-model="status" :items="progressItems" variant="outlined" density="compact" hide-details />
          <v-btn class="compact-button" variant="outlined" color="primary" @click="$emit('progress', detail.application.id, status)">手动更新</v-btn>
        </div>
        <p v-if="detail.application.manualLocked" class="lock-note"><i class="mdi mdi-hand-back-right-outline"></i>人工状态已锁定，AI 只提供建议。<button @click="$emit('unlock', detail.application.id)">恢复自动识别</button></p>
        <p v-if="detail.application.automationPaused" class="automation-pause-note">
          <i class="mdi mdi-pause-circle-outline"></i>
          <span>
            <strong>淘汰后已暂停自动检查</strong>
            <small>{{ detail.application.progressStatus === "rejected" ? "仍可手动复查，AI 结果只作为建议。" : "状态已修改，但仍保持仅手动。" }}</small>
          </span>
          <button
            v-if="detail.application.progressStatus !== 'rejected'"
            type="button"
            @click="$emit('resumeAutomation', detail.application.id)"
          >
            恢复自动检查
          </button>
        </p>
      </section>

      <section class="drawer-section notes-section">
        <div class="section-title">
          <h3>备注</h3>
          <small class="notes-save-state" :data-state="notesState" aria-live="polite">
            <template v-if="notesState === 'pending'">等待保存</template>
            <template v-else-if="notesState === 'saving'">保存中…</template>
            <template v-else-if="notesState === 'saved'">已自动保存</template>
            <template v-else-if="notesState === 'error'">保存失败，请继续编辑后重试</template>
            <template v-else>输入自动保存</template>
          </small>
        </div>
        <v-textarea
          v-model="notes"
          aria-label="岗位备注"
          placeholder="记录联系人、面试准备、跟进时间或其他信息"
          rows="4"
          maxlength="4000"
          counter
          auto-grow
          max-rows="8"
          variant="outlined"
          density="compact"
          hide-details="auto"
        />
      </section>

      <section class="drawer-section">
        <div class="section-title"><h3>状态时间线</h3><small>{{ detail.statusEvents.length }} 条记录</small></div>
        <div v-if="detail.statusEvents.length" class="timeline">
          <div v-for="event in detail.statusEvents.slice(0, 3)" :key="event.id">
            <i></i><strong>{{ event.eventType === "applied" ? "投递" : progressLabels[event.toStatus] }}</strong><span>{{ date(event.createdAt) }}</span>
            <small>{{ event.eventType === "applied" ? "投递记录" : event.source === "manual" ? "手动设置" : `AI 识别${event.confidence ? ` · ${Math.round(event.confidence * 100)}%` : ""}` }}</small>
          </div>
        </div>
        <p v-else class="quiet-empty">还没有状态变化。</p>
      </section>

      <section class="drawer-section">
        <div class="section-title"><h3>截图记录</h3><small>最近 {{ detail.runs.filter(run => run.screenshotAvailable).length }} 张</small></div>
        <div class="screenshot-grid">
          <article v-for="run in detail.runs.filter(run => run.screenshotAvailable).slice(0, 6)" :key="run.id" class="screenshot-card">
            <img :src="`/api/runs/${run.id}/screenshot`" :alt="`${date(run.completedAt)} 截图`" />
            <div class="screenshot-overlay">
              <button aria-label="查看截图" title="查看截图" @click="$emit('viewScreenshot', run)"><i class="mdi mdi-eye-outline"></i></button>
              <button class="danger" aria-label="删除截图" title="删除截图" @click="$emit('deleteScreenshot', run)"><i class="mdi mdi-delete-outline"></i></button>
            </div>
            <span>{{ date(run.completedAt) }}</span>
          </article>
        </div>
        <p v-if="!detail.runs.some(run => run.screenshotAvailable)" class="quiet-empty">完成第一次检查后，截图会出现在这里。</p>
      </section>

      <section class="drawer-section">
        <div class="section-title"><h3>运行记录</h3><small>{{ detail.runs.length }} 次</small></div>
        <div class="run-list">
          <article v-for="run in detail.runs.slice(0, runsExpanded ? detail.runs.length : 3)" :key="run.id">
            <i class="run-dot" :data-run="run.status"></i>
            <div><strong>{{ runLabels[run.status] }}</strong><span>{{ date(run.createdAt) }}</span>
              <small v-if="run.aiSuggestedStatus">AI：{{ progressLabels[run.aiSuggestedStatus] }} · {{ Math.round((run.aiConfidence || 0) * 100) }}%</small>
              <small v-else-if="run.errorMessage">{{ run.errorMessage }}</small>
              <small v-if="run.groupMemberCount > 1">共享检查 · {{ run.groupMemberCount }} 个岗位</small>
            </div>
            <button v-if="run.status === 'needs_login'" class="login-button" @click="$emit('login', run)">登录</button>
          </article>
        </div>
        <v-btn
          v-if="detail.runs.length > 3"
          class="expand-runs-button"
          variant="text"
          size="small"
          :append-icon="runsExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down'"
          @click="runsExpanded = !runsExpanded"
        >
          {{ runsExpanded ? "收起" : `展开更多（${detail.runs.length - 3}）` }}
        </v-btn>
      </section>
      </div>

      <footer class="drawer-actions">
        <button class="danger-ghost" @click="$emit('remove', detail.application.id)">删除岗位</button>
        <button class="primary-button" :disabled="!detail.application.checkUrl || ['queued','running'].includes(detail.application.lastRunStatus || '')" @click="$emit('run', detail.application.id)">
          {{ detail.application.checkUrl ? "立即检查" : "仅手动更新" }}
        </button>
      </footer>
    </template>
  </aside>
</template>

<style scoped>
.detail-drawer { position: fixed; z-index: 8; right: 0; top: 51px; bottom: 0; width: 390px; display: flex; flex-direction: column; overflow: hidden; background: #fffdf9; border-left: 1px solid #ddd6c8; box-shadow: -15px 0 35px #183a370d; }
.drawer-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 25px 22px 20px; }
.drawer-head { position: sticky; z-index: 2; top: -25px; display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin: -25px 0 0; padding: 25px 0 16px; border-bottom: 1px solid #e9e2d7; background: #fffdf9f2; backdrop-filter: blur(10px); }
.drawer-head h2 { margin: 0 0 7px; font: 600 18px "Noto Serif SC", serif; color: #20312c; }
.drawer-head a, .drawer-edit-link { color: #73807a; font-size: 10px; text-decoration: none; }
.drawer-links { display: flex; align-items: center; gap: 12px; }
.drawer-links > * { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
.drawer-links > * + * { padding-left: 12px; border-left: 1px solid #ddd6ca; }
.drawer-edit-link { padding: 0; border: 0; background: transparent; cursor: pointer; }
.drawer-edit-link:hover, .drawer-edit-link:focus-visible, .drawer-head a:hover, .drawer-head a:focus-visible { color: #b95a2b; }
.drawer-edit-link:focus-visible, .drawer-head a:focus-visible { outline: 2px solid #d4a083; outline-offset: 3px; border-radius: 2px; }
.drawer-status-row { display: flex; align-items: center; justify-content: space-between; padding: 15px 0; }
.login-state-control { display: grid; justify-items: end; gap: 3px; }
.login-state-control button { padding: 0; border: 0; background: transparent; color: #87918c; font-size: 9px; text-decoration: underline; text-underline-offset: 2px; }
.login-state-control button:hover, .login-state-control button:focus-visible { color: #b95a2b; outline: none; }
.run-meta { display: grid; grid-template-columns: 1fr 1fr; margin: 0; padding: 0 0 17px; border-bottom: 1px solid #e9e2d7; }
.run-meta div + div { border-left: 1px solid #e9e2d7; padding-left: 20px; }
.run-meta dt { color: #8a928e; font-size: 10px; }
.run-meta dd { margin: 6px 0 0; color: #34423d; font-size: 12px; }
.edit-plan-link { margin-left: 5px; padding: 0; border: 0; background: transparent; color: #a65529; font-size: 10px; text-decoration: underline; }
.shared-plan-note { display: block; margin-top: 4px; color: #71817a; font-size: 9px; }
.drawer-section { padding: 19px 0; border-bottom: 1px solid #e9e2d7; }
.drawer-section h3 { margin: 0; color: #2d3c36; font: 600 15px "Noto Serif SC", serif; }
.section-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 13px; }
.section-title small { color: #909893; font-size: 10px; }
.progress-track { display: grid; grid-template-columns: repeat(6, 1fr); margin: 20px 0 18px; position: relative; }
.progress-track:before { content: ""; position: absolute; left: 9%; right: 9%; top: 7px; height: 2px; background: #e0e2df; }
.progress-track div { z-index: 1; text-align: center; color: #939b97; font-size: 9px; }
.progress-track i { position: relative; display: block; width: 15px; height: 15px; margin: 0 auto 8px; border-radius: 50%; border: 2px solid #d6dbd8; background: #fffdf9; }
.progress-track div.reached i { border-color: #5589c2; background: #dcecff; box-shadow: 0 0 0 3px #eaf4ff; }
.progress-track div.active { color: #3975b9; font-weight: 600; }
.progress-track div.in-progress i:after { content: ""; position: absolute; inset: -7px; border: 2px solid #75a9df; border-radius: 50%; animation: progress-node-pulse 1.8s ease-out infinite; }
.progress-track.terminal { grid-template-columns: repeat(2, 1fr); }
.progress-track.terminal:before { left: 25%; right: 25%; background: #cfd4d1; }
.progress-track.terminal div { color: #747d79; }
.progress-track.terminal div.reached i { border-color: #aab1ad; background: #e9ecea; box-shadow: 0 0 0 3px #f2f3f1; }
.progress-track.terminal div.active { color: #747d79; }
.progress-track div.rejected { color: #747d79; font-weight: 600; }
.progress-track div.rejected i { border-color: #aab1ad; background: #e9ecea; box-shadow: 0 0 0 3px #f2f3f1; }
@keyframes progress-node-pulse {
  0% { opacity: .85; transform: scale(.72); }
  70%, 100% { opacity: 0; transform: scale(1.28); }
}
@media (prefers-reduced-motion: reduce) {
  .progress-track div.in-progress i:after { animation: none; opacity: .35; }
}
.manual-progress { display: flex; gap: 8px; }
.manual-progress .v-select { min-width: 0; flex: 1; }
.compact-button { min-height: 36px; font-size: 11px; }
.notes-section .section-title { align-items: baseline; }
.notes-section .v-field { background: #fffdf8; }
.notes-section textarea { line-height: 1.55; font-size: 12px; }
.notes-save-state[data-state="saving"], .notes-save-state[data-state="pending"] { color: #8b6a28; }
.notes-save-state[data-state="saved"] { color: #337a5c; }
.notes-save-state[data-state="error"] { color: #b7463c; }
.expand-runs-button { margin-top: 8px; width: 100%; }
.lock-note { margin: 11px 0 0; padding: 9px 10px; background: #fbf5e8; color: #7c684a; font-size: 10px; border-radius: 7px; }
.lock-note button { margin-left: 4px; padding: 0; border: 0; color: #a65529; background: transparent; font-size: 10px; text-decoration: underline; }
.timeline { padding-left: 6px; }
.timeline > div { position: relative; display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 0 0 14px 20px; border-left: 1px solid #ddd9d0; }
.timeline > div:last-child { border-left-color: transparent; padding-bottom: 0; }
.timeline > div > i { position: absolute; left: -5px; top: 4px; width: 9px; height: 9px; border-radius: 50%; background: #d69b14; box-shadow: 0 0 0 3px #fff6df; }
.timeline strong { font-size: 11px; }
.timeline span, .timeline small { color: #8a928e; font-size: 9px; }
.timeline small { grid-column: 1 / -1; }
.screenshot-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.screenshot-card { position: relative; color: #7a827e; font-size: 8px; }
.screenshot-grid img { width: 100%; height: 70px; object-fit: cover; object-position: top; border: 1px solid #d6d1c7; border-radius: 5px; background: #f4f1ea; }
.screenshot-grid span { display: block; margin-top: 4px; text-align: center; }
.screenshot-overlay { position: absolute; inset: 0 0 14px; display: flex; align-items: center; justify-content: center; gap: 7px; border-radius: 5px; background: #173a35b8; opacity: 0; transition: opacity .16s ease; }
.screenshot-card:hover .screenshot-overlay, .screenshot-card:focus-within .screenshot-overlay { opacity: 1; }
.screenshot-overlay button { width: 29px; height: 29px; display: grid; place-items: center; border: 1px solid #ffffff55; border-radius: 7px; background: #fffdf8; color: #315f51; font-size: 16px; }
.screenshot-overlay button.danger { color: #ad4f40; }
.quiet-empty { margin: 12px 0 0; color: #929a96; font-size: 10px; }
.run-list { display: grid; gap: 8px; }
.run-list article { display: flex; align-items: flex-start; gap: 9px; padding: 9px; background: #f8f6f0; border-radius: 7px; }
.run-dot { width: 7px; height: 7px; margin-top: 5px; border-radius: 50%; background: #858e89; }
.run-dot[data-run="succeeded"] { background: #479069; }
.run-dot[data-run="failed"] { background: #c85e4c; }
.run-dot[data-run="needs_login"] { background: #d88b31; }
.run-dot[data-run="running"], .run-dot[data-run="queued"] { background: #4c83bc; }
.run-list article > div { flex: 1; min-width: 0; }
.run-list strong { display: block; color: #3a4742; font-size: 10px; }
.run-list span { float: right; color: #939a96; font-size: 9px; font-weight: 400; }
.run-list small { display: block; margin-top: 3px; color: #838c87; font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.drawer-actions { flex: 0 0 75px; width: 100%; padding: 15px 22px; display: flex; align-items: center; justify-content: space-between; background: #fffdf9e8; border-top: 1px solid #ddd6c8; backdrop-filter: blur(10px); }
.drawer-loading { height: 100%; display: grid; place-items: center; }
.automation-pause-note { margin-top: 12px; padding: 12px; border-radius: 10px; background: #fff4e4; color: #855c27; display: flex; align-items: center; gap: 10px; }
.automation-pause-note > i { font-size: 20px; }
.automation-pause-note > span { display: grid; gap: 2px; flex: 1; }
.automation-pause-note small { font-size: 11px; color: #9a7443; }
.automation-pause-note button { border: 0; background: transparent; color: #a85a2d; font-size: 12px; font-weight: 600; text-decoration: underline; }
@media (max-width: 1280px) { .detail-drawer { width: 360px; } }
@media (max-width: 1100px) { .detail-drawer { width: min(390px, 100vw); } }
@media (hover: none) { .screenshot-overlay { opacity: 1; } }
</style>
