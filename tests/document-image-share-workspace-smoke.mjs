const fail=(message)=>{window.__documentImageShareSmoke={error:String(message)};document.body.dataset.rendered='error';document.title=String(message)};
const frame=document.createElement('iframe');frame.src='../src/views/markdown/index.html';
frame.addEventListener('load',()=>{const win=frame.contentWindow,doc=frame.contentDocument,started=Date.now();
  (function wait(){if(win.MDW&&win.DocsmithDocumentImage&&doc.querySelector('.ex-split')){run();return}if(Date.now()-started>20000)return fail('工作台或导出菜单没有启动');setTimeout(wait,60)})();
  async function waitFor(selector,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){const hit=doc.querySelector(selector);if(hit)return hit;await new Promise(r=>setTimeout(r,100))}throw new Error('等待界面超时：'+selector)}
  async function run(){try{
    const uploads=[],history=[],events=[],downloads=[],copies=[];let uploadSeq=0,failNext=false,cloudReady=true,autoCopy=false;
    const originalCreateObjectURL=win.URL.createObjectURL.bind(win.URL),originalAnchorClick=win.HTMLAnchorElement.prototype.click;
    win.URL.createObjectURL=(blob)=>{const url=originalCreateObjectURL(blob);downloads.push({url,blob,name:''});return url};
    win.HTMLAnchorElement.prototype.click=function(){const hit=downloads.find(x=>x.url===this.href);if(hit)hit.name=this.download||''};
    try{Object.defineProperty(win.navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copies.push(text)}}})}catch(e){}
    win.DSCloud={ready:()=>cloudReady,problem:()=>cloudReady?'':'请先配置云存储',autoCopy:()=>autoCopy,formatShare:(n,u)=>`${n}\n${u}`,
      hasUrl:(url)=>history.some(x=>x.downUrl===url),recordHistory:(rec)=>{const id='history-'+history.length;history.push({...rec,id});return id},
      upload:async(blob,name,onProgress)=>{onProgress?.(25);if(failNext){failNext=false;uploads.push({name,type:blob.type,size:blob.size,failed:true});throw new Error('模拟断网')}onProgress?.(100);const r={url:`https://share.example/${++uploadSeq}/${name}`,id:`id-${uploadSeq}`,name,size:blob.size,autoCopy:false};uploads.push({name,type:blob.type,size:blob.size});history.push({downUrl:r.url,fileName:name,id:r.id});return r},gotoFiles:()=>{},openSettings:()=>{}};
    win.addEventListener('docsmith:export',e=>events.push('export:'+e.detail.format));
    win.addEventListener('docsmith:share',e=>events.push('share:'+e.detail.kind));

    const longSource='# 单图导出回归\n\n'+Array.from({length:85},(_,i)=>`第 ${i+1} 段：${'长文内容'.repeat(20)}`).join('\n\n');
    win.MDW.setText(longSource);
    const caret=doc.querySelector('.ex-caret');caret.click();
    const pngItem=doc.querySelector('.ex-item[data-fmt="png"]');
    if(!pngItem||pngItem.classList.contains('off'))throw new Error('导出菜单没有可用的 PNG 格式');
    if(!doc.querySelector('.ex-item[data-fmt="html"]')||!doc.querySelector('.ex-item[data-fmt="docx"]')||!doc.querySelector('.ex-item[data-fmt="pdf"]'))throw new Error('既有导出格式丢失');
    pngItem.click();
    const exportEnd=Date.now()+120000;while(!downloads.some(x=>x.name.endsWith('.png'))&&Date.now()<exportEnd)await new Promise(r=>setTimeout(r,100));
    const imageDownload=downloads.find(x=>x.name.endsWith('.png'));
    if(!imageDownload||imageDownload.blob.type!=='image/png'||/-\d{2}\.png$/.test(imageDownload.name))throw new Error('整篇文档没有导出成一张 PNG');
    const imageBitmap=await win.createImageBitmap(imageDownload.blob);const exportedSize=[imageBitmap.width,imageBitmap.height];imageBitmap.close();
    if(exportedSize[1]<=8192)throw new Error('长文 fixture 没有覆盖超长单图路径：'+exportedSize.join('×'));
    if(downloads.some(x=>x.name.endsWith('.zip'))||downloads.filter(x=>x.name.endsWith('.png')).length!==1)throw new Error('一个 Markdown 导出了多个文件');
    if(events.filter(x=>x==='export:png').length!==1)throw new Error('PNG 导出业务事件不是一次');
    if(doc.querySelector('.ex-split').classList.contains('busy')||doc.querySelector('.ex-main-btn').disabled||doc.querySelector('.ex-caret').disabled)throw new Error('导出完成后 busy 状态没有恢复');
    win.DSPalette.open();const paletteInput=doc.querySelector('.cp-root input');paletteInput.value='png';paletteInput.dispatchEvent(new win.Event('input',{bubbles:true}));
    if(![...doc.querySelectorAll('.cp-item .cp-title')].some(x=>x.textContent==='导出图片'))throw new Error('命令面板没有 PNG 导出入口');win.DSPalette.close();

    win.MDW.setText('# 图片菜单回归\n\n短文内容');doc.querySelector('#shareBtn').click();
    if(!doc.querySelector('#pickHtml')||!doc.querySelector('#pickMd')||!doc.querySelector('#pickImage'))throw new Error('分享选择器格式不完整');
    if(!doc.querySelector('#pickImage').textContent.includes('一张长图'))throw new Error('图片分享文案仍暗示多图');
    win.ShareCache.put('legacy-shape',{url:'https://legacy.example/file',id:'old-id',name:'old.html',size:9});
    const oldShape=win.ShareCache.get('legacy-shape');
    if(oldShape?.url!=='https://legacy.example/file')throw new Error('单文件分享缓存结构不兼容');
    doc.querySelector('#pickImage').click();await waitFor('#shareCopy');
    if(uploads.length!==1||uploads[0].type!=='image/png'||!uploads[0].name.endsWith('.png'))throw new Error('单图上传参数错误');
    if(doc.querySelectorAll('#shareUrl').length!==1||events.filter(x=>x==='share:png').length!==1)throw new Error('单图分享结果错误');
    doc.querySelector('#shareCopy').click();await new Promise(r=>setTimeout(r,30));
    if(copies.length&&(!copies.at(-1).includes('document.png')||!copies.at(-1).includes('https://share.example/')))throw new Error('复制图片链接内容错误');
    history.length=0;doc.querySelector('#shareBack').click();doc.querySelector('#pickImage').click();await waitFor('.share-ok.reused');
    if(uploads.length!==1||events.filter(x=>x==='share:png').length!==2)throw new Error('图片分享缓存没有复用');
    if(history.length!==1||!history[0].downUrl?.includes('https://share.example/'))throw new Error('缓存链接缺少文件库历史时没有补记录');
    doc.querySelector('#shareRegen').click();const forceEnd=Date.now()+90000;while(uploads.length<2&&Date.now()<forceEnd)await new Promise(r=>setTimeout(r,100));
    if(uploads.length!==2||uploads[1].failed)throw new Error('强制重新上传没有生成新链接');

    autoCopy=true;const copiesBeforeAuto=copies.length;win.MDW.applyReadingSetting('size',19);const backForPixels=await waitFor('#shareBack');backForPixels.click();doc.querySelector('#pickImage').click();
    const pixelMissEnd=Date.now()+90000;while(uploads.length<3&&Date.now()<pixelMissEnd)await new Promise(r=>setTimeout(r,100));
    if(uploads.length!==3||uploads[2].failed)throw new Error('最终像素变化仍复用了旧 PNG 链接');
    if(copies.length!==copiesBeforeAuto+1||!copies.at(-1).includes('document.png'))throw new Error('图片分享自动复制内容错误');
    autoCopy=false;win.MDW.applyReadingSetting('size',16);

    (await waitFor('#shareBack')).click();cloudReady=false;const beforeMissing=uploads.length;doc.querySelector('#pickImage').click();await new Promise(r=>setTimeout(r,30));
    if(uploads.length!==beforeMissing||!doc.querySelector('#shareBody').textContent.includes('请先配置云存储'))throw new Error('云未配置路径没有阻止图片分享');
    cloudReady=true;doc.querySelector('#shareBtn').click();

    win.MDW.setText(longSource);doc.querySelector('#pickImage').click();await waitFor('#shareCopy',120000);
    const longUploads=uploads.slice(3);
    if(longUploads.length!==1||longUploads[0].failed||/-\d{2}\.png$/.test(longUploads[0].name))throw new Error('长文分享没有只上传一张 PNG：'+JSON.stringify(longUploads));
    if(doc.querySelectorAll('#shareUrl').length!==1)throw new Error('长文分享返回了多个链接');

    doc.querySelector('#shareBack').click();win.MDW.setText('# 上传失败回归\n\n失败内容');failNext=true;doc.querySelector('#pickImage').click();await waitFor('.share-err',90000);
    if(!doc.querySelector('#shareBody').textContent.includes('模拟断网')||events.filter(x=>x==='share:png').length!==5)throw new Error('单图上传失败没有准确关闭：'+doc.querySelector('#shareBody').textContent+' · '+events.join(','));

    win.URL.createObjectURL=originalCreateObjectURL;win.HTMLAnchorElement.prototype.click=originalAnchorClick;
    window.__documentImageShareSmoke={ready:true,formats:['html','docx','png','pdf'],shareKinds:['html','md','png'],uploads,download:{name:imageDownload.name,type:imageDownload.blob.type,size:exportedSize},imagesPerDocument:1,linksPerShare:1,commandPalette:true,legacyCache:true,historyRepaired:true,autoCopy:true,cacheReused:true,forcedUpload:true,pixelCacheMiss:true,missingCloud:true,longDocumentSingleUpload:true,uploadFailure:true,copies:copies.length,events};
    document.body.dataset.rendered='true';document.title=JSON.stringify(window.__documentImageShareSmoke);
  }catch(error){fail(error.message||error)}}
});document.querySelector('#mount').append(frame);
