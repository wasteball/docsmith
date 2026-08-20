const fail=(message)=>{window.__domPurifyFailClosedSmoke={error:String(message)};document.body.dataset.rendered='error';document.title=String(message)};
const frame=document.createElement('iframe');frame.src='../src/views/markdown/index.html';
frame.addEventListener('load',()=>{const win=frame.contentWindow,doc=frame.contentDocument,started=Date.now();
  (function wait(){if(win.MDW&&win.DOMPurify&&doc.querySelector('#srcBtn')){run();return}if(Date.now()-started>20000)return fail('工作台或 DOMPurify 没有启动');setTimeout(wait,60)})();
  async function run(){const original=win.DOMPurify.sanitize;try{
    const raw='<img src=x onerror="window.__unsafeRan=1"><script>window.__unsafeRan=2<\/script>';
    win.__unsafeRan=0;

    // 全量 renderMarkdown：setText 走整篇渲染。
    win.DOMPurify.sanitize=()=>{throw new Error('full sanitizer fault')};
    win.MDW.setText(raw);
    let preview=win.MDW.getPreviewRoot();
    if(!preview.querySelector(':scope > .raw-fallback')||preview.querySelector('img,script')||!preview.textContent.includes(raw)||win.__unsafeRan)throw new Error('全量渲染没有失败关闭');

    // patchBlock：同样数量、同样类型的单段替换会进入局部块更新。
    win.DOMPurify.sanitize=original;
    win.MDW.setText('安全旧段');
    const editor=doc.querySelector('#editor');
    doc.querySelector('#editBtn').click();
    const oldBlock=preview.querySelector('.blk[data-blk="0"]');
    oldBlock.dispatchEvent(new win.MouseEvent('click',{bubbles:true,clientX:oldBlock.getBoundingClientRect().left+8,clientY:oldBlock.getBoundingClientRect().top+8}));
    oldBlock.innerHTML='<p><b>patch-marker</b></p>';
    win.DOMPurify.sanitize=()=>{throw new Error('patch sanitizer fault')};
    doc.body.setAttribute('tabindex','-1');doc.body.focus();
    oldBlock.dispatchEvent(new win.FocusEvent('focusout',{bubbles:true,relatedTarget:doc.body}));
    await new Promise(r=>setTimeout(r,50));
    const block=preview.querySelector('.blk[data-blk="0"]');
    const patchFallback=block?.querySelector('.raw-fallback')||preview.querySelector(':scope > .raw-fallback');
    if(!patchFallback||preview.querySelector('img,script')||!patchFallback.textContent.includes('patch-marker')||win.__unsafeRan)throw new Error('局部 patch 没有失败关闭：'+preview.innerHTML);

    // renderBlockSafe：制造“原来”回放卡片，旧块必须走同一失败关闭策略。
    win.DOMPurify.sanitize=original;
    win.MDW.setText(raw);
    doc.querySelector('#srcBtn').click();editor.value='现在的安全段';editor.setSelectionRange(editor.value.length,editor.value.length);doc.querySelector('#srcBtn').click();
    win.DOMPurify.sanitize=()=>{throw new Error('ghost sanitizer fault')};
    const change=preview.querySelector('.blk[data-chg]');if(change)change.click();
    doc.dispatchEvent(new win.KeyboardEvent('keydown',{bubbles:true,altKey:true,key:'ArrowDown'}));await new Promise(r=>setTimeout(r,20));
    const ghost=preview.querySelector('.chg-diff .cd-ghost');
    if(!ghost||!ghost.querySelector('.raw-fallback')||ghost.querySelector('img,script')||!ghost.textContent.includes(raw)||win.__unsafeRan)throw new Error('审阅回放没有失败关闭：'+preview.innerHTML);

    win.DOMPurify.sanitize=original;
    window.__domPurifyFailClosedSmoke={ready:true,full:true,patch:true,ghost:true,unsafeRan:win.__unsafeRan};
    document.body.dataset.rendered='true';document.title=JSON.stringify(window.__domPurifyFailClosedSmoke);
  }catch(error){win.DOMPurify.sanitize=original;fail(error.message||error)}}
});document.querySelector('#mount').append(frame);
