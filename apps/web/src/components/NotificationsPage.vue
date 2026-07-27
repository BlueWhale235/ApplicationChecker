<script setup lang="ts">
import type {
  ApplicationDetail, NotificationPage, NotificationSummary, ProgressStatus, RunSummary,
} from "@application-checker/contracts";
import { progressLabels } from "@application-checker/contracts";
import ApplicationDrawer from "./ApplicationDrawer.vue";

defineProps<{
  page: NotificationPage;
  scope: "all" | "unread";
  busy: boolean;
  detail: ApplicationDetail | null;
  detailLoading: boolean;
  currentPage: number;
  pageCount: number;
  perPage: number;
}>();
defineEmits<{
  scope: [value: "all" | "unread"];
  page: [value: number];
  open: [notification: NotificationSummary];
  readAll: [];
  clearAll: [];
  closeDetail: [];
  run: [id: string];
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

function date(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
</script>

<template>
  <section class="page-content notification-page" :class="{ 'with-detail': detail }">
    <div class="page-heading">
      <div><h1>消息通知</h1><p>集中查看 AI 自动识别到的岗位进展。</p></div>
      <div class="notification-heading-actions">
        <v-btn
          variant="outlined"
          color="primary"
          prepend-icon="mdi-check-all"
          :disabled="busy || !page.unreadCount"
          @click="$emit('readAll')"
        >
          全部已读
        </v-btn>
        <v-btn
          variant="outlined"
          color="error"
          prepend-icon="mdi-delete-sweep-outline"
          :disabled="busy"
          @click="$emit('clearAll')"
        >
          清空消息
        </v-btn>
      </div>
    </div>

    <div class="notification-toolbar">
      <v-btn-toggle
        :model-value="scope"
        mandatory
        color="primary"
        variant="outlined"
        @update:model-value="$emit('scope', $event)"
      >
        <v-btn value="all">全部消息</v-btn>
        <v-btn value="unread">未读 {{ page.unreadCount }}</v-btn>
      </v-btn-toggle>
      <span>共 {{ page.total }} 条</span>
    </div>

    <div v-if="page.items.length" class="notification-list">
      <button
        v-for="item in page.items"
        :key="item.id"
        type="button"
        class="notification-card"
        :class="{ unread: !item.readAt }"
        @click="$emit('open', item)"
      >
        <span class="notification-icon" :data-status="item.toStatus">
          <i :class="item.toStatus === 'rejected' ? 'mdi mdi-close-circle-outline' : item.toStatus === 'offer' ? 'mdi mdi-party-popper' : 'mdi mdi-trending-up'"></i>
        </span>
        <span class="notification-content">
          <span class="notification-title">
            <strong>{{ item.company }}</strong>
            <span>{{ item.jobTitle }}</span>
          </span>
          <span class="notification-change">
            {{ progressLabels[item.fromStatus] }} <i class="mdi mdi-arrow-right"></i>
            <b :data-status="item.toStatus">{{ progressLabels[item.toStatus] }}</b>
          </span>
          <span v-if="item.evidence" class="notification-evidence">{{ item.evidence }}</span>
          <small>AI 自动识别<span v-if="item.confidence !== null"> · {{ Math.round(item.confidence * 100) }}%</span></small>
        </span>
        <time>{{ date(item.createdAt) }}</time>
        <i class="mdi mdi-chevron-right notification-chevron"></i>
      </button>
    </div>

    <div v-else class="notification-empty">
      <i class="mdi mdi-bell-check-outline"></i>
      <strong>{{ scope === "unread" ? "没有未读消息" : "还没有进展消息" }}</strong>
      <span>{{ scope === "unread" ? "新的 AI 识别结果会出现在这里。" : "AI 自动更新岗位状态后会生成一条消息。" }}</span>
    </div>

    <div v-if="page.total > perPage" class="notification-pagination">
      <span>共 {{ page.total }} 条，每页 {{ perPage }} 条</span>
      <v-pagination
        :model-value="currentPage"
        :length="pageCount"
        :total-visible="7"
        density="comfortable"
        @update:model-value="$emit('page', $event)"
      />
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
.notification-heading-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.notification-page { max-width: 1080px; transition: padding-right .2s ease; }
.notification-page.with-detail { max-width: none; padding-right: 421px; }
.notification-toolbar { margin: 22px 0 16px; display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 13px; }
.notification-list { display: grid; gap: 10px; }
.notification-card { width: 100%; min-height: 104px; padding: 18px 20px; border: 1px solid #e2ddd0; border-radius: 14px; background: #fffdf8; display: grid; grid-template-columns: 48px minmax(0, 1fr) auto 20px; gap: 16px; align-items: center; color: #172521; text-align: left; transition: .18s ease; }
.notification-card:hover { border-color: #b8cfc5; transform: translateY(-1px); box-shadow: 0 8px 22px #153d3510; }
.notification-card.unread { border-color: #a9cbbb; background: #f3faf6; box-shadow: inset 3px 0 #3f8c70; }
.notification-icon { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: #eaf5ef; color: #347a61; font-size: 22px; }
.notification-icon[data-status="rejected"] { background: #fff0ec; color: #bd583c; }
.notification-icon[data-status="offer"] { background: #fff6dc; color: #b37a18; }
.notification-content { min-width: 0; display: grid; gap: 6px; }
.notification-title { display: flex; gap: 8px; align-items: baseline; }
.notification-title strong { font-size: 15px; }
.notification-title > span, .notification-evidence { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.notification-title > span { color: #66756f; font-size: 13px; }
.notification-change { display: flex; align-items: center; gap: 7px; color: #68766f; font-size: 13px; }
.notification-change b { color: #2f8062; }
.notification-change b[data-status="rejected"] { color: #bd583c; }
.notification-evidence { max-width: 720px; color: #485a53; font-size: 13px; }
.notification-content small, .notification-card time { color: #87938d; font-size: 12px; }
.notification-card time { align-self: start; }
.notification-chevron { color: #9ca9a3; }
.notification-empty { min-height: 340px; border: 1px dashed #d9d3c7; border-radius: 16px; display: grid; place-content: center; justify-items: center; gap: 8px; color: #839089; text-align: center; background: #fffdf88a; }
.notification-empty i { font-size: 42px; color: #6c9a87; }
.notification-empty strong { color: #354b43; font-size: 16px; }
.notification-pagination { min-height: 70px; display: flex; align-items: center; justify-content: space-between; gap: 20px; color: #77817c; font-size: 11px; }
.notification-pagination :deep(.v-pagination) { margin-left: auto; }
@media (max-width: 760px) {
  .notification-card { grid-template-columns: 42px minmax(0, 1fr) 18px; padding: 15px; }
  .notification-card time { grid-column: 2; }
  .notification-title { display: grid; gap: 2px; }
}
@media (max-width: 1280px) {
  .notification-page.with-detail { padding-right: 391px; }
}
@media (max-width: 1100px) {
  .notification-page.with-detail { padding-right: 31px; }
}
</style>
