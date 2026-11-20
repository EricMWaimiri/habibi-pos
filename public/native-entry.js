'use strict';
// Native keyboards remain controlled by the device/browser. Never replace
// inputs, steal focus, change values, or replay writes during viewport changes.
(function () {
 function annotate(input) {
  if (!input || input.tagName !== 'INPUT' || input.hasAttribute('inputmode')) return;
  const type = input.type;
  if (type === 'number') input.setAttribute('inputmode', input.step === '1' ? 'numeric' : 'decimal');
  else if (type === 'search') input.setAttribute('inputmode', 'search');
  else if (type === 'tel') input.setAttribute('inputmode', 'tel');
  else if (type === 'email') input.setAttribute('inputmode', 'email');
 }
 function reveal() {
  const input = document.activeElement, viewport = window.visualViewport;
  if (!viewport || !window.matchMedia('(pointer: coarse)').matches || !input?.matches('input,textarea,select')) return;
  const rect = input.getBoundingClientRect(), top = viewport.offsetTop, bottom = top + viewport.height;
  if (rect.bottom > bottom - 12 || rect.top < top + 12) input.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});
 }
 document.addEventListener('focusin', event => { annotate(event.target); requestAnimationFrame(reveal); });
 window.visualViewport?.addEventListener('resize', () => requestAnimationFrame(reveal));
})();
