/** Advisory UI adaptation for the trusted product page. This is NOT the native
 * security boundary: exact document navigation and the own-build OS manifest
 * enforce the narrower capabilities. No native message bridge is installed. */
export const MOBILE_CAPABILITY_SCRIPT = `(() => {
  if (window.__opendotsMobileLimited) return true;
  window.__opendotsMobileLimited = true;
  const selector = '[data-action="voice"],[data-voice],[data-read-aloud],.attachment-picker,input[type="file"],a[download],.artifact-download';
  const explanation = '手机端暂不支持麦克风与文件传输，请使用电脑端';
  const disable = () => document.querySelectorAll(selector).forEach(el => {
    if ('disabled' in el && !el.disabled) el.disabled = true;
    if (el.getAttribute('aria-disabled') !== 'true') el.setAttribute('aria-disabled','true');
    if (el.getAttribute('title') !== explanation) el.setAttribute('title',explanation);
    if (el.style.opacity !== '0.45') el.style.opacity = '0.45';
    if (el.getAttribute('tabindex') !== '-1') el.setAttribute('tabindex','-1');
  });
  const stop = event => { const target = event.target instanceof Element ? event.target.closest(selector) : null; if(target){event.preventDefault();event.stopImmediatePropagation();} };
  document.addEventListener('click',stop,true);
  document.addEventListener('change',stop,true);
  const begin = () => { disable();new MutationObserver(disable).observe(document.documentElement,{childList:true,subtree:true}); };
  if(document.documentElement)begin();else document.addEventListener('DOMContentLoaded',begin,{once:true});
  return true;
})();true;`;
