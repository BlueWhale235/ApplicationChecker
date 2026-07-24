<script setup lang="ts">
import { computed } from "vue";
import type { ApplicationSummary, ProgressStatus } from "@application-checker/contracts";
import { progressLabels } from "@application-checker/contracts";

const props = defineProps<{ items: ApplicationSummary[]; activeFilter: string }>();
defineEmits<{ filter: [value: string] }>();
const statuses: ProgressStatus[] = ["screening", "screening_passed", "interview_pending", "interviewed", "signing_pending", "offer", "rejected"];
const colors: Record<ProgressStatus, string> = {
  unset: "#8a918d",
  screening: "#3975b9",
  screening_passed: "#3d8a72",
  interview_pending: "#d89b13",
  interviewed: "#7656b1",
  signing_pending: "#5d9565",
  offer: "#287747",
  rejected: "#c65b48",
};
const count = computed(() => Object.fromEntries(statuses.map((status) => [status, props.items.filter((item) => item.progressStatus === status).length])));
</script>

<template>
  <section class="summary-strip">
    <button class="summary-total" :class="{ active: !activeFilter }" @click="$emit('filter', '')">
      <span>投递总览</span>
      <strong>{{ items.length }}</strong>
      <small>个岗位</small>
    </button>
    <button v-for="status in statuses" :key="status" class="summary-cell" :class="{ active: activeFilter === status }" @click="$emit('filter', status)">
      <span>{{ progressLabels[status] }}</span>
      <div><strong>{{ count[status] }}</strong><i :style="{ background: colors[status] }"></i></div>
    </button>
    <button class="summary-cell" :class="{ active: activeFilter === 'needs_login' }" @click="$emit('filter', 'needs_login')">
      <span>需要登录</span>
      <div><strong>{{ items.filter(item => item.lastRunStatus === 'needs_login').length }}</strong><i style="background:#c97843"></i></div>
    </button>
  </section>
</template>

<style scoped>
.summary-strip { min-height: 100px; display: grid; grid-template-columns: 112px repeat(8, minmax(78px, 1fr)); background: #fffdf8cc; border: 1px solid var(--border); border-radius: 11px; overflow-x: auto; }
.summary-total { margin: 8px; padding: 12px 13px; border: 1px solid #d9c9ae; border-radius: 9px; background: #f9f5eb; text-align: left; color: inherit; }
.summary-total span, .summary-total small { display: block; color: #5f6964; font-size: 11px; }
.summary-total strong { display: block; margin: 2px 0 -2px; font: 700 25px "Noto Serif SC", serif; color: var(--forest); }
.summary-cell { padding: 20px 15px; border: 0; border-left: 1px solid #ece5d9; background: transparent; color: inherit; text-align: left; }
.summary-total, .summary-cell { cursor: pointer; transition: background .16s ease, box-shadow .16s ease; }
.summary-total:hover, .summary-cell:hover { background: #f7f1e5; }
.summary-total.active, .summary-cell.active { background: #eef5f1; box-shadow: inset 0 -3px #39715f; }
.summary-total:focus-visible, .summary-cell:focus-visible { outline: 2px solid #39715f; outline-offset: -3px; }
.summary-cell > span { color: #596660; font-size: 11px; white-space: nowrap; }
.summary-cell div { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
.summary-cell strong { font: 600 21px "Noto Serif SC", serif; }
.summary-cell i { width: 5px; height: 5px; border-radius: 50%; }
@media (max-width: 1280px) {
  .summary-cell { padding-left: 10px; padding-right: 10px; }
}
</style>
