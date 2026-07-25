<script setup lang="ts">
import { computed } from "vue";
import type { ApplicationDetail, ApplicationSummary, ProgressStatus, RunSummary } from "@application-checker/contracts";
import SummaryStrip from "../components/SummaryStrip.vue";
import ApplicationTable from "../components/ApplicationTable.vue";
import ApplicationDrawer from "../components/ApplicationDrawer.vue";

const props = defineProps<{
  applications: ApplicationSummary[];
  items: ApplicationSummary[];
  selected: Set<string>;
  activeId: string | null;
  detail: ApplicationDetail | null;
  detailLoading: boolean;
  query: string;
  statusFilter: string;
  statusItems: Array<{ title: string; value: string }>;
  busy: boolean;
  page: number;
  pageCount: number;
  total: number;
  perPage: number;
}>();

const bulkRunLabel = computed(() => {
  if (props.selected.size) return `检查已选 (${props.selected.size})`;
  if (props.statusFilter) {
    const label = props.statusItems.find((item) => item.value === props.statusFilter)?.title ?? props.statusFilter;
    return `检查<${label}>`;
  }
  if (props.query.trim()) return "检查筛选结果";
  return "检查全部";
});

defineEmits<{
  add: [];
  query: [value: string];
  statusFilter: [value: string];
  page: [value: number];
  toggle: [id: string];
  togglePage: [ids: string[], checked: boolean];
  open: [id: string];
  run: [id: string];
  bulkRun: [];
  closeDetail: [];
  progress: [id: string, status: ProgressStatus];
  unlock: [id: string];
  resumeAutomation: [id: string];
  login: [run: RunSummary];
  refreshLogin: [id: string];
  viewScreenshot: [run: RunSummary];
  deleteScreenshot: [run: RunSummary];
  remove: [id: string];
  saveNotes: [id: string, notes: string, done: (ok: boolean) => void];
  editPlan: [];
  editApplication: [];
}>();
</script>

<template>
  <section class="page-content progress-page" :class="{ 'with-detail': detail }">
    <div class="page-heading">
      <div><h1>求职进度</h1><p>自动检查投递状态，保存每一次进展。</p></div>
      <button class="primary-button add-button" @click="$emit('add')"><i class="mdi mdi-plus"></i>新增岗位</button>
    </div>
    <SummaryStrip :items="applications" :active-filter="statusFilter" @filter="$emit('statusFilter', $event)" />
    <div class="toolbar">
      <v-text-field
        :model-value="query"
        class="search-field"
        placeholder="搜索公司、岗位或网址"
        prepend-inner-icon="mdi-magnify"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        @update:model-value="$emit('query', $event || '')"
      />
      <v-select
        :model-value="statusFilter"
        class="status-filter"
        :items="statusItems"
        variant="outlined"
        density="compact"
        hide-details
        @update:model-value="$emit('statusFilter', $event ?? '')"
      />
      <v-btn
        variant="outlined"
        color="primary"
        prepend-icon="mdi-refresh"
        :disabled="busy || (!selected.size && !total)"
        @click="$emit('bulkRun')"
      >
        {{ bulkRunLabel }}
      </v-btn>
    </div>
    <ApplicationTable
      :items="items"
      :selected="selected"
      :active-id="activeId"
      @toggle="$emit('toggle', $event)"
      @toggle-page="(ids, checked) => $emit('togglePage', ids, checked)"
      @open="$emit('open', $event)"
      @run="$emit('run', $event)"
    />
    <div v-if="total > perPage" class="application-pagination">
      <span>共 {{ total }} 条，每页 {{ perPage }} 条</span>
      <v-pagination :model-value="page" :length="pageCount" :total-visible="7" density="comfortable" @update:model-value="$emit('page', $event)" />
    </div>

    <ApplicationDrawer
      :detail="detail"
      :loading="detailLoading"
      @close="$emit('closeDetail')"
      @run="$emit('run', $event)"
      @progress="(id, status) => $emit('progress', id, status)"
      @unlock="$emit('unlock', $event)"
      @resume-automation="$emit('resumeAutomation', $event)"
      @login="$emit('login', $event)"
      @refresh-login="$emit('refreshLogin', $event)"
      @view-screenshot="$emit('viewScreenshot', $event)"
      @delete-screenshot="$emit('deleteScreenshot', $event)"
      @remove="$emit('remove', $event)"
      @save-notes="(id, notes, done) => $emit('saveNotes', id, notes, done)"
      @edit-plan="$emit('editPlan')"
      @edit-application="$emit('editApplication')"
    />
  </section>
</template>

<style scoped>
.progress-page { transition: padding-right .2s ease; }
.progress-page.with-detail { max-width: none; padding-right: 421px; }
.toolbar { display: flex; gap: 10px; margin: 23px 0 12px; }
.search-field { flex: 1 1 360px; max-width: 520px; }
.status-filter { flex: 0 0 168px; }
.toolbar :deep(.v-field) { background: #fffdf8; border-radius: 8px; }
.toolbar :deep(.v-field__input) { font-size: 12px; }
.application-pagination { min-height: 70px; display: flex; align-items: center; justify-content: space-between; gap: 20px; color: #77817c; font-size: 11px; }
.application-pagination :deep(.v-pagination) { margin-left: auto; }
@media (max-width: 1280px) {
  .progress-page.with-detail { padding-right: 391px; }
}
@media (max-width: 1100px) {
  .progress-page.with-detail { padding-right: 31px; }
}
</style>
