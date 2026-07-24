<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import type { AppSettings, CheckGroupSummary, CheckPlanUpdate, ScheduleMode } from "@application-checker/contracts";

const props = defineProps<{
  open: boolean;
  group: CheckGroupSummary | null;
  settings: AppSettings;
  saving: boolean;
}>();
const emit = defineEmits<{ close: []; save: [value: CheckPlanUpdate] }>();
const form = reactive<{ scheduleMode: ScheduleMode; cronExpression: string }>({
  scheduleMode: "inherit",
  cronExpression: "",
});
const initializedGroupId = ref<string | null>(null);

watch(() => [props.open, props.group?.id] as const, ([open, groupId]) => {
  if (!open) {
    initializedGroupId.value = null;
    return;
  }
  const group = props.group;
  if (!group || !groupId || initializedGroupId.value === groupId) return;
  form.scheduleMode = group.scheduleMode;
  form.cronExpression = group.cronExpression ?? "";
  initializedGroupId.value = groupId;
}, { immediate: true });

function submit() {
  emit("save", {
    scheduleMode: form.scheduleMode,
    cronExpression: form.scheduleMode === "custom" ? form.cronExpression.trim() : null,
  });
}
</script>

<template>
  <v-dialog :model-value="open" max-width="620" @update:model-value="!$event && $emit('close')">
    <v-card class="check-plan-dialog">
      <v-card-title>编辑检查计划</v-card-title>
      <v-card-subtitle v-if="group">
        此计划由同一状态页的 {{ group.memberCount }} 个岗位共享
      </v-card-subtitle>
      <v-card-text v-if="group">
        <div class="plan-members">
          <v-chip v-for="member in group.members" :key="member.id" size="small" variant="tonal">
            {{ member.jobTitle }}
          </v-chip>
        </div>
        <v-radio-group v-model="form.scheduleMode" class="plan-options">
          <v-radio value="inherit">
            <template #label>
              <div><strong>继承全局计划</strong><small>{{ settings.globalCron || "全局计划当前已关闭" }} · {{ settings.timezone }}</small></div>
            </template>
          </v-radio>
          <v-radio value="custom">
            <template #label>
              <div><strong>自定义计划</strong><small>为这个状态页单独设置五段 Cron</small></div>
            </template>
          </v-radio>
          <v-radio value="manual">
            <template #label>
              <div><strong>仅手动检查</strong><small>不自动运行，只在手动触发时检查</small></div>
            </template>
          </v-radio>
        </v-radio-group>
        <v-text-field
          v-if="form.scheduleMode === 'custom'"
          v-model="form.cronExpression"
          label="Cron 表达式"
          placeholder="0 9 * * *"
          variant="outlined"
          hint="标准五段 Cron，例如每天 09:00：0 9 * * *"
          persistent-hint
          :rules="[value => Boolean(value?.trim()) || '请填写 Cron 表达式']"
        />
        <div class="plan-next-run">
          <span>当前下次检查</span>
          <strong>{{ group.nextRunAt ? new Date(group.nextRunAt).toLocaleString('zh-CN') : "仅手动 / 暂未安排" }}</strong>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="$emit('close')">取消</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" :disabled="form.scheduleMode === 'custom' && !form.cronExpression.trim()" @click="submit">
          保存计划
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.check-plan-dialog .v-card-subtitle { opacity: 1; color: #71817a; }
.plan-members { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.plan-options :deep(.v-label) { opacity: 1; }
.plan-options :deep(.v-label div) { display: grid; gap: 2px; }
.plan-options :deep(.v-label strong) { color: #2d3c36; font-size: 13px; }
.plan-options :deep(.v-label small) { color: #7b8781; font-size: 11px; }
.plan-next-run { display: flex; justify-content: space-between; gap: 20px; margin-top: 18px; padding: 12px; border-radius: 8px; background: #f5f1e7; font-size: 11px; }
</style>
