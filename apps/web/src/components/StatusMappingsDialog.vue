<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type {
  StatusMappingKey,
  StatusMappings,
} from "@application-checker/contracts";

const props = defineProps<{
  open: boolean;
  mappings: StatusMappings;
  builtinMappings: StatusMappings;
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  save: [value: StatusMappings];
}>();

const activeCategory = ref<StatusMappingKey>("screening");
const text = reactive<Record<StatusMappingKey, string>>({
  screening: "",
  screening_passed: "",
  interview_pending: "",
  interviewed: "",
  signing_pending: "",
  offer: "",
  rejected: "",
});

const categories: Array<{
  value: StatusMappingKey;
  title: string;
  hint: string;
}> = [
  { value: "screening", title: "初筛", hint: "例如：HR Review、Awaiting Review" },
  { value: "screening_passed", title: "已过初筛", hint: "例如：Technical Assessment、Shortlisted" },
  { value: "interview_pending", title: "待面试", hint: "例如：Phone Interview、Interview Scheduled" },
  { value: "interviewed", title: "已面试", hint: "例如：Interview Completed、Final Interview Done" },
  { value: "signing_pending", title: "待签约", hint: "例如：Offer Approval、Pre-employment" },
  { value: "offer", title: "已收 OFFER", hint: "例如：Offer Extended、Hired" },
  { value: "rejected", title: "淘汰", hint: "例如：Position Closed、Not Moving Forward" },
];

watch(() => props.open, (open) => {
  if (!open) return;
  for (const category of categories) {
    text[category.value] = props.mappings[category.value].join("\n");
  }
}, { immediate: true });

const activeDefinition = computed(() => categories.find((category) => category.value === activeCategory.value)!);
const activeTermCount = computed(() => termsFromText(text[activeCategory.value]).length);

function termsFromText(value: string): string[] {
  return value.split(/\r?\n/).map((term) => term.trim()).filter(Boolean);
}

function submit() {
  emit("save", Object.fromEntries(categories.map(({ value }) => [
    value,
    termsFromText(text[value]),
  ])) as StatusMappings);
}

function restoreBuiltins() {
  for (const category of categories) {
    text[category.value] = props.builtinMappings[category.value].join("\n");
  }
}
</script>

<template>
  <v-dialog :model-value="open" max-width="880" scrollable persistent @update:model-value="!$event && $emit('close')">
    <v-card class="mapping-dialog" rounded="lg">
      <v-card-title>
        <div><span>RECOGNITION RULES</span><h2>状态映射</h2></div>
        <v-btn icon="mdi-close" variant="text" :disabled="busy" aria-label="关闭状态映射" @click="$emit('close')" />
      </v-card-title>
      <v-divider />
      <v-card-text>
        <p class="dialog-intro">
          每个标签页对应一个进度状态，多行文本框中每行填写一个关键词。内置中英文词条已经列出，可直接补充、修改或删除。
        </p>
        <div class="support-warning">
          <i class="mdi mdi-alert-circle-outline"></i>
          <div>
            <strong>当前仅支持部分招聘网站</strong>
            <span>映射规则通过页面文本中的关键词进行匹配，不是模糊匹配，也不会用 AI 猜测相近词义。启用 AI 时，这些词条只会作为明确的状态规则提供给模型。</span>
          </div>
        </div>
        <v-tabs v-model="activeCategory" class="mapping-tabs" density="comfortable" show-arrows color="secondary">
          <v-tab v-for="item in categories" :key="item.value" :value="item.value">{{ item.title }}</v-tab>
        </v-tabs>
        <div class="mapping-editor">
          <div class="editor-heading">
            <div><strong>{{ activeDefinition.title }}</strong><span>{{ activeDefinition.hint }}</span></div>
            <small>{{ activeTermCount }} 条关键词</small>
          </div>
          <v-textarea
            v-model="text[activeCategory]"
            :label="`${activeDefinition.title}关键词`"
            variant="outlined"
            rows="12"
            auto-grow
            max-rows="18"
            placeholder="每行填写一个关键词"
            hide-details
            spellcheck="false"
          />
        </div>
        <div class="mapping-note">
          <i class="mdi mdi-information-outline"></i>
          <span>同一词条不能分配给两个状态。保存后，本地 DOM 解析和 AI 提示词会立即共同使用；映射只按关键词匹配，不做模糊匹配。</span>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-btn variant="text" prepend-icon="mdi-restore" :disabled="busy" @click="restoreBuiltins">恢复内置映射</v-btn>
        <v-spacer />
        <v-btn variant="text" :disabled="busy" @click="$emit('close')">取消</v-btn>
        <v-btn color="secondary" variant="flat" :loading="busy" @click="submit">保存映射</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.mapping-dialog { background: #fffdf8 !important; }
.mapping-dialog > .v-card-title { display: flex; align-items: flex-start; justify-content: space-between; padding: 24px 28px 16px; }
.mapping-dialog > .v-card-title span { color: #c16638; font-size: 9px; font-weight: 700; letter-spacing: .16em; }
.mapping-dialog > .v-card-title h2 { margin: 5px 0 0; font: 700 24px "Noto Serif SC", serif; color: var(--forest); }
.mapping-dialog .v-card-text { padding: 22px 28px 12px; }
.dialog-intro { margin: 0 0 20px; color: #6f7c76; font-size: 11px; line-height: 1.8; }
.support-warning { margin: 0 0 20px; padding: 12px 14px; display: flex; gap: 10px; align-items: flex-start; border: 1px solid #ead6b9; border-radius: 8px; color: #8a5a37; background: #fbf3e7; }
.support-warning > i { flex: none; margin-top: 1px; font-size: 18px; }
.support-warning strong, .support-warning span { display: block; }
.support-warning strong { font-size: 11px; }
.support-warning span { margin-top: 3px; color: #806b5b; font-size: 10px; line-height: 1.65; }
.mapping-tabs { margin-bottom: 18px; border-bottom: 1px solid #e5ded2; }
.mapping-tabs :deep(.v-tab) { min-width: 96px; font-size: 11px; }
.mapping-editor { padding: 17px; border: 1px solid #e2dbcf; border-radius: 9px; background: #fbf9f4; }
.editor-heading { margin-bottom: 12px; display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.editor-heading strong, .editor-heading span { display: block; }
.editor-heading strong { color: #344a42; font-size: 13px; }
.editor-heading span { margin-top: 4px; color: #89918d; font-size: 10px; }
.editor-heading small { flex: none; padding: 4px 8px; border-radius: 999px; color: #4e705f; background: #e7f0ea; font-size: 9px; }
.mapping-editor :deep(textarea) { font: 11px/1.75 ui-monospace, SFMono-Regular, Consolas, monospace; }
.mapping-note { margin-top: 10px; padding: 11px 13px; display: flex; gap: 8px; align-items: flex-start; border-radius: 8px; color: #6e776f; background: #f5f0e7; font-size: 10px; line-height: 1.6; }
.mapping-note i { color: #a66a46; font-size: 16px; }
.mapping-dialog .v-card-actions { padding: 14px 24px 20px; border-top: 1px solid #ece5d9; }
@media (max-width: 700px) {
  .mapping-dialog > .v-card-title { padding: 20px 20px 14px; }
  .mapping-dialog .v-card-text { padding: 18px 20px 8px; }
  .mapping-dialog .v-card-actions { flex-wrap: wrap; }
  .mapping-dialog .v-card-actions .v-spacer { display: none; }
}
</style>
