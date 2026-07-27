<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { AiDebugTraceDetail, AiDebugTraceSummary } from "@application-checker/contracts";
import { progressLabels } from "@application-checker/contracts";
import { api } from "../api";

const props = defineProps<{ busy: boolean; refreshToken: number }>();
const emit = defineEmits<{
  clear: [];
  failure: [message: string];
  notice: [message: string];
}>();

const traces = ref<AiDebugTraceSummary[]>([]);
const detail = ref<AiDebugTraceDetail | null>(null);
const selectedId = ref<string | null>(null);
const loading = ref(false);
const activeTab = ref<"input" | "raw" | "parsed" | "attempts">("input");
const screenshotUnavailable = ref(false);
let timer: number | undefined;

const latestResponse = computed(() =>
  [...(detail.value?.attempts ?? [])].reverse().find((attempt) => attempt.responseBody)?.responseBody ?? "",
);

function date(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(value));
}

function duration(value: number | null): string {
  if (value === null) return "进行中";
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(1)} s`;
}

async function selectTrace(id: string): Promise<void> {
  selectedId.value = id;
  screenshotUnavailable.value = false;
  try {
    detail.value = await api.aiDebugTrace(id);
  } catch (value) {
    detail.value = null;
    emit("failure", value instanceof Error ? value.message : "加载 AI 调试详情失败");
  }
}

async function refresh(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  try {
    const next = await api.aiDebugTraces();
    traces.value = next;
    const target = selectedId.value && next.some((item) => item.id === selectedId.value)
      ? selectedId.value
      : next[0]?.id ?? null;
    if (!target) {
      selectedId.value = null;
      detail.value = null;
      return;
    }
    await selectTrace(target);
  } catch (value) {
    emit("failure", value instanceof Error ? value.message : "加载 AI 调试记录失败");
  } finally {
    loading.value = false;
  }
}

async function copy(value: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    emit("notice", `${label}已复制`);
  } catch {
    emit("failure", "复制失败，请检查剪贴板权限");
  }
}

watch(() => props.refreshToken, () => void refresh());
onMounted(() => {
  void refresh();
  timer = window.setInterval(() => void refresh(true), 2_000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="page-content ai-debug-page">
    <div class="page-heading">
      <div>
        <h1>AI 调试</h1>
        <p>查看发送给视觉模型的脱敏输入、原始响应和解析过程。记录仅保存在内存中。</p>
      </div>
      <div class="heading-actions">
        <v-btn variant="outlined" color="primary" prepend-icon="mdi-refresh" :loading="loading" @click="refresh()">刷新</v-btn>
        <v-btn variant="outlined" color="error" prepend-icon="mdi-delete-sweep-outline" :disabled="busy || !traces.length" @click="emit('clear')">
          清空记录
        </v-btn>
      </div>
    </div>

    <div class="debug-security-note">
      <i class="mdi mdi-shield-lock-outline"></i>
      API Key、Authorization、Cookie 和图片 base64 不会显示；每 2 秒自动刷新，最多保留最近 50 次调用。
    </div>

    <div v-if="traces.length" class="debug-layout">
      <aside class="trace-list">
        <button
          v-for="trace in traces"
          :key="trace.id"
          type="button"
          :class="{ active: selectedId === trace.id }"
          @click="selectTrace(trace.id)"
        >
          <span class="trace-top">
            <strong>{{ trace.company }}</strong>
            <i :data-status="trace.status"></i>
          </span>
          <span>{{ trace.applicationCount }} 个岗位 · {{ trace.model }}</span>
          <small>{{ date(trace.createdAt) }} · {{ duration(trace.durationMs) }}</small>
          <small>HTTP {{ trace.httpStatus ?? "—" }} · {{ trace.status }}</small>
        </button>
      </aside>

      <article v-if="detail" class="trace-detail">
        <header class="trace-summary">
          <div>
            <span class="eyebrow">{{ detail.model }}</span>
            <h2>{{ detail.company }} · {{ detail.applicationCount }} 个岗位</h2>
            <p>{{ detail.endpoint }}</p>
          </div>
          <span class="status-chip" :data-status="detail.status">{{ detail.status }}</span>
        </header>

        <nav class="debug-tabs" aria-label="AI 调试详情">
          <button :class="{ active: activeTab === 'input' }" @click="activeTab = 'input'">输入</button>
          <button :class="{ active: activeTab === 'raw' }" @click="activeTab = 'raw'">原始输出</button>
          <button :class="{ active: activeTab === 'parsed' }" @click="activeTab = 'parsed'">解析结果</button>
          <button :class="{ active: activeTab === 'attempts' }" @click="activeTab = 'attempts'">请求过程</button>
        </nav>

        <div v-if="activeTab === 'input'" class="tab-panel input-panel">
          <div class="meta-grid">
            <div><small>页面标题</small><strong>{{ detail.pageTitle || "未知" }}</strong></div>
            <div><small>截图大小</small><strong>{{ detail.screenshotBytes.toLocaleString() }} bytes</strong></div>
            <div><small>最终地址</small><strong>{{ detail.finalUrl || "未知" }}</strong></div>
            <div><small>截图状态</small><strong>{{ detail.screenshotTruncated ? "已截断" : "完整" }}</strong></div>
          </div>
          <div v-if="detail.runId" class="screenshot-card">
            <div class="section-title"><strong>发送给 AI 的截图</strong><span>image/png</span></div>
            <img
              v-if="!screenshotUnavailable"
              :src="api.screenshotUrl(detail.runId)"
              alt="AI 输入截图"
              @error="screenshotUnavailable = true"
            />
            <div v-else class="screenshot-missing"><i class="mdi mdi-image-off-outline"></i>截图已删除或不可用</div>
          </div>
          <div class="code-block">
            <div class="section-title">
              <strong>脱敏请求 JSON</strong>
              <button @click="copy(detail.sanitizedRequest, '请求 JSON')"><i class="mdi mdi-content-copy"></i>复制</button>
            </div>
            <pre>{{ detail.sanitizedRequest }}</pre>
          </div>
        </div>

        <div v-else-if="activeTab === 'raw'" class="tab-panel">
          <div class="code-block">
            <div class="section-title">
              <strong>兼容服务原始响应</strong>
              <button :disabled="!latestResponse" @click="copy(latestResponse, '原始响应')"><i class="mdi mdi-content-copy"></i>复制</button>
            </div>
            <pre>{{ latestResponse || detail.error || "尚无响应" }}</pre>
          </div>
        </div>

        <div v-else-if="activeTab === 'parsed'" class="tab-panel">
          <div v-if="detail.parsed" class="parsed-content">
            <div class="page-result">
              <div><small>页面类型</small><strong>{{ detail.parsed.pageType || "未返回" }}</strong></div>
              <p>{{ detail.parsed.pageEvidence || "没有页面类型证据" }}</p>
            </div>
            <div v-for="item in detail.parsed.results" :key="item.applicationId" class="result-card">
              <div>
                <strong>{{ detail.applications.find((candidate) => candidate.id === item.applicationId)?.jobTitle || item.applicationId }}</strong>
                <small>{{ item.rawStatus || "没有状态原文" }}</small>
              </div>
              <span>{{ item.status ? progressLabels[item.status] : "未匹配" }}</span>
              <span>{{ Math.round(item.confidence * 100) }}%</span>
              <p>{{ item.evidence || "没有证据" }}</p>
            </div>
          </div>
          <div v-else class="empty-detail">{{ detail.error || "结果仍在解析中" }}</div>
        </div>

        <div v-else class="tab-panel attempts-panel">
          <div v-for="(attempt, index) in detail.attempts" :key="`${attempt.startedAt}-${index}`" class="attempt-card">
            <header>
              <strong>第 {{ index + 1 }} 次请求 · {{ attempt.deepThinking ? "深度思考" : "普通模式" }}</strong>
              <span>HTTP {{ attempt.httpStatus ?? "—" }}</span>
            </header>
            <p>{{ date(attempt.startedAt) }} · {{ duration(attempt.durationMs) }}</p>
            <p v-if="attempt.error" class="attempt-error">{{ attempt.error }}</p>
            <small v-if="attempt.responseTruncated">原始响应超过 100 KB，已截断显示。</small>
          </div>
          <div v-if="!detail.attempts.length" class="empty-detail">请求尚未发出</div>
        </div>
      </article>
    </div>

    <div v-else class="debug-empty">
      <i class="mdi mdi-flask-empty-outline"></i>
      <h2>还没有 AI 调试记录</h2>
      <p>运行一次配置了 AI 的岗位检查后，输入和输出会显示在这里。</p>
    </div>
  </section>
</template>

<style scoped>
.ai-debug-page { max-width: 1480px; }
.page-heading, .heading-actions, .trace-top, .trace-summary, .section-title, .attempt-card header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.heading-actions { flex-wrap: wrap; }
.debug-security-note { margin: 18px 0; padding: 12px 16px; border: 1px solid #b8d7c8; border-radius: 12px; background: #edf7f1; color: #315d4d; font-size: 13px; }
.debug-security-note i { margin-right: 8px; }
.debug-layout { display: grid; grid-template-columns: 285px minmax(0, 1fr); min-height: 650px; border: 1px solid #ddd3c2; border-radius: 16px; overflow: hidden; background: #fffdf9; }
.trace-list { max-height: calc(100vh - 220px); overflow-y: auto; border-right: 1px solid #e5ddcf; background: #f7f3ea; }
.trace-list button { width: 100%; padding: 15px 16px; border: 0; border-bottom: 1px solid #e6ded0; background: transparent; color: #4e5c56; text-align: left; display: grid; gap: 5px; }
.trace-list button:hover { background: #fffaf1; }
.trace-list button.active { background: #fff; box-shadow: inset 3px 0 #318269; }
.trace-list strong { color: #183f36; }
.trace-list span, .trace-list small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trace-top i { width: 9px; height: 9px; border-radius: 50%; background: #d7a235; }
.trace-top i[data-status="succeeded"] { background: #329466; }
.trace-top i[data-status="failed"] { background: #c85e4e; }
.trace-detail { min-width: 0; padding: 24px; }
.trace-summary { align-items: flex-start; }
.trace-summary h2 { margin: 4px 0; color: #173f37; }
.trace-summary p { max-width: 720px; margin: 0; overflow: hidden; color: #718079; text-overflow: ellipsis; white-space: nowrap; }
.eyebrow { color: #a75f34; font-size: 12px; text-transform: uppercase; }
.status-chip { padding: 5px 10px; border-radius: 999px; background: #fff2ce; color: #8b6717; font-size: 12px; }
.status-chip[data-status="succeeded"] { background: #e5f5ec; color: #2d7957; }
.status-chip[data-status="failed"] { background: #fdebe7; color: #a94e40; }
.debug-tabs { margin: 22px 0 16px; display: flex; gap: 6px; border-bottom: 1px solid #e5ddcf; overflow-x: auto; }
.debug-tabs button { padding: 10px 14px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: #6e7a75; white-space: nowrap; }
.debug-tabs button.active { border-bottom-color: #318269; color: #1c5f4d; }
.tab-panel { min-width: 0; }
.meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
.meta-grid div, .page-result, .result-card, .attempt-card { padding: 13px 15px; border: 1px solid #e6ded0; border-radius: 10px; background: #fff; }
.meta-grid small, .meta-grid strong { display: block; }
.meta-grid small { color: #89938f; }
.meta-grid strong { margin-top: 4px; overflow-wrap: anywhere; }
.screenshot-card, .code-block { margin-top: 16px; border: 1px solid #e4dccd; border-radius: 12px; overflow: hidden; }
.section-title { padding: 10px 13px; background: #f6f1e8; color: #496059; font-size: 13px; }
.section-title button { border: 0; background: transparent; color: #26725c; }
.section-title button i { margin-right: 5px; }
.screenshot-card img { display: block; width: 100%; max-height: 440px; object-fit: contain; background: #eee9df; }
.screenshot-missing, .empty-detail, .debug-empty { display: grid; place-items: center; color: #87918d; }
.screenshot-missing { min-height: 180px; gap: 8px; }
.screenshot-missing i, .debug-empty i { font-size: 42px; }
.code-block pre { max-height: 520px; margin: 0; padding: 16px; overflow: auto; background: #17231f; color: #d7e6df; font: 12px/1.6 Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.parsed-content, .attempts-panel { display: grid; gap: 10px; }
.page-result strong, .page-result small { display: block; }
.page-result p { margin: 6px 0 0; color: #718079; }
.result-card { display: grid; grid-template-columns: minmax(180px, 1fr) auto auto; align-items: center; gap: 12px; }
.result-card div small { display: block; margin-top: 4px; color: #85908b; }
.result-card p { grid-column: 1 / -1; margin: 0; color: #62716b; }
.attempt-card p { margin: 7px 0 0; color: #78847f; }
.attempt-card small { display: block; margin-top: 7px; color: #a2692d; }
.attempt-error { color: #af4d3f !important; }
.debug-empty { min-height: 430px; align-content: center; text-align: center; }
.debug-empty h2 { margin: 10px 0 4px; color: #38534b; }
.debug-empty p { margin: 0; }
@media (max-width: 980px) {
  .debug-layout { grid-template-columns: 1fr; }
  .trace-list { max-height: 260px; border-right: 0; border-bottom: 1px solid #e5ddcf; }
  .page-heading { align-items: flex-start; }
}
@media (max-width: 680px) {
  .page-heading { display: grid; }
  .heading-actions { width: 100%; }
  .trace-detail { padding: 16px; }
  .meta-grid { grid-template-columns: 1fr; }
  .result-card { grid-template-columns: 1fr auto; }
  .result-card > span:last-of-type { grid-column: 2; }
}
</style>
