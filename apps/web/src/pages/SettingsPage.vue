<script setup lang="ts">
import { onMounted } from "vue";
import type {
  AppSettings,
  BrowserStorageUsage,
  RecognitionMode,
} from "@application-checker/contracts";

const appVersion = __APP_VERSION__;
const githubUrl = "https://github.com/BlueWhale235/ApplicationChecker";

defineProps<{
  settings: AppSettings;
  form: {
    globalCron: string;
    timezone: string;
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
}>();

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
</script>

<template>
  <section class="page-content narrow-page">
    <div class="page-heading"><div><h1>设置</h1><p>配置自动检查时间、本地解析策略和可选的 AI 回退。</p></div></div>
    <div class="settings-grid">
      <v-form class="content-card" @submit.prevent="$emit('save')">
        <div class="card-title"><div><h2>自动检查</h2><p>岗位选择“继承全局计划”时使用此处设置。</p></div><i class="mdi mdi-calendar-clock"></i></div>
        <v-text-field v-model="form.globalCron" label="全局 Cron" variant="outlined" density="comfortable" placeholder="留空则关闭，例如：0 9 * * *" hint="使用标准五段 Cron，不包含秒。" persistent-hint />
        <v-text-field v-model="form.timezone" label="时区" variant="outlined" density="comfortable" placeholder="Asia/Shanghai" />
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
        <div class="card-title"><div><h2>AI 回退识别</h2><p>本地解析无法可靠判断时，可调用兼容的视觉模型。</p></div><i class="mdi mdi-auto-fix"></i></div>
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
  .storage-items { grid-template-columns: 1fr; }
  .storage-items > div { grid-template-columns: auto 1fr auto; }
  .storage-items > div .v-btn { grid-column: 1 / -1; }
  .project-card { grid-column: auto; align-items: stretch; flex-direction: column; }
  .project-card a { width: 100%; }
}
</style>
