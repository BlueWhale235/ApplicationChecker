<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { filterScriptApiSections } from "../pages/script-api-docs";

const props = defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();

const query = ref("");
const sections = computed(() => filterScriptApiSections(query.value));

watch(() => props.open, (open) => {
  if (open) query.value = "";
});
</script>

<template>
  <v-dialog :model-value="open" max-width="980" scrollable @update:model-value="!$event && $emit('close')">
    <v-card class="script-api-dialog" rounded="lg">
      <v-card-title>
        <div><span>PAGE SCRIPT REFERENCE</span><h2>页面脚本 API 文档</h2><p>脚本在当前 Edge 页面中运行，只开放以下只读数据和页面操作方法。</p></div>
        <v-btn icon="mdi-close" variant="text" aria-label="关闭 API 文档" @click="$emit('close')" />
      </v-card-title>
      <v-divider />
      <v-card-text>
        <div class="api-notice"><i class="mdi mdi-shield-lock-outline"></i><span>不开放 Node.js、本地文件、Cookie 或应用密钥。所有选择器均使用标准 CSS selector。</span></div>
        <v-text-field v-model="query" class="api-search" prepend-inner-icon="mdi-magnify" label="搜索字段或方法"
          placeholder="例如 waitForSelector、投递时间、返回结果" variant="outlined" density="compact" clearable hide-details />

        <div v-if="sections.length" class="api-sections">
          <section v-for="section in sections" :key="section.id" class="api-section">
            <header><div><strong>{{ section.title }}</strong><span>{{ section.subtitle }}</span></div><small>{{ section.entries.length }} 项</small></header>
            <article v-for="entry in section.entries" :key="entry.signature" class="api-entry">
              <code>{{ entry.signature }}</code>
              <div><strong>{{ entry.description }}</strong><p v-if="entry.detail">{{ entry.detail }}</p><pre v-if="entry.example"><code>{{ entry.example }}</code></pre></div>
            </article>
          </section>
        </div>
        <div v-else class="api-empty"><i class="mdi mdi-file-search-outline"></i><span>没有匹配的字段或方法</span></div>
      </v-card-text>
      <v-card-actions><span>提示：规则总超时应大于脚本中最长的一次等待时间。</span><v-spacer /><v-btn color="secondary" variant="flat" @click="$emit('close')">知道了</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.script-api-dialog { max-height: 88vh; background: #fffdf8 !important; }
.script-api-dialog > .v-card-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 24px 28px 16px; }
.script-api-dialog > .v-card-title span { color: #c16638; font-size: 9px; font-weight: 700; letter-spacing: .16em; }
.script-api-dialog > .v-card-title h2 { margin: 5px 0 0; font: 700 24px "Noto Serif SC", serif; color: var(--forest); }
.script-api-dialog > .v-card-title p { margin: 6px 0 0; color: #75827c; font-size: 11px; font-weight: 400; white-space: normal; }
.script-api-dialog .v-card-text { padding: 20px 28px 24px; }
.api-notice { margin-bottom: 14px; padding: 11px 13px; display: flex; align-items: flex-start; gap: 8px; border: 1px solid #ead6b9; border-radius: 8px; color: #7f654f; background: #fbf3e7; font-size: 11px; line-height: 1.6; }
.api-notice i { color: #b46632; font-size: 17px; }
.api-search { margin-bottom: 20px; }
.api-sections { display: grid; gap: 22px; }
.api-section { overflow: hidden; border: 1px solid #e3dccf; border-radius: 10px; background: #fff; }
.api-section > header { padding: 13px 16px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid #e9e2d7; background: #f7f3eb; }
.api-section > header strong, .api-section > header span { display: block; }
.api-section > header strong { color: #36564b; font-size: 14px; }
.api-section > header span { margin-top: 2px; color: #839089; font-size: 10px; }
.api-section > header small { padding: 3px 8px; border-radius: 999px; color: #a85825; background: #ffead8; font-size: 10px; }
.api-entry { display: grid; grid-template-columns: minmax(260px, .85fr) minmax(0, 1.15fr); gap: 18px; padding: 13px 16px; border-bottom: 1px solid #eee8de; }
.api-entry:last-child { border-bottom: 0; }
.api-entry > code { align-self: start; overflow-wrap: anywhere; color: #b35d26; font: 12px/1.6 Consolas, monospace; }
.api-entry > div > strong { color: #40564e; font-size: 12px; }
.api-entry p { margin: 4px 0 0; color: #7b8781; font-size: 11px; line-height: 1.55; }
.api-entry pre { overflow-x: auto; margin: 8px 0 0; padding: 9px 11px; border-radius: 6px; background: #18231f; color: #cfe4db; font: 11px/1.6 Consolas, monospace; white-space: pre-wrap; }
.api-empty { min-height: 220px; display: grid; place-content: center; justify-items: center; gap: 8px; color: #85918b; }
.api-empty i { font-size: 38px; color: #b4c0bb; }
.script-api-dialog .v-card-actions { padding: 14px 24px 18px; border-top: 1px solid #ece5d9; }
.script-api-dialog .v-card-actions > span { color: #7d8882; font-size: 10px; }
@media (max-width: 700px) {
  .script-api-dialog > .v-card-title { padding: 20px 20px 14px; }
  .script-api-dialog .v-card-text { padding: 16px 18px 20px; }
  .api-entry { grid-template-columns: 1fr; gap: 5px; }
  .script-api-dialog .v-card-actions > span { display: none; }
}
</style>
