<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string]; save: [] }>();

type Monaco = typeof import("monaco-editor/editor/editor.api");
type MonacoEditor = import("monaco-editor").editor.IStandaloneCodeEditor;
type MonacoModel = import("monaco-editor").editor.ITextModel;

const container = ref<HTMLElement | null>(null);
const loading = ref(true);
const loadError = ref("");
let monaco: Monaco | null = null;
let editor: MonacoEditor | null = null;
let model: MonacoModel | null = null;
let suppressChange = false;
let loadAttempt = 0;

async function initialize(): Promise<void> {
  const attempt = ++loadAttempt;
  loading.value = true;
  loadError.value = "";
  disposeEditor();
  try {
    await import("monaco-editor/nls/lang/zh-cn");
    const [editorWorkerModule, jsonWorkerModule] = await Promise.all([
      import("monaco-editor/editor/editor.worker?worker"),
      import("monaco-editor/language/json/json.worker?worker"),
    ]);
    globalThis.MonacoEnvironment = {
      getWorker: (_moduleId: string, label: string) => label === "json"
        ? new jsonWorkerModule.default()
        : new editorWorkerModule.default(),
    };
    const [editorApi] = await Promise.all([
      import("monaco-editor/editor/editor.api"),
      import("monaco-editor/language/json/monaco.contribution"),
      import("monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching"),
      import("monaco-editor/editor/contrib/find/browser/findController"),
      import("monaco-editor/editor/contrib/folding/browser/folding"),
      import("monaco-editor/editor/contrib/format/browser/formatActions"),
      import("monaco-editor/editor/contrib/hover/browser/hoverContribution"),
    ]);
    if (attempt !== loadAttempt) return;
    monaco = editorApi as unknown as Monaco;
    monaco.editor.defineTheme("application-checker-selector", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "string.key.json", foreground: "79D5B1", fontStyle: "bold" },
        { token: "string.value.json", foreground: "B8D98C" },
        { token: "number", foreground: "E6C07B" },
      ],
      colors: {
        "editor.background": "#18231f",
        "editor.foreground": "#d9e8e2",
        "editorLineNumber.foreground": "#60736b",
        "editorLineNumber.activeForeground": "#79d5b1",
        "editorCursor.foreground": "#79d5b1",
        "editor.selectionBackground": "#3d9b7448",
        "editor.inactiveSelectionBackground": "#3d9b742d",
      },
    });
    await nextTick();
    if (!container.value || attempt !== loadAttempt) return;
    model = monaco.editor.createModel(props.modelValue, "json", monaco.Uri.parse(`inmemory://application-checker/selector-rule-${Date.now()}.json`));
    editor = monaco.editor.create(container.value, {
      model,
      theme: "application-checker-selector",
      automaticLayout: true,
      fontFamily: "Cascadia Code, Consolas, ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 22,
      tabSize: 2,
      insertSpaces: true,
      minimap: { enabled: false },
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      folding: true,
      glyphMargin: false,
      scrollBeyondLastLine: false,
      wordWrap: "off",
      formatOnPaste: true,
      padding: { top: 14, bottom: 14 },
    });
    editor.onDidChangeModelContent(() => {
      if (!suppressChange && editor) emit("update:modelValue", editor.getValue());
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit("save"));
    editor.focus();
  } catch (error) {
    if (attempt !== loadAttempt) return;
    loadError.value = error instanceof Error ? error.message : "Monaco Editor 加载失败";
  } finally {
    if (attempt === loadAttempt) loading.value = false;
  }
}

function disposeEditor(): void {
  editor?.dispose();
  model?.dispose();
  editor = null;
  model = null;
}

watch(() => props.modelValue, (value) => {
  if (!editor || editor.getValue() === value) return;
  const position = editor.getPosition();
  suppressChange = true;
  editor.setValue(value);
  if (position) editor.setPosition(position);
  suppressChange = false;
});

onMounted(() => void initialize());
onBeforeUnmount(() => { loadAttempt += 1; disposeEditor(); });
</script>

<template>
  <div class="monaco-json-host">
    <div ref="container" class="monaco-json-container"></div>
    <div v-if="loading" class="monaco-json-state">
      <v-progress-circular indeterminate color="primary" size="30" width="3" />
      <strong>正在加载 Monaco JSON 编辑器</strong>
      <span>编辑器资源仅在打开点选规则自定义编辑时加载。</span>
    </div>
    <div v-else-if="loadError" class="monaco-json-state error">
      <i class="mdi mdi-alert-circle-outline"></i>
      <strong>编辑器加载失败</strong>
      <span>{{ loadError }}</span>
      <v-btn variant="outlined" color="primary" prepend-icon="mdi-refresh" @click="initialize">重新加载</v-btn>
    </div>
  </div>
</template>

<style scoped>
.monaco-json-host { position: relative; width: 100%; height: 100%; min-height: 300px; overflow: hidden; background: #18231f; }
.monaco-json-container { position: absolute; inset: 0; }
.monaco-json-state { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; padding: 28px; background: #18231f; color: #d9e8e2; text-align: center; }
.monaco-json-state span { max-width: 460px; color: #8fa39a; font-size: 11px; line-height: 1.65; }
.monaco-json-state.error i { color: #d86f55; font-size: 34px; }
</style>
