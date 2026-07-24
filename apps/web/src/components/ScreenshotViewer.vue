<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import type { RunSummary } from "@application-checker/contracts";
import { runLabels } from "@application-checker/contracts";
import { api } from "../api";

const props = defineProps<{
  open: boolean;
  run: RunSummary | null;
  company: string;
  jobTitle: string;
}>();
const emit = defineEmits<{ close: [] }>();

function closeOnEscape(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close");
}
watch(() => props.open, (open) => {
  if (open) document.addEventListener("keydown", closeOnEscape);
  else document.removeEventListener("keydown", closeOnEscape);
}, { immediate: true });
onBeforeUnmount(() => document.removeEventListener("keydown", closeOnEscape));

function date(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}
</script>

<template>
  <div v-if="open && run" class="modal-backdrop screenshot-viewer-backdrop" @click.self="$emit('close')">
    <section class="screenshot-viewer" role="dialog" aria-modal="true" aria-labelledby="screenshot-viewer-title">
      <header>
        <div>
          <span>网页完整截图</span>
          <h2 id="screenshot-viewer-title">{{ company }} · {{ jobTitle }}</h2>
          <p>{{ date(run.completedAt || run.createdAt) }} · {{ runLabels[run.status] }}</p>
        </div>
        <div class="viewer-head-actions">
          <span v-if="run.screenshotTruncated" class="viewer-warning"><i class="mdi mdi-alert-outline"></i>页面过长，截图已截断</span>
          <button class="icon-button" aria-label="关闭截图" @click="$emit('close')"><i class="mdi mdi-close"></i></button>
        </div>
      </header>
      <div class="screenshot-canvas">
        <img :src="api.screenshotUrl(run.id)" :alt="`${company} ${jobTitle} 网页截图`" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.screenshot-viewer-backdrop { z-index: 100; padding: 22px; }
.screenshot-viewer { width: min(1380px, calc(100vw - 44px)); height: calc(100vh - 44px); display: grid; grid-template-rows: auto 1fr; overflow: hidden; border-radius: 13px; background: #fffdf8; box-shadow: 0 28px 90px #0b1f1b66; }
.screenshot-viewer header { min-height: 78px; padding: 15px 20px; display: flex; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 1px solid #ded7ca; }
.screenshot-viewer header > div:first-child > span { color: #b86136; font-size: 9px; font-weight: 700; letter-spacing: .14em; }
.screenshot-viewer h2 { margin: 4px 0 0; color: #163f37; font: 600 18px "Noto Serif SC", serif; }
.screenshot-viewer p { margin: 4px 0 0; color: #828b86; font-size: 10px; }
.viewer-head-actions { display: flex; align-items: center; gap: 12px; }
.viewer-warning { color: #a46238; font-size: 10px; }
.screenshot-canvas { min-height: 0; overflow: auto; background: #23312e; text-align: center; }
.screenshot-canvas img { display: block; width: min(100%, 1440px); height: auto; margin: 0 auto; background: white; box-shadow: 0 12px 40px #0006; }
</style>
