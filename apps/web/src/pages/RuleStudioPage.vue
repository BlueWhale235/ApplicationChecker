<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type {
  AssistedParserRule,
  AssistedParserRuleDefinition,
  AssistedRuleLayout,
  AssistedRuleTestResult,
  LocalDomNode,
  RecognitionPreviewDetail,
  RecognitionPreviewSnapshot,
  RuleStudioCheckGroupOption,
} from "@application-checker/contracts";
import { progressLabels } from "@application-checker/contracts";
import { api } from "../api";
import { isSelectableRuleNode, pickRuleNodeAtPoint } from "./rule-studio-selection";

defineProps<{ busy: boolean }>();
const emit = defineEmits<{
  failure: [message: string];
  notice: [message: string];
  delete: [rule: AssistedParserRule];
  confirm: [
    options: { title: string; message: string; confirmLabel: string; danger: boolean },
    done: (confirmed: boolean) => void,
  ];
}>();

const rules = ref<AssistedParserRule[]>([]);
const selectedApplicationId = ref("");
const checkGroupOptions = ref<RuleStudioCheckGroupOption[]>([]);
const checkGroupSearch = ref("");
const loadingCheckGroups = ref(false);
const preview = ref<RecognitionPreviewDetail | null>(null);
const previewData = ref<RecognitionPreviewSnapshot | null>(null);
const loadingPreview = ref(false);
const selectedTitleNodeId = ref<number | null>(null);
const selectedStatusNodeId = ref<number | null>(null);
const picking = ref<"title" | "status">("title");
const hoveredNodeId = ref<number | null>(null);
const testResult = ref<AssistedRuleTestResult | null>(null);
const editingId = ref<string | null>(null);
const draftDefinition = ref<AssistedParserRuleDefinition | null>(null);
const draftErrors = ref<string[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const editor = reactive({
  name: "",
  layout: "list" as AssistedRuleLayout,
  hostname: "",
  pathname: "",
  priority: 100,
  enabled: true,
});
let previewTimer: number | undefined;
let checkGroupTimer: number | undefined;

const applicationItems = computed(() => checkGroupOptions.value.map((item) => ({
  title: `${item.company} · ${item.jobTitle}${item.memberCount > 1 ? ` · ${item.memberCount} 个岗位` : ""} · ${item.site}`,
  value: item.applicationId,
})));
const selectedNodes = computed(() => new Set([
  selectedTitleNodeId.value,
  selectedStatusNodeId.value,
  hoveredNodeId.value,
].filter((value): value is number => value !== null)));
const selectableNodes = computed(() => (previewData.value?.snapshot.nodes ?? []).filter((node) =>
  isSelectableRuleNode(
    node,
    previewData.value?.screenshotWidth ?? 1,
    previewData.value?.screenshotHeight ?? 1,
  )));
const canGenerate = computed(() => Boolean(previewData.value && selectedTitleNodeId.value && selectedStatusNodeId.value));
const canSave = computed(() => Boolean(draftDefinition.value && !draftErrors.value.length && testResult.value?.valid));

function describeNode(node: LocalDomNode | undefined): string {
  if (!node) return "尚未选择";
  const marker = [node.tag, node.role, ...node.classes, node.dataStatus, node.ariaCurrent].filter(Boolean).join(".");
  return `${node.text || "(无文本)"} · ${marker}`;
}
function nodeById(id: number | null): LocalDomNode | undefined {
  return previewData.value?.snapshot.nodes.find((node) => node.id === id);
}
function selectNode(node: LocalDomNode): void {
  testResult.value = null;
  draftDefinition.value = null;
  if (picking.value === "title") {
    selectedTitleNodeId.value = node.id;
    picking.value = "status";
  } else {
    selectedStatusNodeId.value = node.id;
  }
}

function pointFromEvent(event: MouseEvent): { x: number; y: number } | null {
  if (!previewData.value) return null;
  const rectangle = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (!rectangle.width || !rectangle.height) return null;
  return {
    x: (event.clientX - rectangle.left) / rectangle.width * previewData.value.screenshotWidth,
    y: (event.clientY - rectangle.top) / rectangle.height * previewData.value.screenshotHeight,
  };
}

function pickFromCanvas(event: MouseEvent): void {
  const point = pointFromEvent(event);
  if (!point || !previewData.value) return;
  const node = pickRuleNodeAtPoint(
    previewData.value.snapshot.nodes,
    point,
    previewData.value.screenshotWidth,
    previewData.value.screenshotHeight,
  );
  if (node) selectNode(node);
}

function hoverFromCanvas(event: MouseEvent): void {
  const point = pointFromEvent(event);
  if (!point || !previewData.value) return;
  hoveredNodeId.value = pickRuleNodeAtPoint(
    previewData.value.snapshot.nodes,
    point,
    previewData.value.screenshotWidth,
    previewData.value.screenshotHeight,
  )?.id ?? null;
}

async function loadRules(): Promise<void> {
  try {
    rules.value = await api.parserRules();
  } catch (value) {
    emit("failure", value instanceof Error ? value.message : "加载规则失败");
  }
}

async function loadCheckGroups(query = ""): Promise<void> {
  loadingCheckGroups.value = true;
  try {
    checkGroupOptions.value = await api.parserRuleCheckGroups(query, 30);
  } catch (value) {
    emit("failure", value instanceof Error ? value.message : "加载检查组失败");
  } finally {
    loadingCheckGroups.value = false;
  }
}

function resetEditor(): void {
  editingId.value = null;
  selectedTitleNodeId.value = null;
  selectedStatusNodeId.value = null;
  picking.value = "title";
  testResult.value = null;
  draftDefinition.value = null;
  draftErrors.value = [];
  Object.assign(editor, { name: "", layout: "list", hostname: "", pathname: "", priority: 100, enabled: true });
}

async function pollPreview(): Promise<void> {
  if (!preview.value) return;
  try {
    preview.value = await api.recognitionPreview(preview.value.id);
    if (["queued", "running"].includes(preview.value.status)) {
      previewTimer = window.setTimeout(() => void pollPreview(), 1_000);
      return;
    }
    loadingPreview.value = false;
    if (preview.value.status !== "succeeded") {
      emit("failure", preview.value.error || `预览状态：${preview.value.status}`);
      return;
    }
    previewData.value = await api.recognitionPreviewSnapshot(preview.value.id);
    const url = new URL(previewData.value.snapshot.url);
    editor.hostname = url.hostname;
    editor.pathname = url.pathname || "/";
    editor.name ||= `${url.hostname} 状态规则`;
  } catch (value) {
    loadingPreview.value = false;
    emit("failure", value instanceof Error ? value.message : "加载预览失败");
  }
}

async function createPreview(): Promise<void> {
  if (!selectedApplicationId.value) return;
  if (previewTimer) clearTimeout(previewTimer);
  resetEditor();
  previewData.value = null;
  loadingPreview.value = true;
  try {
    preview.value = await api.createRecognitionPreview(selectedApplicationId.value);
    await pollPreview();
  } catch (value) {
    loadingPreview.value = false;
    emit("failure", value instanceof Error ? value.message : "创建预览失败");
  }
}

async function generateRule(): Promise<void> {
  if (!preview.value || !selectedTitleNodeId.value || !selectedStatusNodeId.value) return;
  try {
    const generated = await api.generateParserRule(preview.value.id, {
      layout: editor.layout,
      titleNodeId: selectedTitleNodeId.value,
      statusNodeId: selectedStatusNodeId.value,
      name: editor.name,
    });
    draftDefinition.value = generated.definition;
    editor.hostname = generated.definition.hostname;
    editor.pathname = generated.definition.pathname;
    draftErrors.value = generated.errors;
    testResult.value = null;
    if (!generated.errors.length) emit("notice", "规则草稿已生成，请执行无写入测试");
  } catch (value) {
    emit("failure", value instanceof Error ? value.message : "生成规则失败");
  }
}

function currentRule(): AssistedParserRule | null {
  if (!draftDefinition.value) return null;
  const existing = editingId.value ? rules.value.find((rule) => rule.id === editingId.value) : null;
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? "draft",
    name: editor.name,
    enabled: editor.enabled,
    priority: editor.priority,
    version: existing?.version ?? 1,
    definition: { ...draftDefinition.value, hostname: editor.hostname, pathname: editor.pathname, layout: editor.layout },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastTestedAt: existing?.lastTestedAt ?? null,
  };
}

async function testRule(): Promise<void> {
  if (!preview.value) return;
  const rule = currentRule();
  if (!rule) return;
  try {
    testResult.value = await api.testParserRule(preview.value.id, rule);
    draftErrors.value = testResult.value.errors;
    if (testResult.value.valid) emit("notice", "无写入测试通过");
    else emit("failure", testResult.value.errors.join("；"));
  } catch (value) {
    emit("failure", value instanceof Error ? value.message : "测试规则失败");
  }
}

async function saveRule(): Promise<void> {
  const rule = currentRule();
  if (!rule || !canSave.value) return;
  try {
    const body = {
      name: editor.name,
      enabled: editor.enabled,
      priority: editor.priority,
      definition: rule.definition,
      tested: true,
    };
    if (editingId.value) await api.updateParserRule(editingId.value, body);
    else await api.createParserRule(body);
    await loadRules();
    resetEditor();
    emit("notice", "解析规则已保存");
  } catch (value) {
    emit("failure", value instanceof Error ? value.message : "保存规则失败");
  }
}

function editRule(rule: AssistedParserRule, duplicate = false): void {
  editingId.value = duplicate ? null : rule.id;
  draftDefinition.value = structuredClone(rule.definition);
  draftErrors.value = [];
  testResult.value = null;
  Object.assign(editor, {
    name: duplicate ? `${rule.name} 副本` : rule.name,
    layout: rule.definition.layout,
    hostname: rule.definition.hostname,
    pathname: rule.definition.pathname,
    priority: duplicate ? rule.priority - 1 : rule.priority,
    enabled: rule.enabled,
  });
}

async function toggleRule(rule: AssistedParserRule): Promise<void> {
  try {
    await api.updateParserRule(rule.id, {
      name: rule.name,
      enabled: !rule.enabled,
      priority: rule.priority,
      definition: rule.definition,
    });
    await loadRules();
  } catch (value) {
    emit("failure", value instanceof Error ? value.message : "更新规则失败");
  }
}

async function exportRules(): Promise<void> {
  try {
    const data = await api.exportParserRules();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `application-checker-parser-rules-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (value) {
    emit("failure", value instanceof Error ? value.message : "导出规则失败");
  }
}

async function importRules(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const body = JSON.parse(await file.text()) as { schemaVersion: number; rules: AssistedParserRule[] };
    const previewResult = await api.importParserRules({ ...body, confirm: false });
    if (!previewResult.added) throw new Error(`没有可导入规则，冲突或无效 ${previewResult.skipped} 条`);
    const confirmed = await new Promise<boolean>((resolve) => emit("confirm", {
      title: "导入解析规则",
      message: `将新增 ${previewResult.added} 条本地解析规则，跳过 ${previewResult.skipped} 条冲突或无效规则。`,
      confirmLabel: "导入规则",
      danger: false,
    }, resolve));
    if (!confirmed) return;
    const result = await api.importParserRules({ ...body, confirm: true });
    await loadRules();
    emit("notice", `已导入 ${result.added} 条规则，跳过 ${result.skipped} 条`);
  } catch (value) {
    emit("failure", value instanceof Error ? value.message : "导入规则失败");
  } finally {
    if (fileInput.value) fileInput.value.value = "";
  }
}

watch(checkGroupSearch, (query) => {
  const selectedTitle = applicationItems.value.find((item) => item.value === selectedApplicationId.value)?.title;
  if (query === selectedTitle) return;
  if (checkGroupTimer) clearTimeout(checkGroupTimer);
  checkGroupTimer = window.setTimeout(() => void loadCheckGroups(query.trim()), 250);
});
onMounted(() => {
  void Promise.all([loadRules(), loadCheckGroups()]);
});
onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer);
  if (checkGroupTimer) clearTimeout(checkGroupTimer);
});
</script>

<template>
  <section class="page-content rule-studio">
    <div class="page-heading">
      <div>
        <h1>规则工作台</h1>
        <p>在脱敏截图上标记岗位和状态，生成无需 AI 的本地解析规则。</p>
      </div>
      <div class="heading-actions">
        <input ref="fileInput" type="file" accept="application/json" hidden @change="importRules">
        <v-btn variant="outlined" prepend-icon="mdi-upload-outline" @click="fileInput?.click()">导入</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-download-outline" :disabled="!rules.length" @click="exportRules">导出</v-btn>
      </div>
    </div>

    <div class="security-note">
      <i class="mdi mdi-shield-lock-outline"></i>
      仅保存路径与稳定 DOM 特征；输入值、Cookie、令牌、完整 HTML、页面文本和截图不会写入规则。
    </div>

    <div class="studio-layout">
      <aside class="rule-list">
        <div class="panel-title"><strong>本地规则</strong><span>{{ rules.length }}</span></div>
        <article v-for="rule in rules" :key="rule.id" :class="{ disabled: !rule.enabled }">
          <header><strong>{{ rule.name }}</strong><span>v{{ rule.version }}</span></header>
          <p>{{ rule.definition.hostname }}{{ rule.definition.pathname }}</p>
          <small>{{ rule.definition.layout === "list" ? "岗位列表" : "进度条" }} · 优先级 {{ rule.priority }}</small>
          <div class="rule-actions">
            <button @click="editRule(rule)">编辑</button>
            <button @click="editRule(rule, true)">复制</button>
            <button @click="toggleRule(rule)">{{ rule.enabled ? "停用" : "启用" }}</button>
            <button class="danger" @click="emit('delete', rule)">删除</button>
          </div>
        </article>
        <div v-if="!rules.length" class="empty-small">还没有用户辅助规则</div>
      </aside>

      <main class="editor">
        <div class="preview-toolbar">
          <v-autocomplete
            v-model="selectedApplicationId"
            v-model:search="checkGroupSearch"
            :items="applicationItems"
            :loading="loadingCheckGroups"
            label="选择检查组中的岗位"
            placeholder="输入公司、岗位、域名或链接筛选"
            no-data-text="没有匹配的检查组"
            density="compact"
            hide-details
            no-filter
            clearable
          />
          <v-btn color="primary" prepend-icon="mdi-camera-outline" :loading="loadingPreview" :disabled="!selectedApplicationId" @click="createPreview">
            加载页面
          </v-btn>
        </div>

        <div v-if="previewData" class="authoring-grid">
          <div class="canvas-column">
            <div class="canvas-tools">
              <button :class="{ active: picking === 'title' }" @click="picking = 'title'">1. 点选岗位标题</button>
              <button :class="{ active: picking === 'status' }" @click="picking = 'status'">2. 点选当前状态</button>
              <span>{{ selectableNodes.length }} 个可选元素</span>
            </div>
            <div class="canvas-scroll">
              <div
                class="screenshot-canvas"
                :style="{ aspectRatio: `${previewData.screenshotWidth}/${previewData.screenshotHeight}` }"
                @click="pickFromCanvas"
                @mousemove="hoverFromCanvas"
                @mouseleave="hoveredNodeId = null"
              >
                <img :src="api.recognitionPreviewScreenshotUrl(preview!.id)" alt="招聘页面预览">
                <button
                  v-for="node in selectableNodes"
                  :key="node.id"
                  class="node-box"
                  :class="{
                    selected: selectedNodes.has(node.id),
                    title: selectedTitleNodeId === node.id,
                    status: selectedStatusNodeId === node.id,
                    matched: testResult?.matchedNodeIds.includes(node.id),
                  }"
                  :style="{
                    left: `${node.x / previewData.screenshotWidth * 100}%`,
                    top: `${node.y / previewData.screenshotHeight * 100}%`,
                    width: `${node.width / previewData.screenshotWidth * 100}%`,
                    height: `${node.height / previewData.screenshotHeight * 100}%`,
                  }"
                  :title="describeNode(node)"
                />
              </div>
            </div>
          </div>

          <aside class="rule-editor">
            <v-text-field v-model="editor.name" label="规则名称" density="compact" />
            <v-btn-toggle v-model="editor.layout" mandatory color="primary" density="compact">
              <v-btn value="list">岗位列表</v-btn>
              <v-btn value="stepper">进度条</v-btn>
            </v-btn-toggle>
            <div class="selection-card">
              <small>岗位标题</small><strong>{{ describeNode(nodeById(selectedTitleNodeId)) }}</strong>
              <small>当前状态</small><strong>{{ describeNode(nodeById(selectedStatusNodeId)) }}</strong>
            </div>
            <v-text-field v-model="editor.hostname" label="Hostname URLPattern" density="compact" />
            <v-text-field v-model="editor.pathname" label="Pathname URLPattern" density="compact" />
            <v-text-field v-model.number="editor.priority" type="number" label="优先级" density="compact" />
            <v-switch v-model="editor.enabled" label="保存后启用" color="primary" hide-details />
            <div v-if="draftErrors.length" class="errors">
              <p v-for="message in draftErrors" :key="message">{{ message }}</p>
            </div>
            <div class="editor-actions">
              <v-btn variant="outlined" :disabled="!canGenerate" @click="generateRule">生成草稿</v-btn>
              <v-btn variant="outlined" :disabled="!draftDefinition" @click="testRule">无写入测试</v-btn>
              <v-btn color="primary" :disabled="!canSave" @click="saveRule">保存规则</v-btn>
            </div>
            <div v-if="testResult" class="test-results">
              <strong>{{ testResult.valid ? "测试通过" : "测试未通过" }}</strong>
              <article v-for="item in testResult.result.results" :key="item.applicationId">
                <span>{{ previewData.applications.find((candidate) => candidate.id === item.applicationId)?.jobTitle }}</span>
                <b>{{ item.status ? progressLabels[item.status] : "未匹配" }}</b>
                <small>{{ item.evidence }}</small>
              </article>
            </div>
          </aside>
        </div>

        <div v-else class="preview-empty">
          <i class="mdi mdi-vector-square"></i>
          <h2>选择岗位并加载页面</h2>
          <p>预览任务不会新增任务、修改岗位状态、通知或时间线，也不会调用 AI。</p>
        </div>
      </main>
    </div>
  </section>
</template>

<style scoped>
.rule-studio { max-width: 1560px; }
.page-heading, .heading-actions, .preview-toolbar, .panel-title, article header, .rule-actions, .editor-actions, .canvas-tools { display: flex; align-items: center; gap: 10px; }
.page-heading { justify-content: space-between; }
.heading-actions { flex-wrap: wrap; }
.security-note { margin: 16px 0; padding: 12px 15px; border: 1px solid #b8d7c8; border-radius: 12px; background: #edf7f1; color: #315d4d; font-size: 13px; }
.security-note i { margin-right: 8px; }
.studio-layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 700px; border: 1px solid #ded5c6; border-radius: 16px; overflow: hidden; background: #fffdf9; }
.rule-list { padding: 16px; border-right: 1px solid #e4ddcf; background: #f7f3ea; overflow-y: auto; }
.panel-title { justify-content: space-between; margin-bottom: 12px; color: #173f37; }
.panel-title span { padding: 2px 8px; border-radius: 999px; background: #dfece6; }
.rule-list article { margin-bottom: 10px; padding: 12px; border: 1px solid #ded6c8; border-radius: 10px; background: #fff; }
.rule-list article.disabled { opacity: .58; }
.rule-list article header { justify-content: space-between; }
.rule-list p { margin: 7px 0; overflow: hidden; color: #66756f; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.rule-list small { color: #839089; }
.rule-actions { margin-top: 10px; flex-wrap: wrap; }
.rule-actions button { border: 0; background: transparent; color: #28735c; font-size: 12px; }
.rule-actions .danger { color: #b74f42; }
.editor { min-width: 0; padding: 18px; }
.preview-toolbar { margin-bottom: 16px; }
.preview-toolbar .v-input { max-width: 720px; }
.authoring-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; }
.canvas-column { min-width: 0; }
.canvas-tools { margin-bottom: 10px; flex-wrap: wrap; }
.canvas-tools button { padding: 7px 10px; border: 1px solid #d6cec0; border-radius: 8px; background: #fff; color: #5d6d66; }
.canvas-tools button.active { border-color: #338168; background: #e9f4ef; color: #216a54; }
.canvas-tools span { margin-left: auto; color: #839089; font-size: 12px; }
.canvas-scroll { max-height: calc(100vh - 275px); overflow: auto; border: 1px solid #d8d0c2; border-radius: 10px; background: #e9e6df; }
.screenshot-canvas { position: relative; width: 100%; min-width: 620px; }
.screenshot-canvas img { position: absolute; inset: 0; width: 100%; height: 100%; }
.node-box { position: absolute; z-index: 2; min-width: 2px; min-height: 2px; padding: 0; border: 1px solid transparent; background: transparent; pointer-events: none; }
.node-box:hover, .node-box.selected { z-index: 4; border-color: #e2933d; background: #f0a54b33; }
.node-box.title { border: 2px solid #287fd1; background: #4a9be533; }
.node-box.status { border: 2px solid #d46b3f; background: #e8865633; }
.node-box.matched { box-shadow: 0 0 0 2px #39a66b; }
.rule-editor { min-width: 0; padding-left: 2px; }
.selection-card { margin: 12px 0 18px; padding: 12px; border-radius: 10px; background: #f6f2e9; display: grid; gap: 5px; }
.selection-card small { color: #75827c; }
.selection-card strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.errors { margin-bottom: 12px; padding: 10px; border-radius: 8px; background: #fff0ed; color: #a8483b; font-size: 12px; }
.errors p { margin: 2px 0; }
.editor-actions { flex-wrap: wrap; }
.test-results { margin-top: 16px; display: grid; gap: 8px; }
.test-results article { padding: 9px; border: 1px solid #e3dccf; border-radius: 8px; display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; }
.test-results small { grid-column: 1 / -1; color: #78857f; }
.preview-empty { min-height: 560px; display: grid; place-content: center; justify-items: center; color: #7e8b85; text-align: center; }
.preview-empty i { font-size: 54px; color: #9eb7ad; }
.preview-empty h2 { color: #31554b; }
.empty-small { padding: 35px 0; color: #87938d; text-align: center; }
@media (max-width: 1180px) {
  .studio-layout { grid-template-columns: 230px minmax(0, 1fr); }
  .authoring-grid { grid-template-columns: 1fr; }
  .rule-editor { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .selection-card, .errors, .editor-actions, .test-results { grid-column: 1 / -1; }
}
</style>
