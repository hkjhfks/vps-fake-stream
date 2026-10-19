<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue';
import type { UiMessage } from './types';

defineProps<{
  message: UiMessage;
  canRegenerate: boolean;
}>();

const emit = defineEmits<{
  copy: [content: string];
  regenerate: [];
}>();
</script>

<template>
  <div class="msg" :class="{ 'msg-user': message.role === 'user' }">
    <template v-if="message.role === 'user'">
      <div class="msg-bubble">{{ message.content }}</div>
    </template>
    <template v-else>
      <span class="msg-avatar"><AppIcon name="waveform" :size="13" /></span>
      <div class="msg-main">
        <div class="msg-meta">
          <strong>FakeStream</strong>
          <span>{{ message.model }}</span>
          <span v-if="message.aborted" class="pill">已停止</span>
        </div>

        <div v-if="message.error" class="stream-error">
          <AppIcon name="alert" :size="13" />
          <span>{{ message.error }}</span>
        </div>

        <!-- `html` is produced once, when the message is finalised, so Vue skips
             the innerHTML write entirely on later renders. -->
        <div class="md-content" v-html="message.html" />

        <div v-if="message.content" class="msg-actions">
          <button type="button" class="msg-action" @click="emit('copy', message.content)">
            <AppIcon name="copy" :size="11" /> 复制
          </button>
          <button type="button" class="msg-action" :disabled="!canRegenerate" @click="emit('regenerate')">
            <AppIcon name="rotate" :size="11" /> 重新生成
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
