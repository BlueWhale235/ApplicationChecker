<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type {
  AppSettings,
  BrowserStorageUsage,
  RecognitionMode,
} from "@application-checker/contracts";
import { api, type DataTransferSummary } from "../api";

const appVersion = __APP_VERSION__;
const githubUrl = "https://github.com/BlueWhale235/ApplicationChecker";

defineProps<{
  settings: AppSettings;
  form: {
    globalCron: string;
    timezone: string;
    checkConcurrency: 1 | 2 | 3;
    screenshotRetentionDays: number;
    defaultUserAgent: string;
  };
  storage: BrowserStorageUsage | null;
  busy: boolean;
}>();
const emit = defineEmits<{
  save: [];
  configureAi: [];
  configureStatusMappings: [];
  recognitionMode: [value: RecognitionMode];
  refreshStorage: [];
  clearStorage: [kind: "cache" | "temp" | "logs"];
  notice: [message: string];
  failure: [message: string];
  imported: [resumedQueued: number];
}>();

const exportOpen = ref(false);
const exportPassword = ref("");
const exportConfirmation = ref("");
const importOpen = ref(false);
const importFile = ref<File | File[] | null>(null);
const importPassword = ref("");
const importSessionId = ref<string | null>(null);
const importSummary = ref<DataTransferSummary | null>(null);
const replaceConfirmed = ref(false);
const transferBusy = ref(false);
const importProgress = ref(0);
const importStatus = ref("");
const passwordVisible = ref(false);
const tableLabels: Record<string, string> = {
  applications: "岗位", runs: "运行记录", check_groups: "检查组", run_application_results: "识别结果",
  status_events: "状态事件", notifications: "通知", browser_profiles: "浏览器状态",
  login_sessions: "登录记录", app_settings: "设置", parser_rules: "解析规则",
};
const sourceTotal = computed(() => Object.entries(importSummary.value?.counts ?? {})
  .filter(([key]) => key !== "app_settings").reduce((sum, [, count]) => sum + count, 0));
const selectedImportFile = computed(() => Array.isArray(importFile.value) ? importFile.value[0] ?? null : importFile.value);

function resetExport() {
  exportOpen.value = false;
  exportPassword.value = "";
  exportConfirmation.value = "";
  passwordVisible.value = false;
}

async function exportData() {
  if (exportPassword.value.length < 8) return emit("failure", "迁移密码至少需要 8 个字符");
  if (exportPassword.value !== exportConfirmation.value) return emit("failure", "两次输入的迁移密码不一致");
  transferBusy.value = true;
  try {
    await api.exportAllData(exportPassword.value, exportConfirmation.value);
    resetExport();
    emit("notice", "全量加密备份已导出");
  } catch (error) { emit("failure", error instanceof Error ? error.message : "导出失败"); }
  finally { transferBusy.value = false; }
}

async function inspectImport() {
  const file = selectedImportFile.value;
  if (!file) return emit("failure", "请选择 .acbackup 备份文件");
  if (!file.name.toLowerCase().endsWith(".acbackup")) return emit("failure", "请选择 .acbackup 备份文件");
  if (!importPassword.value) return emit("failure", "请输入迁移密码");
  transferBusy.value = true;
  importProgress.value = 0;
  importStatus.value = "正在检查备份…";
  try {
    const result = await api.inspectDataBackup(file, importPassword.value, (progress) => {
      importProgress.value = progress.percent;
      importStatus.value = progress.message;
    });
    importSessionId.value = result.id;
    importSummary.value = result.summary;
    importPassword.value = "";
  } catch (error) { emit("failure", error instanceof Error ? error.message : "备份校验失败"); }
  finally { transferBusy.value = false; }
}

async function closeImport() {
  if (importSessionId.value) await api.cancelDataBackup(importSessionId.value).catch(() => {});
  importOpen.value = false;
  importFile.value = null;
  importPassword.value = "";
  importSessionId.value = null;
  importSummary.value = null;
  replaceConfirmed.value = false;
  importProgress.value = 0;
  importStatus.value = "";
  passwordVisible.value = false;
}

async function applyImport() {
  if (!importSessionId.value || !replaceConfirmed.value) return;
  transferBusy.value = true;
  try {
    const result = await api.applyDataBackup(importSessionId.value);
    importSessionId.value = null;
    importOpen.value = false;
    importSummary.value = null;
    importFile.value = null;
    replaceConfirmed.value = false;
    emit("imported", result.resumedQueued);
  } catch (error) { emit("failure", error instanceof Error ? error.message : "导入失败"); }
  finally { transferBusy.value = false; }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatLogBytes(bytes: number): string {
  const kilobytes = bytes / 1024;
  if (kilobytes <= 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

onMounted(() => emit("refreshStorage"));

const recognitionModes: Array<{ title: string; value: RecognitionMode }> = [
  { title: "本地优先（推荐）", value: "local_first" },
  { title: "仅本地解析", value: "local_only" },
  { title: "仅 AI 识别", value: "ai_only" },
];
const concurrencyOptions = [
  { title: "1 路（默认，资源占用最低）", value: 1 },
  { title: "2 路（推荐）", value: 2 },
  { title: "3 路（速度优先）", value: 3 },
];
</script>

<template>
  <section class="page-content narrow-page">
    <div class="page-heading"><div><h1>设置</h1><p>配置自动检查时间、本地解析策略和可选的 AI 回退。本地优先模式下，北森/Moka 仅本地解析，未匹配时保留原状态；其他网站可回退 AI。</p></div></div>
    <div class="settings-grid">
      <v-form class="content-card" @submit.prevent="$emit('save')">
        <div class="card-title"><div><h2>自动检查</h2><p>岗位选择“继承全局计划”时使用此处设置。</p></div><i class="mdi mdi-calendar-clock"></i></div>
        <v-text-field v-model="form.globalCron" label="全局 Cron" variant="outlined" density="comfortable" placeholder="留空则关闭，例如：0 9 * * *" hint="使用标准五段 Cron，不包含秒。" persistent-hint />
        <v-text-field v-model="form.timezone" label="时区" variant="outlined" density="comfortable" placeholder="Asia/Shanghai" />
        <v-select v-model="form.checkConcurrency" :items="concurrencyOptions" label="同时检查任务数" variant="outlined" density="comfortable" hint="修改后立即生效；已运行的检查不会被中断。" persistent-hint />
        <v-text-field v-model.number="form.screenshotRetentionDays" label="截图保留天数" type="number" min="1" max="3650" variant="outlined" density="comfortable" hint="到期后只删除截图，任务历史和识别结果不会删除。" persistent-hint />
        <v-textarea v-model="form.defaultUserAgent" label="默认 User-Agent" rows="3" maxlength="512" variant="outlined" density="comfortable" hint="截图和 VNC 登录浏览器都会使用此 User-Agent。" persistent-hint />
        <v-btn class="settings-save" color="secondary" variant="flat" type="submit" :loading="busy">保存设置</v-btn>
      </v-form>
      <div class="content-card">
        <div class="card-title"><div><h2>识别策略</h2><p>决定本地 DOM 解析器与 AI 的调用顺序。</p></div><i class="mdi mdi-source-branch"></i></div>
        <v-select
          :model-value="settings.recognitionMode"
          :items="recognitionModes"
          label="识别模式"
          variant="outlined"
          density="comfortable"
          hide-details
          @update:model-value="$emit('recognitionMode', $event)"
        />
        <p class="settings-help">
          本地优先会直接采用置信度不低于 90% 的本地结果，只把未匹配岗位交给 AI；仅本地模式不会产生 AI 请求。
        </p>
      </div>
      <div class="content-card">
        <div class="card-title"><div><h2>AI识别</h2><p>本地解析无法可靠判断时，可调用兼容的视觉模型。</p></div><i class="mdi mdi-auto-fix"></i></div>
        <div class="service-state" :class="{ ok: settings.aiConfigured }">
          <i :class="settings.aiConfigured ? 'mdi mdi-check-circle' : 'mdi mdi-minus-circle-outline'"></i>
          <div><strong>{{ settings.aiConfigured ? "已配置" : "未配置" }}</strong><span>{{ settings.aiModel || "核心检查功能不受影响" }}</span></div>
        </div>
        <p class="settings-help">{{ settings.aiBaseUrl || "尚未设置模型服务地址" }}。人工设置过的进度不会被 AI 覆盖。</p>
        <v-btn variant="outlined" color="primary" prepend-icon="mdi-tune-variant" @click="$emit('configureAi')">配置 AI 模型</v-btn>
      </div>
      <div class="content-card">
        <div class="card-title"><div><h2>浏览器 Runner</h2><p>负责截图和远程登录。</p></div><i class="mdi mdi-google-chrome"></i></div>
        <div class="service-state" :class="{ ok: settings.runnerHealthy }">
          <i :class="settings.runnerHealthy ? 'mdi mdi-check-circle' : 'mdi mdi-alert-circle-outline'"></i>
          <div><strong>{{ settings.runnerHealthy ? "运行正常" : "未连接" }}</strong><span>{{ settings.runnerHealthy ? "可以执行截图任务" : "请检查 Runner 容器" }}</span></div>
        </div>
      </div>
      <div class="content-card mapping-card">
        <div class="card-title">
          <div><h2>状态映射</h2><p>补充招聘网站或 HR 使用的特殊中英文状态词条。</p></div>
          <i class="mdi mdi-tag-multiple-outline"></i>
        </div>
        <div class="mapping-summary">
          <i class="mdi mdi-shape-outline"></i>
          <div>
            <strong>{{ Object.values(settings.statusMappings).reduce((total, terms) => total + terms.length, 0) }} 条状态关键词</strong>
            <span>包含内置和自定义词条；目前仅支持部分网站，按页面关键词匹配。</span>
          </div>
        </div>
        <v-btn variant="outlined" color="primary" prepend-icon="mdi-tune-variant" @click="$emit('configureStatusMappings')">
          配置状态映射
        </v-btn>
      </div>
      <div class="content-card browser-storage-card">
        <div class="card-title">
          <div><h2>存储与日志</h2><p>查看浏览器缓存、临时文件与故障日志占用空间。</p></div>
          <i class="mdi mdi-database-cog-outline"></i>
        </div>
        <div class="storage-items">
          <div>
            <i class="mdi mdi-cached"></i>
            <span><strong>网页资源缓存</strong><small>JS、CSS、字体和图片等，最多约 512 MB</small></span>
            <b>{{ storage ? formatBytes(storage.cacheBytes) : "计算中…" }}</b>
            <v-btn size="small" variant="outlined" :disabled="!storage" :loading="busy" @click="$emit('clearStorage', 'cache')">清除缓存</v-btn>
          </div>
          <div>
            <i class="mdi mdi-folder-clock-outline"></i>
            <span><strong>临时文件</strong><small>旧版或异常退出后遗留的 Edge 临时文件</small></span>
            <b>{{ storage ? formatBytes(storage.tempBytes) : "计算中…" }}</b>
            <v-btn size="small" variant="outlined" color="error" :disabled="!storage" :loading="busy" @click="$emit('clearStorage', 'temp')">清理临时文件</v-btn>
          </div>
          <div class="logs-storage-item">
            <i class="mdi mdi-text-box-remove-outline"></i>
            <span><strong>运行日志</strong><small>仅记录警告和错误，用于排查异常</small></span>
            <b>{{ storage ? formatLogBytes(storage.logBytes) : "计算中…" }}</b>
            <v-btn size="small" variant="outlined" color="error" :disabled="!storage" :loading="busy" @click="$emit('clearStorage', 'logs')">清除日志</v-btn>
          </div>
        </div>
        <p class="settings-help">缓存和临时文件在检查、登录或加载规则预览时不能清理；运行日志可随时清除。</p>
      </div>
      <div class="content-card data-transfer-card">
        <div class="card-title">
          <div><h2>数据迁移</h2><p>在桌面端和 Docker Web 端之间迁移全部业务数据。</p></div>
          <i class="mdi mdi-database-export-outline"></i>
        </div>
        <div class="transfer-actions">
          <div><strong>全量加密备份</strong><span>包含岗位、运行记录、设置、规则、截图、登录状态和 AI Key；不迁移环境加密 Key。</span></div>
          <v-btn variant="outlined" color="primary" prepend-icon="mdi-export" @click="exportOpen = true">导出全部数据</v-btn>
          <v-btn variant="outlined" color="secondary" prepend-icon="mdi-import" @click="importOpen = true">导入备份</v-btn>
        </div>
        <p class="settings-help">迁移密码不会保存。Docker 会使用自己的 STATE_ENCRYPTION_KEY 重新加密敏感数据。</p>
      </div>
      <div class="content-card project-card">
        <div>
          <span class="project-kicker">关于职迹</span>
          <strong>Application Checker</strong>
          <small>本地优先的求职申请管理与状态检查工具</small>
        </div>
        <a :href="githubUrl" target="_blank" rel="noreferrer" aria-label="在 GitHub 查看 Application Checker 仓库">
          <i class="mdi mdi-github"></i>
          <span>BlueWhale235/ApplicationChecker</span>
          <b>{{ appVersion }}</b>
          <i class="mdi mdi-open-in-new"></i>
        </a>
      </div>
    </div>

    <v-dialog v-model="exportOpen" max-width="500" persistent>
      <v-card class="transfer-dialog">
        <v-card-title>导出全部数据</v-card-title>
        <v-card-text>
          <v-alert type="warning" variant="tonal" density="compact" class="mb-4">备份包含浏览器登录状态和 AI API Key，请设置独立的强密码并妥善保管。</v-alert>
          <v-text-field v-model="exportPassword" label="迁移密码" :type="passwordVisible ? 'text' : 'password'" minlength="8" variant="outlined" :append-inner-icon="passwordVisible ? 'mdi-eye-off' : 'mdi-eye'" @click:append-inner="passwordVisible = !passwordVisible" />
          <v-text-field v-model="exportConfirmation" label="再次输入迁移密码" :type="passwordVisible ? 'text' : 'password'" variant="outlined" hide-details />
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="transferBusy" @click="resetExport">取消</v-btn><v-btn color="primary" variant="flat" :loading="transferBusy" @click="exportData">导出备份</v-btn></v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="importOpen" max-width="650" persistent>
      <v-card class="transfer-dialog">
        <v-card-title>{{ importSummary ? "确认覆盖数据" : "导入加密备份" }}</v-card-title>
        <v-card-text v-if="!importSummary">
          <v-alert type="info" variant="tonal" density="compact" class="mb-4">浏览器会先在本地读取文件头并检查密码，密码正确后才开始分片上传。校验阶段不会修改当前数据。</v-alert>
          <v-file-input v-model="importFile" accept=".acbackup" label="选择 .acbackup 文件" variant="outlined" prepend-icon="mdi-database-import-outline" />
          <v-text-field v-model="importPassword" label="迁移密码" :type="passwordVisible ? 'text' : 'password'" variant="outlined" hide-details :append-inner-icon="passwordVisible ? 'mdi-eye-off' : 'mdi-eye'" @click:append-inner="passwordVisible = !passwordVisible" />
          <div v-if="transferBusy && importStatus" class="transfer-progress">
            <v-progress-linear :model-value="importProgress" color="primary" rounded />
            <span>{{ importStatus }}</span>
          </div>
        </v-card-text>
        <v-card-text v-else>
          <v-alert type="error" variant="tonal" class="mb-4">导入会永久覆盖当前岗位、记录、设置、规则和截图，且不会自动备份旧数据。</v-alert>
          <div class="transfer-summary">
            <div><span>备份版本</span><strong>{{ importSummary.appVersion }}</strong></div>
            <div><span>导出时间</span><strong>{{ new Date(importSummary.exportedAt).toLocaleString() }}</strong></div>
            <div><span>数据记录</span><strong>{{ sourceTotal }} 条</strong></div>
            <div><span>截图</span><strong>{{ importSummary.screenshotCount }} 张 · {{ formatBytes(importSummary.screenshotBytes) }}</strong></div>
            <div><span>敏感数据</span><strong>{{ importSummary.sensitiveData.join("、") || "无" }}</strong></div>
            <div><span>加密转换</span><strong>{{ importSummary.keyChanged ? "将使用目标端 Key 重新加密" : "来源与目标 Key 标识相同" }}</strong></div>
          </div>
          <details class="transfer-details"><summary>查看各类数据数量</summary><div><span v-for="(count, key) in importSummary.counts" :key="key">{{ tableLabels[key] || key }}：{{ count }}</span></div></details>
          <v-checkbox v-model="replaceConfirmed" color="error" hide-details label="我了解当前数据将被永久覆盖，且没有自动备份" />
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="transferBusy" @click="closeImport">取消</v-btn><v-btn v-if="!importSummary" color="primary" variant="flat" :loading="transferBusy" @click="inspectImport">校验备份</v-btn><v-btn v-else color="error" variant="flat" :disabled="!replaceConfirmed" :loading="transferBusy" @click="applyImport">覆盖并导入</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.narrow-page { max-width: 1050px; }
.settings-grid { display: grid; grid-template-columns: 1.2fr .8fr; gap: 17px; }
.content-card { padding: 27px; border: 1px solid var(--border); border-radius: 12px; background: #fffdf8; box-shadow: 0 10px 32px #183a3708; }
.settings-grid .content-card:first-child { grid-row: span 2; }
.card-title { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 23px; }
.card-title h2 { margin: 0; font: 600 19px "Noto Serif SC", serif; color: #25352f; }
.card-title p { margin: 6px 0 0; color: #7a837f; font-size: 11px; }
.card-title > i { color: #a9734e; font-size: 25px; }
.settings-save { margin-top: 24px; }
.settings-grid :deep(.v-input + .v-input) { margin-top: 5px; }
.service-state { padding: 14px; display: flex; gap: 12px; align-items: center; border-radius: 9px; color: #a3603d; background: #f8eee4; }
.service-state.ok { color: #347153; background: #eaf3ed; }
.service-state > i { font-size: 24px; }
.service-state strong, .service-state span { display: block; }
.service-state strong { font-size: 12px; }
.service-state span { margin-top: 3px; font-size: 10px; opacity: .75; }
.settings-help { color: #7d8782; font-size: 10px; line-height: 1.8; }
.mapping-summary { margin-bottom: 18px; padding: 14px; display: flex; gap: 12px; align-items: center; border-radius: 9px; color: #426a5b; background: #edf4ef; }
.mapping-summary > i { font-size: 24px; }
.mapping-summary strong, .mapping-summary span { display: block; }
.mapping-summary strong { font-size: 12px; }
.mapping-summary span { margin-top: 3px; color: #718078; font-size: 10px; line-height: 1.5; }
.browser-storage-card { grid-column: 1 / -1; }
.data-transfer-card { grid-column: 1 / -1; }
.transfer-actions { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; }
.transfer-actions strong, .transfer-actions span { display: block; }
.transfer-actions strong { color: #30453d; font-size: 12px; }
.transfer-actions span { margin-top: 4px; color: #7a837f; font-size: 10px; line-height: 1.6; }
.transfer-dialog { padding: 4px; }
.transfer-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.transfer-summary > div { padding: 12px; border: 1px solid #e4ded3; border-radius: 8px; background: #fbf8f1; }
.transfer-summary span, .transfer-summary strong { display: block; }
.transfer-summary span { color: #7a837f; font-size: 9px; }
.transfer-summary strong { margin-top: 4px; color: #30453d; font-size: 11px; }
.transfer-details { margin-top: 15px; color: #596a63; font-size: 10px; }
.transfer-details div { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px 14px; }
.transfer-progress { margin-top: 18px; }
.transfer-progress span { display: block; margin-top: 7px; color: #66756e; font-size: 10px; }
.storage-items { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.storage-items > div { display: grid; grid-template-columns: auto 1fr auto auto; gap: 11px; align-items: center; padding: 14px; border: 1px solid #e4ded3; border-radius: 9px; background: #fbf8f1; }
.storage-items .logs-storage-item { grid-column: 1 / -1; }
.storage-items > div > i { color: #477363; font-size: 24px; }
.storage-items span { min-width: 0; }
.storage-items strong, .storage-items small { display: block; }
.storage-items strong { color: #30453d; font-size: 12px; }
.storage-items small { margin-top: 3px; color: #7a837f; font-size: 9px; }
.storage-items b { color: #50645c; font-size: 11px; white-space: nowrap; }
.project-card { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 22px; padding-top: 21px; padding-bottom: 21px; }
.project-card > div { min-width: 0; }
.project-card > div strong, .project-card > div small { display: block; }
.project-card > div strong { margin-top: 4px; color: #25352f; font: 600 16px "Noto Serif SC", serif; }
.project-card > div small { margin-top: 5px; color: #7a837f; font-size: 10px; }
.project-kicker { color: #b75b2f; font-size: 9px; font-weight: 700; letter-spacing: .12em; }
.project-card a { min-width: 0; display: flex; align-items: center; gap: 9px; padding: 10px 12px; border: 1px solid #d9d3c8; border-radius: 9px; color: #31564b; text-decoration: none; background: #fbf8f1; transition: border-color .16s ease, background .16s ease, transform .16s ease; }
.project-card a:hover, .project-card a:focus-visible { border-color: #9eb4aa; background: #f3f7f3; transform: translateY(-1px); outline: none; }
.project-card a .mdi-github { flex: none; font-size: 24px; }
.project-card a span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 600; }
.project-card a b { flex: none; padding: 3px 7px; border-radius: 999px; background: #e4eee8; color: #3d6a59; font-size: 9px; }
.project-card a .mdi-open-in-new { flex: none; color: #89958f; font-size: 14px; }
@media (max-width: 850px) {
  .settings-grid { grid-template-columns: 1fr; }
  .settings-grid .content-card:first-child { grid-row: auto; }
  .browser-storage-card { grid-column: auto; }
  .data-transfer-card { grid-column: auto; }
  .transfer-actions { grid-template-columns: 1fr; }
  .transfer-summary { grid-template-columns: 1fr; }
  .storage-items { grid-template-columns: 1fr; }
  .storage-items > div { grid-template-columns: auto 1fr auto; }
  .storage-items > div .v-btn { grid-column: 1 / -1; }
  .project-card { grid-column: auto; align-items: stretch; flex-direction: column; }
  .project-card a { width: 100%; }
}
</style>
