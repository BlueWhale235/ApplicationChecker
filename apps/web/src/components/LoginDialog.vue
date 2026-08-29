<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { LoginSessionSummary, NextLoginSummary } from "@application-checker/contracts";
import { api } from "../api";

const props = defineProps<{ open: boolean; runId: string | null }>();
const emit = defineEmits<{ close: []; completed: [] }>();
const session = ref<LoginSessionSummary | null>(null);
const accessUrl = ref("");
const frameUrl = ref("");
const loginPresentation = ref<"vnc" | "external-window">("vnc");
const error = ref("");
const clock = ref(Date.now());
const nextLogin = ref<NextLoginSummary | null>(null);
const activeRunId = ref<string | null>(null);
const replacedExisting = ref(false);
let completedSessionId: string | null = null;
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
    if (completedSessionId === session.value.id) return;
    completedSessionId = session.value.id;
    emit("completed");
    nextLogin.value = activeRunId.value ? await api.nextLogin(activeRunId.value) : null;
    if (!nextLogin.value) emit("close");
  }
}

async function createSession(runId: string) {
  completedSessionId = null;
  activeRunId.value = runId;
  nextLogin.value = null;
  frameUrl.value = "";
  const created = await api.createLogin(runId);
  replacedExisting.value = created.replacedExisting;
  session.value = created.session;
  accessUrl.value = created.accessUrl ?? "";
}

watch(() => props.open, async (open) => {
  if (!open || !props.runId) return;
  error.value = "";
  frameUrl.value = "";
  nextLogin.value = null;
  replacedExisting.value = false;
  try {
    loginPresentation.value = (await api.settings()).loginPresentation;
    await createSession(props.runId);
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
async function continueNext() {
  if (!nextLogin.value) return;
  error.value = "";
  try {
    await createSession(nextLogin.value.runId);
  } catch (value) {
    error.value = value instanceof Error ? value.message : "无法打开下一个登录任务";
  }
}
async function extend() {
  if (!session.value) return;
  await api.extendLogin(session.value.id);
  await refresh();
}
async function cancel() {
  if (session.value && session.value.status !== "completed") await api.cancelLogin(session.value.id);
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
          <div v-if="replacedExisting" class="replacement-banner">
            <i class="mdi mdi-swap-horizontal"></i>已关闭上一个登录窗口，正在打开当前网站。
          </div>
        </div>
        <div class="login-clock"><i class="mdi mdi-timer-outline"></i>{{ remainingText }}</div>
      </header>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-else-if="nextLogin" class="next-login">
        <i class="mdi mdi-check-circle-outline"></i>
        <strong>当前网站登录状态已保存</strong>
        <p>还有一个网站需要登录：</p>
        <div><b>{{ nextLogin.company }}</b><span>{{ nextLogin.jobTitle }}</span><small>{{ nextLogin.site }}</small></div>
      </div>
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
        v-if="loginPresentation === 'vnc' && frameUrl && !nextLogin"
        :src="frameUrl"
        title="招聘网站远程登录浏览器"
        allow="clipboard-read; clipboard-write"
      ></iframe>
      <footer>
        <p v-if="nextLogin">确认继续后会复用当前登录浏览器，并打开下一个网站。</p>
        <p v-else>完成登录后，请导航到当前岗位的投递状态页面，再点击“完成并重新检查”。</p>
        <div>
          <button class="secondary-button" @click="cancel">取消</button>
          <button v-if="!nextLogin" class="secondary-button" @click="extend">延长 15 分钟</button>
          <button v-if="nextLogin" class="primary-button" @click="continueNext">继续处理下一个</button>
          <button v-else class="primary-button" :disabled="!canFinish" @click="finish">完成并重新检查</button>
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
.login-loading, .external-login, .next-login { height: 100%; display: grid; place-content: center; justify-items: center; gap: 10px; border-radius: 9px; text-align: center; }
.login-loading { background: #101817; color: white; }
.login-loading small { color: #9fb0aa; }
.external-login { padding: 40px; background: #f3f7f5; color: var(--forest); }
.external-login i { font-size: 56px; color: #0b78d0; }
.external-login small { max-width: 520px; color: #66736d; line-height: 1.7; }
.next-login { padding: 40px; background: #f3f7f5; color: var(--forest); }
.next-login > i { font-size: 56px; color: #479069; }
.next-login p { margin: 6px 0 0; color: #66736d; }
.next-login > div { display: grid; min-width: 360px; gap: 4px; padding: 16px 20px; border: 1px solid #d7e4dd; border-radius: 9px; background: white; }
.next-login > div span, .next-login > div small { color: #66736d; }
.login-modal footer { padding: 15px 2px 0; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.login-modal footer p { margin: 0; color: #707a75; font-size: 11px; }
.login-modal footer > div { display: flex; gap: 8px; white-space: nowrap; }
.error-banner { padding: 14px; align-self: center; color: #9e3f31; background: #fbe8e4; border-radius: 8px; text-align: center; }
.replacement-banner { margin-top: 9px; padding: 9px 12px; border-radius: 7px; background: #edf5f1; color: #39745a; font-size: 11px; }
.replacement-banner i { margin-right: 6px; }
</style>
