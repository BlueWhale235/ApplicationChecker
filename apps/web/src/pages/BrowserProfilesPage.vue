<script setup lang="ts">
import type { BrowserProfileSummary } from "@application-checker/contracts";

defineProps<{ profiles: BrowserProfileSummary[] }>();
defineEmits<{ remove: [site: string] }>();
</script>

<template>
  <section class="page-content narrow-page">
    <div class="page-heading"><div><h1>浏览器状态</h1><p>登录信息按招聘网站加密保存，仅在本机使用。</p></div></div>
    <div class="content-card">
      <div class="card-title"><div><h2>已保存的网站</h2><p>清除后，下次检查该网站时可能需要重新登录。</p></div><span>{{ profiles.length }} 个</span></div>
      <div v-if="profiles.length" class="profile-list">
        <article v-for="profile in profiles" :key="profile.site">
          <div class="profile-icon"><i class="mdi mdi-web"></i></div>
          <div><strong>{{ profile.site }}</strong><span>{{ profile.cookieCount }} 个 Cookie · 版本 {{ profile.version }}</span></div>
          <time>{{ new Date(profile.updatedAt).toLocaleString("zh-CN") }}</time>
          <v-btn color="error" variant="text" size="small" @click="$emit('remove', profile.site)">清除</v-btn>
        </article>
      </div>
      <div v-else class="settings-empty">
        <i class="mdi mdi-cookie-off-outline"></i><strong>尚未保存登录状态</strong>
        <span>首次检查需要登录的网站时，可以通过远程浏览器完成登录。</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.narrow-page { max-width: 1050px; }
.content-card { padding: 27px; border: 1px solid var(--border); border-radius: 12px; background: #fffdf8; box-shadow: 0 10px 32px #183a3708; }
.card-title { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 23px; }
.card-title h2 { margin: 0; font: 600 19px "Noto Serif SC", serif; color: #25352f; }
.card-title p { margin: 6px 0 0; color: #7a837f; font-size: 11px; }
.card-title > span { color: #71807a; font-size: 11px; }
.profile-list { display: grid; }
.profile-list article { min-height: 74px; display: grid; grid-template-columns: 42px 1fr auto auto; align-items: center; gap: 13px; border-top: 1px solid #ece6da; }
.profile-icon { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 9px; background: #e8f0eb; color: #326450; font-size: 20px; }
.profile-list strong, .profile-list span { display: block; }
.profile-list strong { font-size: 13px; }
.profile-list span { margin-top: 4px; color: #87908b; font-size: 10px; }
.profile-list time { color: #7e8983; font-size: 10px; }
.settings-empty { min-height: 280px; display: grid; place-content: center; justify-items: center; color: #7d8983; text-align: center; }
.settings-empty i { font-size: 40px; }
.settings-empty strong { margin-top: 9px; color: #405049; }
.settings-empty span { margin-top: 5px; font-size: 11px; }
</style>
