<script setup lang="ts">
import { computed } from "vue";
import type { ApplicationSummary } from "@application-checker/contracts";
import { progressLabels, runLabels } from "@application-checker/contracts";

const props = defineProps<{ items: ApplicationSummary[]; selected: Set<string>; activeId: string | null }>();
defineEmits<{
  toggle: [id: string];
  togglePage: [ids: string[], checked: boolean];
  open: [id: string];
  run: [id: string];
}>();

const allPageSelected = computed(() => props.items.length > 0 && props.items.every((item) => props.selected.has(item.id)));
const somePageSelected = computed(() => props.items.some((item) => props.selected.has(item.id)));

function relative(value: string | null): string {
  if (!value) return "—";
  const timestamp = new Date(value).getTime();
  const future = timestamp - Date.now();
  if (future > 0) {
    const minutesUntil = Math.max(1, Math.ceil(future / 60_000));
    if (minutesUntil < 60) return `${minutesUntil} 分钟后`;
    const hoursUntil = Math.ceil(minutesUntil / 60);
    if (hoursUntil < 24) return `${hoursUntil} 小时后`;
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(new Date(value));
  }
  const diff = Date.now() - timestamp;
  const minutes = Math.max(0, Math.round(diff / 60_000));
  if (minutes < 60) return minutes ? `${minutes} 分钟前` : "刚刚";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
</script>

<template>
  <div class="table-shell">
    <table class="application-table">
      <thead>
        <tr>
          <th class="check-col" @click.stop>
            <v-checkbox-btn
              class="application-checkbox page-checkbox"
              :model-value="allPageSelected"
              :indeterminate="somePageSelected && !allPageSelected"
              :disabled="!items.length"
              aria-label="全选本页"
              color="primary"
              density="compact"
              @update:model-value="$emit('togglePage', items.map((item) => item.id), Boolean($event))"
            />
          </th>
          <th>公司 / 岗位</th>
          <th>当前状态</th>
          <th>投递链接 / 域名</th>
          <th>上次检查</th>
          <th>下次检查</th>
          <th>登录状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.id" :class="{ selected: activeId === item.id }" @click="$emit('open', item.id)">
          <td class="check-col" @click.stop>
            <v-checkbox-btn
              class="application-checkbox"
              :model-value="selected.has(item.id)"
              :aria-label="`选择 ${item.company}`"
              color="primary"
              density="compact"
              @update:model-value="$emit('toggle', item.id)"
            />
          </td>
          <td>
            <strong class="company">{{ item.company }}</strong>
            <span class="job-title">{{ item.jobTitle }}</span>
          </td>
          <td><span class="status-chip" :data-status="item.progressStatus">{{ progressLabels[item.progressStatus] }}</span></td>
          <td>
            <span class="link-line">{{ item.resolvedUrl || item.checkUrl || "邮件投递 / 未提供状态页" }}</span>
            <small>{{ item.checkUrl ? item.site : "仅手动记录" }}</small>
          </td>
          <td>
            <span>{{ relative(item.lastRunAt) }}</span>
            <small v-if="item.lastRunStatus">{{ runLabels[item.lastRunStatus] }}</small>
          </td>
          <td><span>{{ item.scheduleMode === "manual" ? "" : item.nextRunAt ? relative(item.nextRunAt) : "—" }}</span></td>
          <td>
            <span v-if="item.lastRunStatus === 'needs_login'" class="login-state warning"><i class="mdi mdi-lock-alert-outline"></i>需要登录</span>
            <span v-else-if="item.browserProfileUpdatedAt" class="login-state ok"><i class="mdi mdi-check-circle"></i>正常</span>
            <span v-else class="login-state muted"><i class="mdi mdi-circle-outline"></i>未保存</span>
          </td>
          <td @click.stop>
            <button class="row-action" :disabled="!item.checkUrl || item.lastRunStatus === 'queued' || item.lastRunStatus === 'running'" @click="$emit('run', item.id)">
              {{ item.checkUrl ? "立即检查" : "仅手动" }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!items.length" class="empty-table">
      <i class="mdi mdi-briefcase-search-outline"></i>
      <strong>还没有岗位记录</strong>
      <span>添加第一个招聘页面，之后就不用逐个网站检查了。</span>
    </div>
  </div>
</template>

<style scoped>
.table-shell { overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: #fffdf8; box-shadow: 0 10px 32px #183a3708; }
.application-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.application-table th { height: 43px; padding: 0 13px; background: #f4f1e9; color: #58625e; font-size: 11px; font-weight: 500; text-align: left; border-bottom: 1px solid #ddd6c9; }
.application-table th:nth-child(2) { width: 17%; }
.application-table th:nth-child(3) { width: 11%; }
.application-table th:nth-child(4) { width: 22%; }
.application-table th:nth-child(5), .application-table th:nth-child(6) { width: 11%; }
.application-table th:nth-child(7) { width: 12%; }
.application-table th:nth-child(8) { width: 13%; }
.application-table .check-col { width: 42px; text-align: center; padding: 0; }
.application-table td { height: 73px; padding: 10px 13px; border-bottom: 1px solid #ece6da; color: #3d4944; font-size: 12px; vertical-align: middle; overflow: hidden; }
.application-table td.check-col { overflow: visible; }
.application-table tr:last-child td { border-bottom: 0; }
.application-table tbody tr { transition: .16s ease; cursor: pointer; }
.application-table tbody tr:hover { background: #f7faf7; }
.application-table tbody tr.selected { background: #eef5f0; box-shadow: inset 3px 0 #32765c; }
.application-checkbox :deep(.v-selection-control__input) { margin: 0 auto; width: 34px; height: 34px; }
.application-checkbox :deep(.v-selection-control__input > .v-icon) { font-size: 21px; }
.company, .job-title, .link-line, .application-table td > small { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.company { color: #24312d; font-size: 14px; font-weight: 600; }
.job-title { margin-top: 5px; color: #6d7772; font-size: 11px; }
.link-line { color: #48554f; }
.application-table td > small { margin-top: 5px; color: #8a928e; font-size: 10px; }
.empty-table { min-height: 310px; display: grid; place-content: center; justify-items: center; color: #74807b; }
.empty-table i { font-size: 42px; color: #9aac9f; }
.empty-table strong { margin-top: 10px; color: #41514a; font-family: "Noto Serif SC", serif; }
.empty-table span { margin-top: 6px; font-size: 12px; }
</style>
