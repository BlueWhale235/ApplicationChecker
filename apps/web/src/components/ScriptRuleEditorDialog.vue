<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { RecognitionPreviewDetail, RecognitionPreviewSnapshot } from "@application-checker/contracts";
import { progressLabels } from "@application-checker/contracts";
import MonacoScriptEditor from "./MonacoScriptEditor.vue";

const props = defineProps<{
  open: boolean;
  applicationItems: Array<{ title: string; value: string }>;
  loadingCheckGroups: boolean;
  loadingPreview: boolean;
  previewAvailable: boolean;
  previewData: RecognitionPreviewSnapshot | null;
  testResult: RecognitionPreviewDetail | null;
  testing: boolean;
  canSave: boolean;
  editing: boolean;
  definitionChanged: boolean;
  dirty: boolean;
  timeoutValid: boolean;
  examples: Record<string, { label: string; code: string }>;
}>();

const emit = defineEmits<{
  close: [];
  "switch-selector": [];
  "load-preview": [];
  "apply-example": [];
  "open-docs": [];
  test: [];
  save: [];
}>();

const script = defineModel<string>("script", { required: true });
const name = defineModel<string>("name", { required: true });
const hostname = defineModel<string>("hostname", { required: true });
const pathname = defineModel<string>("pathname", { required: true });
const priority = defineModel<number>("priority", { required: true });
const timeoutMs = defineModel<number>("timeoutMs", { required: true });
const enabled = defineModel<boolean>("enabled", { required: true });
const selectedApplicationId = defineModel<string>("selectedApplicationId", { required: true });
const checkGroupSearch = defineModel<string>("checkGroupSearch", { required: true });
const selectedExample = defineModel<string>("selectedExample", { required: true });

const monacoEditor = ref<InstanceType<typeof MonacoScriptEditor> | null>(null);
const testPanelExpanded = ref(true);
const exampleItems = computed(() => Object.entries(props.examples).map(([value, item]) => ({
  title: item.label,
  value,
})));
const saveState = computed(() => props.editing && !props.dirty
  ? { label: "已保存", icon: "mdi-cloud-check-outline", saved: true }
  : { label: "未保存", icon: "mdi-cloud-alert-outline", saved: false });

watch(() => props.testResult?.id, (id, previousId) => {
  if (id && id !== previousId) testPanelExpanded.value = true;
});

const APPLICATION_FIELDS = [
  ["id", "岗位 ID"], ["company", "公司"], ["jobTitle", "岗位名称"], ["checkUrl", "检查链接"],
  ["postingUrl", "投递链接"], ["appliedAt", "投递时间"], ["location", "地点"], ["notes", "备注"],
  ["site", "站点"], ["progressStatus", "当前状态"],
] as const;

function insertApplicationField(field: string): void {
  monacoEditor.value?.insertText(`application.${field}`);
}
</script>

<template>
  <v-dialog :model-value="open" fullscreen persistent transition="dialog-bottom-transition" @keydown.esc.stop.prevent="emit('close')">
    <v-card class="script-workspace">
      <header class="workspace-header">
        <div class="workspace-title">
          <span class="script-mark"><i class="mdi mdi-code-braces"></i></span>
          <div><strong>{{ editing ? "编辑页面脚本" : "新建页面脚本" }}</strong><small>{{ name.trim() || "尚未命名的脚本规则" }}</small></div>
          <span class="advanced-badge">高级</span>
        </div>
        <div class="workspace-header-actions">
          <span class="save-state-pill" :class="{ saved: saveState.saved }"><i class="mdi" :class="saveState.icon"></i>{{ saveState.label }}</span>
          <button type="button" @click="emit('open-docs')"><i class="mdi mdi-book-open-page-variant-outline"></i>API 文档</button>
          <button type="button" @click="emit('switch-selector')"><i class="mdi mdi-vector-square"></i>改回点选规则</button>
          <button class="close-button" type="button" aria-label="关闭脚本编辑器" @click="emit('close')"><i class="mdi mdi-close"></i></button>
        </div>
      </header>

      <section class="workspace-toolbar">
        <v-autocomplete v-model="selectedApplicationId" v-model:search="checkGroupSearch" :items="applicationItems"
          :loading="loadingCheckGroups" label="选择检查组中的岗位" placeholder="输入公司、岗位、域名或链接筛选"
          no-data-text="没有匹配的检查组" density="compact" variant="outlined" hide-details no-filter clearable />
        <v-btn color="primary" prepend-icon="mdi-camera-outline" :loading="loadingPreview" :disabled="!selectedApplicationId" @click="emit('load-preview')">加载页面</v-btn>
        <div class="toolbar-spacer"></div>
        <div class="example-select">
          <span>示例脚本</span>
          <v-select v-model="selectedExample" :items="exampleItems" density="compact" variant="outlined" hide-details
            aria-label="示例脚本" @update:model-value="emit('apply-example')" />
        </div>
        <span class="timeout-chip"><i class="mdi mdi-timer-outline"></i>最长 {{ timeoutMs / 1000 }} 秒</span>
      </section>

      <div class="workspace-body">
        <main class="workspace-main">
          <section class="monaco-panel">
            <MonacoScriptEditor ref="monacoEditor" v-model="script" @save="emit('save')" />
          </section>
          <footer class="editor-context">
            <span>可用对象：<code>application</code>、<code>applications</code>、<code>helpers</code></span>
            <small>Ctrl/Cmd + S 保存 · F1 命令面板 · Shift + Alt + F 格式化</small>
          </footer>

          <section v-if="testResult" class="test-drawer" :class="{ collapsed: !testPanelExpanded }">
            <header>
              <div><i class="mdi" :class="testResult.status === 'succeeded' && testResult.matchedCount ? 'mdi-check-circle-outline' : 'mdi-alert-circle-outline'"></i>
                <strong>{{ testResult.status === "succeeded" && testResult.matchedCount ? "测试通过" : "测试未通过" }}</strong></div>
              <div class="test-drawer-actions">
                <span v-if="testResult.scriptDurationMs !== null">{{ testResult.scriptDurationMs }}ms</span>
                <button type="button" :aria-label="testPanelExpanded ? '收起测试结果' : '展开测试结果'" :title="testPanelExpanded ? '收起测试结果' : '展开测试结果'"
                  @click="testPanelExpanded = !testPanelExpanded"><i class="mdi" :class="testPanelExpanded ? 'mdi-chevron-down' : 'mdi-chevron-up'"></i></button>
              </div>
            </header>
            <div v-show="testPanelExpanded" class="test-drawer-content">
              <div class="result-list">
                <article v-for="item in testResult.results" :key="item.applicationId">
                  <div><strong>{{ previewData?.applications.find((candidate) => candidate.id === item.applicationId)?.jobTitle }}</strong><b>{{ item.status ? progressLabels[item.status] : "未匹配" }}</b></div>
                  <small>原始状态：{{ item.rawStatus || "无" }}</small><p>{{ item.evidence }}</p>
                </article>
                <p v-if="testResult.error" class="error-text">{{ testResult.error }}</p>
              </div>
              <section v-if="testResult.scriptLogs.length || testResult.scriptLogsTruncated" class="script-console">
                <header><span><i class="mdi mdi-console-line"></i>调试输出</span><small>{{ testResult.scriptLogs.length }} 条</small></header>
                <div class="script-console-lines">
                  <p v-for="(entry, index) in testResult.scriptLogs" :key="`${entry.atMs}-${index}`"><time>[{{ entry.atMs }}ms]</time><span>{{ entry.message }}</span></p>
                  <p v-if="testResult.scriptLogsTruncated" class="console-truncated"><i class="mdi mdi-alert-outline"></i>后续日志已截断（最多 100 条、单条 2KB、总量 32KB）</p>
                </div>
              </section>
            </div>
          </section>
        </main>

        <aside class="workspace-inspector">
          <div class="inspector-scroll">
            <section class="inspector-section rule-settings">
              <div class="section-heading"><div><i class="mdi mdi-tune-variant"></i><strong>规则设置</strong></div><small>名称与执行范围</small></div>
              <v-text-field v-model="name" label="规则名称" :error-messages="name.trim() ? [] : ['规则名称不能为空']" density="compact" variant="outlined" />
              <v-text-field v-model="hostname" label="Hostname URLPattern" :error-messages="hostname.trim() ? [] : ['Hostname 不能为空']" density="compact" variant="outlined" />
              <v-text-field v-model="pathname" label="Pathname URLPattern" :error-messages="pathname.trim() ? [] : ['Pathname 不能为空']" density="compact" variant="outlined" />
              <div class="number-row">
                <v-text-field v-model.number="priority" type="number" min="-1000" max="1000" label="优先级" density="compact" variant="outlined" />
                <v-text-field v-model.number="timeoutMs" type="number" min="1000" max="60000" step="1000" label="超时毫秒"
                  :error-messages="timeoutValid ? [] : ['请输入 1000 到 60000 之间的整数']" density="compact" variant="outlined" />
              </div>
              <button type="button" class="enable-control" :class="{ active: enabled }" role="switch" :aria-checked="enabled" @click="enabled = !enabled">
                <span class="enable-copy"><i class="mdi mdi-power"></i><span><strong>保存后启用</strong><small>{{ enabled ? "规则保存后立即参与识别" : "规则保存后保持停用" }}</small></span></span>
                <span class="compact-switch" aria-hidden="true"><i></i></span>
              </button>
              <p v-if="editing && !definitionChanged" class="save-hint ready"><i class="mdi mdi-check-circle-outline"></i>仅修改名称、优先级或启用状态时，可以直接更新。</p>
              <p v-else-if="editing && definitionChanged" class="save-hint"><i class="mdi mdi-flask-outline"></i>脚本或执行范围已变化，请运行测试后更新。</p>
            </section>

            <section class="inspector-section">
              <div class="section-heading"><div><i class="mdi mdi-database-arrow-right-outline"></i><strong>投递字段</strong></div><small>点击插入光标位置</small></div>
              <div class="field-buttons">
                <button v-for="field in APPLICATION_FIELDS" :key="field[0]" type="button" @click="insertApplicationField(field[0])"><code>{{ field[0] }}</code><span>{{ field[1] }}</span></button>
              </div>
            </section>

            <section class="inspector-section current-applications">
              <div class="section-heading"><div><i class="mdi mdi-briefcase-outline"></i><strong>当前页面投递</strong></div><small>{{ previewData?.applications.length || 0 }} 个岗位</small></div>
              <p v-if="!previewData" class="empty-hint">加载页面后显示该检查组的投递数据。</p>
              <article v-for="item in previewData?.applications ?? []" :key="item.id"><strong>{{ item.jobTitle }}</strong><span>{{ item.company }} · {{ item.appliedAt || "未填投递时间" }}</span></article>
            </section>
          </div>
          <footer class="inspector-actions">
            <v-btn variant="outlined" prepend-icon="mdi-play" :loading="testing" :disabled="!previewAvailable || !script.trim() || !timeoutValid" @click="emit('test')">运行测试</v-btn>
            <v-btn color="primary" :disabled="!canSave" @click="emit('save')">{{ editing ? "更新规则" : "保存规则" }}</v-btn>
          </footer>
        </aside>
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.script-workspace { width: 100vw; height: 100vh; overflow: hidden; background: #f5f1e8 !important; color: #18352d; }
.workspace-header, .workspace-toolbar, .workspace-title, .workspace-header-actions, .number-row, .section-heading, .section-heading > div, .test-drawer > header, .test-drawer > header > div, .result-list article > div { display: flex; align-items: center; }
.workspace-header { height: 64px; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid #ddd4c5; background: #fffdf9; }
.workspace-title { gap: 11px; min-width: 0; }
.workspace-title > div { display: flex; min-width: 0; flex-direction: column; }
.workspace-title strong { font-size: 16px; line-height: 1.4; }
.workspace-title small { max-width: 520px; overflow: hidden; color: #7a867f; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.script-mark { display: grid; width: 34px; height: 34px; border-radius: 9px; background: #fff0df; color: #b75c20; font-size: 19px; place-items: center; }
.advanced-badge { padding: 3px 8px; border-radius: 999px; background: #fff0df; color: #b65e20; font-size: 10px; }
.workspace-header-actions { gap: 5px; }
.save-state-pill { display: inline-flex; align-items: center; gap: 5px; margin-right: 4px; padding: 5px 9px; border: 1px solid #e3c6aa; border-radius: 999px; background: #fff4e8; color: #a85b29; font-size: 10px; font-weight: 600; white-space: nowrap; }
.save-state-pill.saved { border-color: #bfd6cc; background: #eff7f3; color: #34705b; }
.save-state-pill i { font-size: 13px; }
.workspace-header-actions button { display: inline-flex; align-items: center; gap: 6px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: #356454; font-size: 12px; }
.workspace-header-actions button:hover { background: #edf4f0; }
.workspace-header-actions .close-button { width: 36px; height: 36px; justify-content: center; margin-left: 4px; color: #6e7772; font-size: 19px; }
.workspace-toolbar { min-height: 66px; gap: 10px; padding: 10px 18px; border-bottom: 1px solid #e2dacd; background: #faf7f0; }
.workspace-toolbar .v-autocomplete { max-width: 680px; }
.toolbar-spacer { flex: 1; }
.example-select { display: inline-flex; align-items: center; gap: 8px; color: #6e7a74; font-size: 11px; white-space: nowrap; }
.example-select .v-select { width: 168px; }
.example-select :deep(.v-field) { min-height: 36px; border-radius: 8px; background: #fff; }
.example-select :deep(.v-field__input) { min-height: 36px; padding-top: 5px; padding-bottom: 5px; color: #344b43; font-size: 11px; }
.timeout-chip { display: inline-flex; align-items: center; gap: 5px; padding: 7px 10px; border-radius: 8px; background: #efe9de; color: #746b5f; font-size: 11px; white-space: nowrap; }
.workspace-body { display: grid; grid-template-columns: minmax(0, 1fr) 370px; height: calc(100vh - 130px); min-height: 0; }
.workspace-main { display: flex; min-width: 0; min-height: 0; overflow: hidden; flex-direction: column; background: #14201c; }
.monaco-panel { min-height: 280px; flex: 1 1 auto; overflow: hidden; }
.editor-context { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 42px; padding: 7px 14px; border-top: 1px solid #2b3833; background: #182721; color: #8fa39a; }
.editor-context span { font-size: 11px; }
.editor-context code { color: #e49a56; }
.editor-context small { color: #71857c; font-size: 10px; }
.test-drawer { flex: 0 0 min(31vh, 280px); min-height: 170px; overflow: hidden; border-top: 1px solid #39473f; background: #f9f6ef; color: #233e35; }
.test-drawer.collapsed { flex-basis: 42px; min-height: 42px; }
.test-drawer > header { height: 42px; justify-content: space-between; padding: 0 15px; border-bottom: 1px solid #e0d9cd; }
.test-drawer > header > div { gap: 7px; }
.test-drawer > header i { color: #c56b2f; }
.test-drawer > header span { color: #859088; font-size: 11px; }
.test-drawer-actions { display: flex; align-items: center; gap: 8px; }
.test-drawer-actions button { display: grid; width: 27px; height: 27px; padding: 0; border: 1px solid #ded5c7; border-radius: 7px; background: #fff; color: #6f7d76; place-items: center; }
.test-drawer-actions button:hover { border-color: #d6a67e; background: #fff7ee; color: #a85b29; }
.test-drawer-actions button i { color: inherit; font-size: 18px; }
.test-drawer-content { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, .8fr); height: calc(100% - 42px); min-height: 0; }
.result-list { padding: 10px 12px; overflow: auto; }
.result-list article { margin-bottom: 8px; padding: 9px 10px; border: 1px solid #e0d8cb; border-radius: 8px; background: #fff; }
.result-list article > div { justify-content: space-between; gap: 10px; }
.result-list article strong { font-size: 12px; }
.result-list article b { color: #b75c20; font-size: 11px; }
.result-list article small, .result-list article p { display: block; margin: 3px 0 0; color: #718079; font-size: 10px; line-height: 1.5; }
.script-console { min-width: 0; overflow: hidden; border-left: 1px solid #3b4943; background: #15241e; color: #c9dbd3; }
.script-console > header { display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 11px; border-bottom: 1px solid #34423c; color: #e29a55; font-size: 11px; }
.script-console-lines { height: calc(100% - 36px); padding: 8px 10px; overflow: auto; font: 10px/1.6 Consolas, monospace; }
.script-console-lines p { display: flex; gap: 8px; margin: 0 0 3px; overflow-wrap: anywhere; }
.script-console-lines time { flex: none; color: #719085; }
.console-truncated { color: #e39a67; }
.workspace-inspector { display: flex; min-width: 0; min-height: 0; overflow: hidden; flex-direction: column; border-left: 1px solid #ded5c7; background: #fffdf9; }
.inspector-scroll { min-height: 0; padding: 16px; overflow-y: auto; flex: 1; }
.inspector-section { padding-bottom: 16px; }
.inspector-section + .inspector-section { padding-top: 16px; border-top: 1px solid #ebe5da; }
.section-heading { justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.section-heading > div { gap: 7px; }
.section-heading i { color: #b65e20; }
.section-heading strong { font-size: 13px; }
.section-heading small { color: #8a938e; font-size: 9px; }
.number-row { align-items: flex-start; gap: 8px; }
.number-row > * { min-width: 0; }
.enable-control { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 4px; padding: 9px 11px; border: 1px solid #e1d9cc; border-radius: 9px; background: #faf8f3; color: #58665f; text-align: left; transition: border-color .16s ease, background .16s ease; }
.enable-control:hover { border-color: #d5b18e; background: #fffaf4; }
.enable-control.active { border-color: #e2b78e; background: #fff7ee; }
.enable-copy { display: flex; min-width: 0; align-items: center; gap: 9px; }
.enable-copy > i { display: grid; width: 25px; height: 25px; flex: none; border-radius: 7px; background: #eee9df; color: #7b857f; font-size: 14px; place-items: center; }
.enable-control.active .enable-copy > i { background: #f9e6d3; color: #b65e20; }
.enable-copy > span { display: flex; min-width: 0; flex-direction: column; }
.enable-copy strong { font-size: 11px; font-weight: 600; }
.enable-copy small { margin-top: 1px; color: #8b948f; font-size: 9px; }
.compact-switch { position: relative; width: 31px; height: 17px; flex: none; border-radius: 999px; background: #c9cec9; transition: background .16s ease; }
.compact-switch i { position: absolute; top: 3px; left: 3px; width: 11px; height: 11px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px #35473f3d; transition: transform .16s ease; }
.enable-control.active .compact-switch { background: #d98243; }
.enable-control.active .compact-switch i { transform: translateX(14px); }
.save-hint { display: flex; align-items: flex-start; gap: 6px; margin: 8px 0 0; padding: 8px 9px; border-radius: 7px; background: #fff4e7; color: #9d5a2c; font-size: 10px; line-height: 1.5; }
.save-hint.ready { background: #eef7f2; color: #35705b; }
.field-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.field-buttons button { display: flex; min-width: 0; padding: 8px 9px; border: 1px solid #dfd7ca; border-radius: 8px; background: #fff; text-align: left; flex-direction: column; }
.field-buttons button:hover { border-color: #d1844e; background: #fff8f1; }
.field-buttons code { overflow: hidden; color: #a65320; font-size: 11px; text-overflow: ellipsis; }
.field-buttons span { margin-top: 2px; color: #8a938e; font-size: 9px; }
.current-applications article { display: flex; margin-bottom: 7px; padding: 9px; border-radius: 8px; background: #f5f1e8; flex-direction: column; }
.current-applications article strong { font-size: 11px; }
.current-applications article span, .empty-hint { margin: 3px 0 0; color: #818b85; font-size: 9px; }
.inspector-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; padding: 13px 16px; border-top: 1px solid #e3dbce; background: #faf7f0; }
.error-text { color: #b64e3e !important; }
@media (max-width: 980px) {
  .workspace-body { grid-template-columns: minmax(0, 1fr) 320px; }
  .workspace-toolbar { flex-wrap: wrap; }
  .workspace-toolbar .v-autocomplete { min-width: 420px; }
  .toolbar-spacer { display: none; }
  .test-drawer-content { grid-template-columns: 1fr; }
  .script-console { display: none; }
}
</style>
