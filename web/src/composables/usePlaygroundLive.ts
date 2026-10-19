import { ref } from 'vue';

/**
 * Live text of the message currently being streamed.
 *
 * Kept outside the view component on purpose: streaming writes here ~28 times
 * per second, and only the leaf component that renders this text should
 * re-render. The parent (the whole playground page) must not.
 */
const active = ref(false);
const content = ref('');

export function beginLive(): void {
  content.value = '';
  active.value = true;
}

export function updateLive(text: string): void {
  content.value = text;
}

export function endLive(): void {
  active.value = false;
  content.value = '';
}

export function usePlaygroundLive() {
  return { active, content };
}
