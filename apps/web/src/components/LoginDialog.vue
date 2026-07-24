<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { LoginSessionSummary } from "@application-checker/contracts";
import { api } from "../api";

const props = defineProps<{ open: boolean; runId: string | null }>();
const emit = defineEmits<{ close: []; completed: [] }>();
const session = ref<LoginSessionSummary | null>(null);
const accessUrl = ref("");
const frameUrl = ref("");
const loginPresentation = ref<"vnc" | "external-window">("vnc");
const error = ref("");
const clock = ref(Date.now());
let timer: number | undefined;

const remaining = computed(() => Math.max(
  0,
  Math.ceil(((session.value ? new Date(session.value.expiresAt).getTime() : 0) - clock.value) / 1000),
));
const remainingText = computed(() =>
  `${String(Math.floor(remaining.value / 60)).padStart(2, "0")}:${String(remaining.value % 60).padStart(2, "0")}`,
);
const canFinish = computed(() => loginPresentation.value === "vnc"
  ? Boolean(frameUrl.value)
  : ["ready", "active"].includes(session.value?.status ?? ""));

async function refresh() {
  if (!session.value) return;
  session.value = await api.login(session.value.id);
  if (loginPresentation.value === "vnc" &&
      ["starting", "ready", "active"].includes(session.value.status) &&
      !frameUrl.value) {
    frameUrl.value = accessUrl.value;
  }
  if (session.value.status === "completed") {
    emit("completed");
    emit("close");
  }
}

watch(() => props.open, async (open) => {
  if (!open || !props.runId) return;
  error.value = "";
  frameUrl.value = "";
  try {
    loginPresentation.value = (await api.settings()).loginPresentation;
    const created = await api.createLogin(props.runId);
    session.value = created.session;
    accessUrl.value = created.accessUrl ?? "";
    timer = window.setInterval(() => {
      clock.value = Date.now();
      void refresh().catch((value) => {
        error.value = value instanceof Error ? value.message : "登录会话更新失败";
      });
    }, 1000);
  } catch (value) {
    error.value = value instanceof Error ? value.message : "无法创建登录会话";
  }
});
watch(() => props.open, (open) => {
  if (!open && timer) {
    clearInterval(timer);
    timer = undefined;
  }
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

async function finish() {
  if (!session.value) return;
  await api.completeLogin(session.value.id);
  session.value = await api.login(session.value.id);
}
async function extend() {
  if (!session.value) return;
  await api.extendLogin(session.value.id);
  await refresh();
}
async function cancel() {
  if (session.value) await api.cancelLogin(session.value.id);
  emit("close");
}
</script>

<template>
  <div v-if="open" class="modal-backdrop login-backdrop">
    <section class="login-modal">
      <header>
        <div>
          <span>安全登录窗口</span>
          <h2>{{ loginPresentation === "external-window" ? "在 Edge 中完成登录" : "在远程浏览器中完成登录" }}</h2>
        </div>
        <div class="login-clock"><i class="mdi mdi-timer-outline"></i>{{ remainingText }}</div>
      </header>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-else-if="loginPresentation === 'external-window'" class="external-login">
        <i class="mdi mdi-microsoft-edge"></i>
        <strong>{{ canFinish ? "Edge 登录窗口已打开" : "正在启动 Edge 登录窗口" }}</strong>
        <small>请在弹出的 Edge 窗口中完成登录并导航到投递状态页面，然后返回这里保存登录状态。</small>
      </div>
      <div v-else-if="!frameUrl" class="login-loading">
        <span class="spinner"></span>
        <strong>正在准备远程浏览器</strong>
        <small>通常需要几秒钟，请保持此窗口打开。</small>
      </div>
      <iframe
        v-if="loginPresentation === 'vnc' && frameUrl"
        :src="frameUrl"
        title="招聘网站远程登录浏览器"
        allow="clipboard-read; clipboard-write"
      ></iframe>
      <footer>
        <p>完成登录后，请导航到当前岗位的投递状态页面，再点击“完成并重新检查”。</p>
        <div>
          <button class="secondary-button" @click="cancel">取消</button>
          <button class="secondary-button" @click="extend">延长 15 分钟</button>
          <button class="primary-button" :disabled="!canFinish" @click="finish">完成并重新检查</button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.login-modal { width: min(1180px, calc(100vw - 60px)); height: calc(100vh - 60px); padding: 20px; display: grid; grid-template-rows: auto 1fr auto; border-radius: 14px; background: #fffdf8; box-shadow: 0 28px 80px #0c201c42; }
.login-modal header { display: flex; justify-content: space-between; align-items: flex-start; padding: 0 2px 16px; }
.login-modal header span { color: #c16638; font-size: 10px; font-weight: 700; letter-spacing: .16em; }
.login-modal h2 { margin: 5px 0 0; font: 700 20px "Noto Serif SC", serif; color: var(--forest); }
.login-clock { display: flex; align-items: center; gap: 7px; padding: 8px 11px; border-radius: 7px; background: #f5efe2; color: #7c694f; font: 600 13px monospace; }
.login-modal iframe { width: 100%; height: 100%; border: 0; border-radius: 9px; background: #101817; }
.login-loading, .external-login { height: 100%; display: grid; place-content: center; justify-items: center; gap: 10px; border-radius: 9px; text-align: center; }
.login-loading { background: #101817; color: white; }
.login-loading small { color: #9fb0aa; }
.external-login { padding: 40px; background: #f3f7f5; color: var(--forest); }
.external-login i { font-size: 56px; color: #0b78d0; }
.external-login small { max-width: 520px; color: #66736d; line-height: 1.7; }
.login-modal footer { padding: 15px 2px 0; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.login-modal footer p { margin: 0; color: #707a75; font-size: 11px; }
.login-modal footer > div { display: flex; gap: 8px; white-space: nowrap; }
.error-banner { padding: 14px; align-self: center; color: #9e3f31; background: #fbe8e4; border-radius: 8px; text-align: center; }
</style>
