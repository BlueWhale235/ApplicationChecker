<script setup lang="ts">
defineProps<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
}>();
defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <v-dialog :model-value="open" max-width="460" persistent @update:model-value="!$event && $emit('cancel')">
    <v-card class="confirm-card" rounded="lg">
      <v-card-title class="confirm-title">
        <v-icon :icon="danger ? 'mdi-alert-outline' : 'mdi-help-circle-outline'" :color="danger ? 'error' : 'primary'" />
        {{ title }}
      </v-card-title>
      <v-card-text>{{ message }}</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="$emit('cancel')">取消</v-btn>
        <v-btn :color="danger ? 'error' : 'primary'" variant="flat" :loading="busy" @click="$emit('confirm')">
          {{ confirmLabel || "确认" }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.confirm-title { display: flex; align-items: center; gap: 10px; color: #20332c; font: 600 18px "Noto Serif SC", serif; }
.confirm-card .v-card-text { color: #65716c; font-size: 13px; line-height: 1.75; }
.confirm-card .v-card-actions { padding: 14px 24px 20px; border-top: 1px solid #ece5d9; }
</style>
