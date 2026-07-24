<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import type { AiSettingsUpdate, AppSettings } from "@application-checker/contracts";

const props = defineProps<{ open: boolean; settings: AppSettings; busy: boolean }>();
const emit = defineEmits<{ close: []; save: [value: AiSettingsUpdate] }>();
const valid = ref(false);
const form = reactive({
  baseUrl: "",
  model: "",
  apiKey: "",
  confidenceThreshold: 0.75,
  clearApiKey: false,
});

watch(() => props.open, (open) => {
  if (!open) return;
  form.baseUrl = props.settings.aiBaseUrl ?? "";
  form.model = props.settings.aiModel ?? "";
  form.apiKey = "";
  form.confidenceThreshold = props.settings.aiConfidenceThreshold;
  form.clearApiKey = false;
});

function submit() {
  const value: AiSettingsUpdate = {
    baseUrl: form.baseUrl.trim() || null,
    model: form.model.trim() || null,
    confidenceThreshold: Number(form.confidenceThreshold),
    ...(form.clearApiKey ? { apiKey: null } : form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
  };
  emit("save", value);
}
</script>

<template>
  <v-dialog :model-value="open" max-width="620" persistent @update:model-value="!$event && $emit('close')">
    <v-card class="ai-settings-dialog" rounded="lg">
      <v-card-title>
        <div><span>AI 状态识别</span><h2>配置视觉模型</h2></div>
        <v-btn icon="mdi-close" variant="text" aria-label="关闭" @click="$emit('close')" />
      </v-card-title>
      <v-card-text>
        <v-form v-model="valid" @submit.prevent="submit">
          <v-text-field
            v-model="form.baseUrl"
            label="OpenAI-compatible 地址"
            placeholder="https://api.example.com/v1"
            variant="outlined"
            density="comfortable"
            clearable
          />
          <v-text-field
            v-model="form.model"
            label="视觉模型"
            placeholder="例如 gpt-4.1-mini"
            variant="outlined"
            density="comfortable"
            clearable
          />
          <v-text-field
            v-model="form.apiKey"
            label="API Key"
            :placeholder="settings.aiApiKeySet ? '已保存；留空则保持不变' : '请输入 API Key'"
            type="password"
            autocomplete="new-password"
            variant="outlined"
            density="comfortable"
          />
          <v-switch
            v-if="settings.aiApiKeySet"
            v-model="form.clearApiKey"
            color="error"
            density="compact"
            label="清除已保存的 API Key"
            hide-details
          />
          <v-slider
            v-model="form.confidenceThreshold"
            label="自动更新置信度阈值"
            :min="0"
            :max="1"
            :step="0.05"
            thumb-label
            color="primary"
          />
          <p class="ai-storage-note"><v-icon icon="mdi-shield-lock-outline" /> API Key 使用 AES-256-GCM 加密，并同步到本地运行时配置文件。</p>
        </v-form>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="$emit('close')">取消</v-btn>
        <v-btn color="primary" variant="flat" :loading="busy" @click="submit">保存 AI 配置</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.ai-settings-dialog { background: #fffdf8 !important; }
.ai-settings-dialog > .v-card-title { display: flex; align-items: flex-start; justify-content: space-between; padding: 24px 28px 14px; }
.ai-settings-dialog > .v-card-title span { color: #c16638; font-size: 10px; font-weight: 700; letter-spacing: .16em; }
.ai-settings-dialog > .v-card-title h2 { margin: 5px 0 0; font: 700 24px "Noto Serif SC", serif; color: var(--forest); }
.ai-settings-dialog .v-card-text { padding: 14px 28px 4px; }
.ai-settings-dialog .v-card-actions { padding: 14px 24px 20px; border-top: 1px solid #ece5d9; }
.ai-storage-note { display: flex; align-items: center; gap: 7px; margin: 4px 0 10px; color: #74817b; font-size: 10px; }
</style>
