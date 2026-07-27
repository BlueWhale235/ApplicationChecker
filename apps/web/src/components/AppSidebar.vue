<script setup lang="ts">
type Page = "progress" | "notifications" | "tasks" | "profiles" | "settings" | "debug";
defineProps<{ active: Page; runnerHealthy: boolean; unreadCount: number; debugEnabled: boolean }>();
defineEmits<{ change: [value: Page] }>();
</script>

<template>
  <aside class="sidebar">
    <div class="local-health">
      <div class="shield"><i class="mdi mdi-shield-check"></i></div>
      <div><strong>本地运行中</strong><small>浏览器：{{ runnerHealthy ? "正常" : "未连接" }}</small></div>
    </div>
    <nav class="nav-list">
      <button :class="{ active: active === 'progress' }" @click="$emit('change', 'progress')">
        <i class="mdi mdi-compass-outline"></i><span>投递进度</span>
      </button>
      <button :class="{ active: active === 'notifications' }" @click="$emit('change', 'notifications')">
        <i class="mdi mdi-bell-outline"></i><span>消息通知</span>
        <span v-if="unreadCount" class="nav-pill" :aria-label="`${unreadCount} 条未读消息`">{{ unreadCount > 99 ? "99+" : unreadCount }}</span>
      </button>
      <button :class="{ active: active === 'tasks' }" @click="$emit('change', 'tasks')">
        <i class="mdi mdi-progress-clock"></i><span>任务管理</span>
      </button>
      <button :class="{ active: active === 'profiles' }" @click="$emit('change', 'profiles')">
        <i class="mdi mdi-cookie-outline"></i><span>浏览器状态</span>
      </button>
      <button :class="{ active: active === 'settings' }" @click="$emit('change', 'settings')">
        <i class="mdi mdi-cog-outline"></i><span>设置</span>
      </button>
      <button v-if="debugEnabled" :class="{ active: active === 'debug' }" @click="$emit('change', 'debug')">
        <i class="mdi mdi-bug-outline"></i><span>AI 调试</span>
      </button>
    </nav>
    <div class="leaf-mark" aria-hidden="true">❧</div>
    <div class="privacy-note">
      <i class="mdi mdi-shield-lock-outline"></i>
      <div><strong>数据仅保存在本机</strong><small>隐私安全 · 安心使用</small></div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar { position: fixed; inset: 0 auto 0 0; width: 202px; padding: 22px 14px; background: linear-gradient(165deg, #0f403a 0%, #123c37 62%, #0d342f 100%); color: #f8f2e4; z-index: 20; display: flex; flex-direction: column; overflow: hidden; }
.local-health { display: flex; gap: 12px; align-items: center; padding: 8px 6px 26px; }
.shield { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: #3a8c5c; box-shadow: 0 0 0 5px #ffffff0a; }
.local-health strong, .local-health small { display: block; }
.local-health strong { font-size: 14px; font-weight: 500; }
.local-health small { margin-top: 3px; color: #acc0b9; font-size: 11px; }
.nav-list { margin: 4px -14px; display: grid; gap: 5px; }
.nav-list button { height: 52px; padding: 0 23px; border: 0; border-left: 3px solid transparent; background: transparent; color: #b8cbc4; display: flex; gap: 16px; align-items: center; text-align: left; transition: .18s ease; }
.nav-list button:hover { color: white; background: #ffffff09; }
.nav-list button.active { color: white; border-left-color: #d5723d; background: #f7f1df18; }
.nav-list i { width: 20px; font-size: 21px; }
.nav-list span { font-size: 14px; font-weight: 500; }
.nav-list .nav-pill { margin-left: auto; min-width: 24px; height: 20px; padding: 0 7px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; background: #d96a3a; color: #fff; font-size: 11px; font-weight: 700; box-shadow: 0 3px 10px #0003; }
.leaf-mark { position: absolute; left: 6px; bottom: 100px; color: #ffffff0b; font: 220px/1 serif; transform: rotate(-20deg); pointer-events: none; }
.privacy-note { margin-top: auto; padding: 12px 11px; display: flex; align-items: center; gap: 10px; border: 1px solid #d6b78566; background: #ffffff0b; border-radius: 9px; position: relative; }
.privacy-note i { font-size: 25px; color: #f0dfb7; }
.privacy-note strong, .privacy-note small { display: block; white-space: nowrap; }
.privacy-note strong { font-size: 11px; font-weight: 500; }
.privacy-note small { color: #a9bbb5; font-size: 9px; margin-top: 3px; }
</style>
