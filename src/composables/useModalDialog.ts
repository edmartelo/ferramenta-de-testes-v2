import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue';

const FOCUSABLE = 'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Modais abertos, o último é o de cima: só ele prende o Tab (modal dentro de modal). */
const openDialogs: Ref<HTMLElement | null>[] = [];

function trapTab(event: KeyboardEvent): void {
  const dialog = openDialogs.at(-1)?.value;
  if (event.key !== 'Tab' || !dialog) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (!dialog.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Foca o primeiro campo do modal ao abrir, prende o Tab dentro dele e devolve o foco a quem estava antes ao fechar/desmontar. */
export function useModalDialog(dialog: Ref<HTMLElement | null>, isOpen: () => boolean = () => true) {
  let previousFocus: HTMLElement | null = null;

  function release(): void {
    const index = openDialogs.indexOf(dialog);
    if (index === -1) return;
    openDialogs.splice(index, 1);
    if (!openDialogs.length) document.removeEventListener('keydown', trapTab, true);
  }

  function restoreFocus(): void {
    release();
    previousFocus?.focus();
    previousFocus = null;
  }

  watch(
    isOpen,
    (open) => {
      if (!open) {
        restoreFocus();
        return;
      }
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!openDialogs.includes(dialog)) {
        if (!openDialogs.length) document.addEventListener('keydown', trapTab, true);
        openDialogs.push(dialog);
      }
      nextTick(() => dialog.value?.querySelector<HTMLElement>(FOCUSABLE)?.focus());
    },
    { immediate: true },
  );

  onBeforeUnmount(restoreFocus);
}
