<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { SCRIPT_EDITOR_EXTRA_LIB } from "./monaco-script-types";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  save: [];
}>();

type Monaco = typeof import("monaco-editor/editor/editor.api");
type TypeScriptApi = typeof import("monaco-editor/languages/features/typescript/register");
type MonacoEditor = import("monaco-editor").editor.IStandaloneCodeEditor;
type MonacoModel = import("monaco-editor").editor.ITextModel;
type Disposable = import("monaco-editor").IDisposable;
type DecorationsCollection = import("monaco-editor").editor.IEditorDecorationsCollection;

const container = ref<HTMLElement | null>(null);
const loading = ref(true);
const loadError = ref("");
let monaco: Monaco | null = null;
let editor: MonacoEditor | null = null;
let model: MonacoModel | null = null;
let extraLib: Disposable | null = null;
let apiHighlights: DecorationsCollection | null = null;
let suppressChange = false;
let loadAttempt = 0;

async function initialize(): Promise<void> {
  const attempt = ++loadAttempt;
  loading.value = true;
  loadError.value = "";
  disposeEditor();
  try {
    await import("monaco-editor/nls/lang/zh-cn");
    const [editorWorkerModule, typeScriptWorkerModule] = await Promise.all([
      import("monaco-editor/editor/editor.worker?worker"),
      import("monaco-editor/language/typescript/ts.worker?worker"),
    ]);
    globalThis.MonacoEnvironment = {
      getWorker: (_moduleId: string, label: string) => label === "javascript" || label === "typescript"
        ? new typeScriptWorkerModule.default()
        : new editorWorkerModule.default(),
    };
    const [editorApi, typescript, _language, ..._contributions] = await Promise.all([
      import("monaco-editor/editor/editor.api"),
      import("monaco-editor/languages/features/typescript/register"),
      import("monaco-editor/languages/definitions/javascript/register"),
      import("monaco-editor/editor/contrib/codelens/browser/codeLensCache"),
      import("monaco-editor/editor/common/services/treeViewsDndService"),
      import("monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching"),
      import("monaco-editor/editor/contrib/comment/browser/comment"),
      import("monaco-editor/editor/contrib/find/browser/findController"),
      import("monaco-editor/editor/contrib/folding/browser/folding"),
      import("monaco-editor/editor/contrib/format/browser/formatActions"),
      import("monaco-editor/editor/contrib/hover/browser/hoverContribution"),
      import("monaco-editor/editor/contrib/snippet/browser/snippetController2"),
      import("monaco-editor/editor/contrib/suggest/browser/suggestController"),
      import("monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess"),
      import("monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess"),
    ]);
    if (attempt !== loadAttempt) return;
    monaco = editorApi as unknown as Monaco;
    configureLanguage(monaco, typescript);
    await nextTick();
    if (!container.value || attempt !== loadAttempt) return;
    model = monaco.editor.createModel(props.modelValue, "javascript", monaco.Uri.parse(`inmemory://application-checker/script-rule-${Date.now()}.js`));
    editor = monaco.editor.create(container.value, {
      model,
      theme: "application-checker-script",
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
      stickyScroll: { enabled: true },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      wordWrap: "off",
      formatOnPaste: true,
      formatOnType: true,
      padding: { top: 14, bottom: 14 },
      renderWhitespace: "selection",
      quickSuggestions: { other: true, comments: false, strings: false },
      suggest: { showWords: true, preview: true },
      hover: { above: false, delay: 250, sticky: true },
    });
    editor.onDidChangeModelContent(() => {
      refreshApiHighlights();
      if (!suppressChange && editor) emit("update:modelValue", editor.getValue());
    });
    apiHighlights = editor.createDecorationsCollection();
    refreshApiHighlights();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit("save"));
    editor.focus();
  } catch (error) {
    if (attempt !== loadAttempt) return;
    loadError.value = error instanceof Error ? error.message : "Monaco Editor 加载失败";
  } finally {
    if (attempt === loadAttempt) loading.value = false;
  }
}

function configureLanguage(api: Monaco, typescript: TypeScriptApi): void {
  api.editor.defineTheme("application-checker-script", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "F6A65F", fontStyle: "bold" },
      { token: "string", foreground: "B8D98C" },
      { token: "comment", foreground: "7D938A", fontStyle: "italic" },
      { token: "number", foreground: "E6C07B" },
      { token: "identifier", foreground: "D9E8E2" },
    ],
    colors: {
      "editor.background": "#14201c",
      "editor.foreground": "#d9e8e2",
      "editorLineNumber.foreground": "#60736b",
      "editorLineNumber.activeForeground": "#e8a15d",
      "editorCursor.foreground": "#f6a65f",
      "editor.selectionBackground": "#d9793648",
      "editor.inactiveSelectionBackground": "#d979362d",
      "editorIndentGuide.background1": "#2a3933",
      "editorIndentGuide.activeBackground1": "#6e4930",
    },
  });
  typescript.javascriptDefaults.setCompilerOptions({
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: true,
    locale: "zh-cn",
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.ESNext,
    moduleResolution: typescript.ModuleResolutionKind.NodeJs,
  });
  typescript.javascriptDefaults.setDiagnosticsOptions({
    noSyntaxValidation: false,
    noSemanticValidation: true,
  });
  extraLib?.dispose();
  extraLib = typescript.javascriptDefaults.addExtraLib(
    SCRIPT_EDITOR_EXTRA_LIB,
    "inmemory://application-checker/script-rule-api.d.ts",
  );
}

function disposeEditor(): void {
  apiHighlights?.clear();
  editor?.dispose();
  model?.dispose();
  extraLib?.dispose();
  editor = null;
  model = null;
  extraLib = null;
  apiHighlights = null;
}

function refreshApiHighlights(): void {
  if (!model || !apiHighlights) return;
  const matches = model.findMatches("\\b(?:helpers|applications?)\\b", false, true, true, null, false);
  apiHighlights.set(matches.map((match) => ({
    range: match.range,
    options: { inlineClassName: "script-api-symbol" },
  })));
}

function insertText(text: string): void {
  if (!editor || !monaco) {
    emit("update:modelValue", `${props.modelValue}${text}`);
    return;
  }
  const selection = editor.getSelection();
  if (!selection) return;
  editor.executeEdits("application-field", [{ range: selection, text, forceMoveMarkers: true }]);
  editor.focus();
}

function focus(): void {
  editor?.focus();
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
onBeforeUnmount(() => {
  loadAttempt += 1;
  disposeEditor();
});

defineExpose({ insertText, focus, retry: initialize });
</script>

<template>
  <div class="monaco-host">
    <div ref="container" class="monaco-container"></div>
    <div v-if="loading" class="monaco-state">
      <v-progress-circular indeterminate color="orange-darken-1" size="30" width="3" />
      <strong>正在加载 Monaco Editor</strong>
      <span>首次打开会加载本地编辑器与 JavaScript 语言服务。</span>
    </div>
    <div v-else-if="loadError" class="monaco-state error">
      <i class="mdi mdi-alert-circle-outline"></i>
      <strong>编辑器加载失败</strong>
      <span>{{ loadError }}</span>
      <v-btn variant="outlined" color="orange-darken-2" prepend-icon="mdi-refresh" @click="initialize">重新加载</v-btn>
    </div>
  </div>
</template>

<style scoped>
.monaco-host { position: relative; width: 100%; height: 100%; min-height: 300px; overflow: hidden; background: #14201c; }
.monaco-container { position: absolute; inset: 0; }
.monaco-state { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; padding: 28px; background: #14201c; color: #d9e8e2; text-align: center; }
.monaco-state strong { font-size: 14px; }
.monaco-state span { max-width: 480px; color: #8fa39a; font-size: 11px; line-height: 1.65; }
.monaco-state.error i { color: #e88954; font-size: 34px; }
.monaco-host :deep(.script-api-symbol) { color: #79d5e8 !important; font-weight: 700; text-shadow: 0 0 10px #43bad129; }
</style>
