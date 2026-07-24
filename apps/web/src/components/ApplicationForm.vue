<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { ApplicationSummary, CreateApplication, ScheduleMode } from "@application-checker/contracts";

const props = defineProps<{ open: boolean; editItem?: ApplicationSummary | null }>();
const emit = defineEmits<{ close: []; save: [value: CreateApplication, runNow: boolean] }>();
const valid = ref(false);
const scheduleItems = [
  { title: "继承全局计划", value: "inherit" },
  { title: "自定义 Cron", value: "custom" },
  { title: "仅手动", value: "manual" },
];
const form = reactive({
  company: "",
  jobTitle: "",
  checkUrl: "",
  postingUrl: "",
  appliedAt: "",
  location: "",
  notes: "",
  scheduleMode: "inherit" as ScheduleMode,
  cronExpression: "",
});
const hasCheckUrl = computed(() => Boolean(form.checkUrl.trim()));
watch(() => [props.open, props.editItem?.id] as const, ([open]) => {
  if (!open) return;
  const item = props.editItem;
  Object.assign(form, item ? {
    company: item.company,
    jobTitle: item.jobTitle,
    checkUrl: item.checkUrl ?? "",
    postingUrl: item.postingUrl ?? "",
    appliedAt: item.appliedAt ?? "",
    location: item.location ?? "",
    notes: item.notes ?? "",
    scheduleMode: item.scheduleMode,
    cronExpression: item.cronExpression ?? "",
  } : {
    company: "", jobTitle: "", checkUrl: "", postingUrl: "", appliedAt: "", location: "", notes: "",
    scheduleMode: "inherit", cronExpression: "",
  });
}, { immediate: true });

function submit(runNow: boolean) {
  emit("save", {
    company: form.company,
    jobTitle: form.jobTitle,
    checkUrl: form.checkUrl.trim() || null,
    postingUrl: form.postingUrl || null,
    appliedAt: form.appliedAt || null,
    location: form.location || null,
    notes: form.notes || null,
    scheduleMode: hasCheckUrl.value ? form.scheduleMode : "manual",
    cronExpression: hasCheckUrl.value && form.scheduleMode === "custom" ? form.cronExpression : null,
  }, runNow && hasCheckUrl.value);
}
</script>

<template>
  <v-dialog :model-value="open" max-width="760" persistent @update:model-value="!$event && $emit('close')">
    <v-card class="form-modal" rounded="lg">
      <v-card-title>
        <div><span>{{ editItem ? "编辑岗位" : "新增岗位" }}</span><h2>{{ editItem ? "更新投递信息" : "记录一个新的投递" }}</h2></div>
        <v-btn icon="mdi-close" variant="text" aria-label="关闭" @click="$emit('close')" />
      </v-card-title>
      <v-form v-model="valid" @submit.prevent="submit(false)">
        <v-card-text>
          <v-row dense>
            <v-col cols="12" md="6"><v-text-field v-model="form.company" label="公司名称 *" maxlength="160" variant="outlined" :rules="[v => Boolean(v) || '请填写公司名称']" /></v-col>
            <v-col cols="12" md="6"><v-text-field v-model="form.jobTitle" label="岗位名称 *" maxlength="240" variant="outlined" :rules="[v => Boolean(v) || '请填写岗位名称']" /></v-col>
            <v-col cols="12">
              <v-text-field
                v-model="form.checkUrl"
                label="投递状态页面 URL（可选）"
                type="url"
                variant="outlined"
                placeholder="https://careers.example.com/applications/..."
                hint="邮件投递可以留空；留空后仅支持手动更新进度"
                persistent-hint
              />
            </v-col>
            <v-col cols="12"><v-text-field v-model="form.postingUrl" label="职位发布 URL" type="url" variant="outlined" placeholder="可选，用于返回查看职位描述" /></v-col>
            <v-col cols="12" md="6"><v-text-field v-model="form.appliedAt" label="投递日期" type="date" variant="outlined" /></v-col>
            <v-col cols="12" md="6"><v-text-field v-model="form.location" label="工作地点" maxlength="160" variant="outlined" /></v-col>
            <v-col cols="12" md="6"><v-select v-model="form.scheduleMode" label="检查计划" :items="scheduleItems" variant="outlined" :disabled="!hasCheckUrl" :hint="!hasCheckUrl ? '填写状态页 URL 后才能启用自动检查' : undefined" persistent-hint /></v-col>
            <v-col v-if="hasCheckUrl && form.scheduleMode === 'custom'" cols="12" md="6"><v-text-field v-model="form.cronExpression" label="Cron 表达式" variant="outlined" placeholder="0 9 * * *" :rules="[v => Boolean(v) || '请填写 Cron 表达式']" /></v-col>
            <v-col cols="12"><v-textarea v-model="form.notes" label="备注" rows="3" maxlength="4000" variant="outlined" placeholder="记录内推人、申请编号或需要关注的信息" /></v-col>
          </v-row>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="$emit('close')">取消</v-btn>
          <v-btn type="submit" variant="outlined" color="primary" :disabled="!valid">保存</v-btn>
          <v-btn v-if="!editItem" color="secondary" variant="flat" :disabled="!valid || !hasCheckUrl" @click="submit(true)">保存并检查</v-btn>
        </v-card-actions>
      </v-form>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.form-modal { width: 100%; max-height: calc(100vh - 60px); overflow-y: auto; background: #fffdf8; }
.form-modal > .v-card-title { display: flex; align-items: flex-start; justify-content: space-between; padding: 24px 28px 14px; }
.form-modal > .v-card-title span { color: #c16638; font-size: 10px; font-weight: 700; letter-spacing: .16em; }
.form-modal > .v-card-title h2 { margin: 5px 0 0; font: 700 24px "Noto Serif SC", serif; color: var(--forest); }
.form-modal .v-card-text { padding: 12px 28px 4px; }
.form-modal .v-card-actions { padding: 14px 24px 20px; border-top: 1px solid #ece5d9; }
</style>
