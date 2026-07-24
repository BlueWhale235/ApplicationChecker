<script setup lang="ts">
import { ref } from "vue";
import type { TaskRunPage, TaskRunSummary } from "@application-checker/contracts";
import { progressLabels, runLabels } from "@application-checker/contracts";

defineProps<{
  scope: "active" | "history";
  page: TaskRunPage;
  query: string;
  busy: boolean;
  currentPage: number;
  pageCount: number;
}>();
defineEmits<{
  scope: [value: "active" | "history"];
  query: [value: string];
  page: [value: number];
  refresh: [];
  cancel: [run: TaskRunSummary];
  retry: [run: TaskRunSummary];
  login: [run: TaskRunSummary];
  view: [run: TaskRunSummary];
  deleteScreenshot: [run: TaskRunSummary];
}>();

function date(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}
function duration(run: TaskRunSummary): string {
  if (!run.startedAt) return "—";
  const end = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
const triggerLabels = { manual: "手动", bulk: "批量", cron: "定时", login_resume: "登录后继续" } as const;
const expanded = ref(new Set<string>());
function toggleResults(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  expanded.value = next;
}
const resultReasonLabels = {
  manual_locked: "人工锁定",
  low_confidence: "置信度不足",
  unmatched: "未匹配",
  ai_failed: "识别失败",
  automation_paused: "淘汰后暂停，仅保留建议",
} as const;
</script>

<template>
  <section class="page-content task-page">
    <div class="page-heading">
      <div><h1>任务管理</h1><p>查看正在执行和已经完成的网页截图任务。</p></div>
      <v-btn class="task-refresh" variant="outlined" color="primary" prepend-icon="mdi-refresh" :disabled="busy" @click="$emit('refresh')">刷新</v-btn>
    </div>
    <v-btn-toggle
      :model-value="scope"
      mandatory
      color="primary"
      variant="outlined"
      @update:model-value="$emit('scope', $event)"
    >
      <v-btn value="active">当前任务</v-btn>
      <v-btn value="history">历史任务</v-btn>
    </v-btn-toggle>
    <div class="toolbar task-toolbar">
      <v-text-field
        class="search-field"
        :model-value="query"
        placeholder="搜索公司、岗位或站点"
        prepend-inner-icon="mdi-magnify"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        @update:model-value="$emit('query', $event || '')"
      />
      <span class="task-total">共 {{ page.total }} 个任务</span>
    </div>
    <div v-if="page.items.length" class="table-shell task-table-shell">
      <table class="task-table">
        <thead><tr><th>公司 / 岗位</th><th>状态</th><th>来源</th><th>创建 / 开始</th><th>耗时</th><th>截图</th><th>AI 结果</th><th>操作</th></tr></thead>
        <tbody>
          <template v-for="run in page.items" :key="run.id">
          <tr>
            <td><strong>{{ run.company }}</strong><span>{{ run.jobTitle }}</span><small>{{ run.site }} · 包含 {{ run.groupMemberCount }} 个岗位</small></td>
            <td><span class="run-status-chip" :data-run="run.status"><i></i>{{ runLabels[run.status] }}</span></td>
            <td>{{ triggerLabels[run.trigger] }}</td>
            <td><span>{{ date(run.createdAt) }}</span><small>{{ run.startedAt ? `开始 ${date(run.startedAt)}` : "尚未开始" }}</small></td>
            <td>{{ duration(run) }}</td>
            <td>
              <div v-if="run.screenshotAvailable" class="task-screenshot-actions">
                <button aria-label="查看截图" title="查看截图" @click="$emit('view', run)"><i class="mdi mdi-eye-outline"></i></button>
                <button class="danger" aria-label="删除截图" title="删除截图" @click="$emit('deleteScreenshot', run)"><i class="mdi mdi-delete-outline"></i></button>
              </div>
              <span v-else-if="run.status === 'succeeded'" class="screenshot-cleared">已清理</span>
              <span v-else>—</span>
            </td>
            <td>
              <template v-if="run.recognitionResults.length">
                <button class="task-results-toggle" @click="toggleResults(run.id)">
                  {{ run.recognitionResults.filter(item => item.matched).length }}/{{ run.recognitionResults.length }} 已识别
                  <i :class="expanded.has(run.id) ? 'mdi mdi-chevron-up' : 'mdi mdi-chevron-down'"></i>
                </button>
              </template>
              <template v-else-if="run.aiSuggestedStatus"><span>{{ progressLabels[run.aiSuggestedStatus] }}</span><small>{{ Math.round((run.aiConfidence || 0) * 100) }}%</small></template>
              <span v-else>{{ run.aiStatus === "failed" ? "识别失败" : "—" }}</span>
            </td>
            <td>
              <div class="task-row-actions">
                <button v-if="run.status === 'needs_login'" class="row-action" @click="$emit('login', run)">去登录</button>
                <button v-if="['queued','running','needs_login'].includes(run.status)" class="danger-ghost" :disabled="busy" @click="$emit('cancel', run)">取消</button>
                <button v-if="['failed','cancelled'].includes(run.status)" class="row-action" :disabled="busy" @click="$emit('retry', run)">重试</button>
              </div>
            </td>
          </tr>
          <tr v-if="expanded.has(run.id)" class="task-result-row">
            <td colspan="8">
              <div class="task-result-panel">
                <div class="task-result-heading">
                  <div>
                    <i class="mdi mdi-auto-fix"></i>
                    <strong>AI 识别明细</strong>
                  </div>
                  <span>{{ run.recognitionResults.length }} 个岗位</span>
                </div>
                <div class="task-result-grid">
                  <article v-for="result in run.recognitionResults" :key="result.applicationId">
                    <div class="result-title">
                      <strong>{{ result.jobTitle }}</strong>
                      <span v-if="result.rawStatus">{{ result.rawStatus }}</span>
                    </div>
                    <span v-if="result.suggestedStatus" class="status-chip" :data-status="result.suggestedStatus">{{ progressLabels[result.suggestedStatus] }}</span>
                    <span v-else class="result-unmatched">未匹配</span>
                    <div class="result-meta">
                      <span><i class="mdi mdi-chart-donut"></i>{{ result.confidence === null ? "无置信度" : `${Math.round(result.confidence * 100)}%` }}</span>
                      <span :class="{ applied: result.applied }">
                        <i :class="result.applied ? 'mdi mdi-check-circle-outline' : 'mdi mdi-information-outline'"></i>
                        {{ result.applied ? "已更新" : result.notAppliedReason ? resultReasonLabels[result.notAppliedReason] : "仅记录" }}
                      </span>
                    </div>
                    <p v-if="result.evidence"><i class="mdi mdi-text-box-search-outline"></i><span>{{ result.evidence }}</span></p>
                  </article>
                </div>
              </div>
            </td>
          </tr>
          </template>
        </tbody>
      </table>
    </div>
    <div v-else class="task-empty">
      <span class="task-empty-icon"><i :class="scope === 'active' ? 'mdi mdi-camera-timer' : 'mdi mdi-history'"></i></span>
      <strong>{{ scope === "active" ? "当前没有截图任务" : "还没有历史任务" }}</strong>
      <span>{{ scope === "active" ? "发起岗位检查后，正在排队和执行的任务会显示在这里。" : "完成、失败或取消的任务会在这里长期保留。" }}</span>
      <v-btn
        v-if="scope === 'active'"
        variant="text"
        color="primary"
        prepend-icon="mdi-refresh"
        :disabled="busy"
        @click="$emit('refresh')"
      >
        刷新任务
      </v-btn>
    </div>
    <div v-if="scope === 'history' && page.total" class="task-pagination">
      <span>每页 10 条</span>
      <v-pagination
        :model-value="currentPage"
        :length="pageCount"
        :total-visible="7"
        density="comfortable"
        rounded="circle"
        @update:model-value="$emit('page', $event)"
      />
      <span>共 {{ page.total }} 条</span>
    </div>
  </section>
</template>

<style scoped>
.task-page { max-width: 1380px; }
.task-refresh { display: inline-flex; align-items: center; gap: 7px; }
.task-toolbar { display: flex; align-items: center; gap: 10px; margin: 23px 0 12px; }
.search-field { flex: 1 1 360px; max-width: 520px; }
.task-total { margin-left: auto; color: #77817c; font-size: 11px; }
.task-table-shell { overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: #fffdf8; box-shadow: 0 10px 32px #183a3708; }
.task-table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fffdf8; }
.task-table th { height: 43px; padding: 0 12px; color: #6a756f; font-size: 10px; font-weight: 500; text-align: left; background: #f5f1e8; border-bottom: 1px solid #ddd6c8; }
.task-table td { min-height: 68px; padding: 13px 12px; color: #41504a; font-size: 11px; vertical-align: middle; border-bottom: 1px solid #e9e3d8; }
.task-table tbody tr:hover { background: #f1f6f3; }
.task-table th:nth-child(1) { width: 19%; }
.task-table th:nth-child(2) { width: 11%; }
.task-table th:nth-child(3) { width: 8%; }
.task-table th:nth-child(4) { width: 16%; }
.task-table th:nth-child(5), .task-table th:nth-child(6) { width: 9%; }
.task-table th:nth-child(7) { width: 11%; }
.task-table th:nth-child(8) { width: 17%; }
.task-table td strong, .task-table td span, .task-table td small { display: block; }
.task-table td strong { color: #263a33; font-size: 12px; }
.task-table td small { margin-top: 4px; color: #8a938e; font-size: 9px; }
.run-status-chip { display: inline-flex !important; align-items: center; gap: 6px; font-weight: 600; }
.run-status-chip i { width: 7px; height: 7px; border-radius: 50%; background: #818b86; }
.run-status-chip[data-run="queued"] i, .run-status-chip[data-run="running"] i { background: #4c83bc; }
.run-status-chip[data-run="needs_login"] i { background: #d88b31; }
.run-status-chip[data-run="succeeded"] i { background: #479069; }
.run-status-chip[data-run="failed"] i, .run-status-chip[data-run="cancelled"] i { background: #c85e4c; }
.task-screenshot-actions, .task-row-actions { display: flex; align-items: center; gap: 6px; }
.task-screenshot-actions button { width: 29px; height: 29px; display: grid; place-items: center; border: 1px solid #d7d0c3; border-radius: 7px; background: #fffdf8; color: #315f51; font-size: 16px; }
.task-screenshot-actions button.danger { color: #ad4f40; }
.task-row-actions .danger-ghost { padding: 7px 5px; }
.screenshot-cleared { color: #9a8f80; }
.task-pagination { min-height: 62px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 14px; color: #7b8580; font-size: 11px; }
.task-pagination > span:last-child { text-align: right; }
.task-empty { min-height: 320px; padding: 36px; border: 1px dashed #d9d3c7; border-radius: 16px; display: grid; place-content: center; justify-items: center; gap: 9px; background: #fffdf88a; color: #839089; text-align: center; }
.task-empty-icon { width: 58px; height: 58px; margin-bottom: 4px; display: grid; place-items: center; border-radius: 50%; background: #e9f3ee; color: #4f8a72; font-size: 29px; }
.task-empty strong { color: #354b43; font: 600 16px "Noto Serif SC", serif; }
.task-empty > span:not(.task-empty-icon) { max-width: 380px; font-size: 12px; line-height: 1.7; }
.task-results-toggle { padding: 0; border: 0; background: transparent; color: #276b59; font-size: 11px; }
.task-result-row td { padding: 0 14px 14px !important; background: #f7f3ea; }
.task-result-panel { padding: 14px; border: 1px solid #dfd8ca; border-radius: 12px; background: #fbfaf6; box-shadow: 0 5px 18px #183a3708; }
.task-result-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; color: #607069; font-size: 10px; }
.task-result-heading > div { display: flex; align-items: center; gap: 7px; }
.task-result-heading i { color: #b96537; font-size: 15px; }
.task-result-heading strong { color: #2d443b; font-size: 12px; }
.task-result-heading > span { padding: 3px 8px; border-radius: 10px; background: #eee9df; }
.task-result-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.task-result-grid article { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-content: start; gap: 10px 12px; padding: 13px 14px; border: 1px solid #e5ded1; border-radius: 10px; background: #fffdf8; transition: .16s ease; }
.task-result-grid article:hover { border-color: #c9d8d1; box-shadow: 0 5px 14px #1c4a3d0c; }
.result-title { min-width: 0; display: grid; gap: 4px; }
.result-title strong { overflow: hidden; color: #263d35 !important; font-size: 12px !important; white-space: nowrap; text-overflow: ellipsis; }
.result-title > span { overflow: hidden; color: #697872; font-size: 10px; white-space: nowrap; text-overflow: ellipsis; }
.task-result-grid .status-chip { align-self: start; height: 23px; padding: 0 9px; font-size: 9px; }
.result-meta { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 7px 16px; padding-top: 9px; border-top: 1px solid #eee8dd; color: #7a8882; font-size: 9px; }
.result-meta span { display: inline-flex; align-items: center; gap: 4px; }
.result-meta span.applied { color: #347c5f; }
.task-result-grid article p { grid-column: 1 / -1; margin: 0; padding: 8px 9px; display: flex; align-items: flex-start; gap: 6px; border-radius: 7px; background: #f5f2ea; color: #66756f; font-size: 9px; line-height: 1.55; }
.task-result-grid article p > i { flex: 0 0 auto; margin-top: 1px; color: #9a765d; font-size: 12px; }
.result-unmatched { align-self: start; color: #9a6b41; font-size: 10px; }
@media (max-width: 1100px) {
  .task-table { min-width: 980px; }
  .task-table-shell { overflow-x: auto; }
  .task-result-grid { grid-template-columns: 1fr; }
}
</style>
