const VERSION = "22.0.0-PWA";
const DB_KEY = "xinyu_gmail_agent_v20";
const AUDIT_KEY = "xinyu_gmail_agent_audit_v20";
let deferredInstallPrompt = null;
let currentFilter = "all";
let serviceWorkerStatus = "unsupported";
const modalDialog = document.getElementById("modal");

const STAGES = {
  imported:"已匯入", prechecked:"已預檢", candidateGenerated:"已產生候選",
  ready:"可處理", webInProgress:"流程中", waitingHuman:"等待本人",
  verifying:"驗證中", completed:"完成", failed:"異常", deferred:"延後"
};

function loadTasks(){ try{return JSON.parse(localStorage.getItem(DB_KEY)||"[]")}catch{return[]} }
function saveTasks(tasks){ localStorage.setItem(DB_KEY, JSON.stringify(tasks)); renderAll(); }
function loadAudit(){ try{return JSON.parse(localStorage.getItem(AUDIT_KEY)||"[]")}catch{return[]} }
function audit(type,message,taskId=null){
  const a=loadAudit(); a.unshift({id:crypto.randomUUID(),type,message,taskId,at:new Date().toISOString()});
  localStorage.setItem(AUDIT_KEY,JSON.stringify(a.slice(0,500)));
}
function now(){ return new Date().toISOString() }
function id(){ return crypto.randomUUID() }

function makeTask(fullName){
  return {id:id(),fullName,birthDate:null,gender:null,phone:null,candidateEmail:null,isEnabled:true,
    stage:"imported",retryCount:0,lastCheckpoint:null,lastError:null,createdAt:now(),updatedAt:now()};
}
function priority(t){
  let s={ready:100,failed:70,imported:60,prechecked:60,candidateGenerated:60,webInProgress:40,verifying:40,waitingHuman:20,deferred:10,completed:-1000}[t.stage]??0;
  return s-(t.retryCount*10)+(t.lastError?0:5)+(t.isEnabled?10:0);
}
function nextRunnable(tasks=loadTasks()){
  return [...tasks].filter(t=>t.isEnabled&&!["completed","waitingHuman","deferred"].includes(t.stage))
    .sort((a,b)=>priority(b)-priority(a))[0]||null;
}
function protectedSignal(text){
  text=(text||"").toLowerCase();
  return ["captcha","recaptcha","verify it's you","verify your identity","verification code","one-time code","otp","phone verification","security check","本人驗證","安全驗證","驗證碼","簡訊驗證"]
    .some(x=>text.includes(x));
}
function decide(t,signals=""){
  if(protectedSignal(signals)) return {intent:"waitForHuman",reason:"偵測到本人／安全驗證訊號",confidence:.99,requiresHuman:true};
  if(t.lastError && t.retryCount<3) return {intent:"recover",reason:"存在可恢復錯誤，優先執行 Recovery Policy",confidence:.85,requiresHuman:false};
  const map={
    imported:"precheckData",prechecked:"generateCandidate",candidateGenerated:"openWebWorkspace",ready:"openWebWorkspace",
    webInProgress:"verifyCompletion",waitingHuman:"waitForHuman",verifying:"verifyCompletion",failed:"recover",
    deferred:"inspectTask",completed:"complete"
  };
  return {intent:map[t.stage]||"inspectTask",reason:"依任務狀態機判定",confidence:.80,requiresHuman:t.stage==="waitingHuman"};
}
function translitBase(name){
  let s=(name||"user").toLowerCase().replace(/\s+/g,"");
  s=s.replace(/[^\p{L}\p{N}]/gu,"");
  return s.slice(0,16)||"user";
}
function generateCandidate(name){
  const y=String(new Date().getFullYear()).slice(-2);
  return `${translitBase(name)}${y}1`;
}
function runAction(taskId){
  const tasks=loadTasks(); const t=tasks.find(x=>x.id===taskId); if(!t)return;
  const d=decide(t);
  audit("agent_decision",JSON.stringify(d),t.id);
  switch(d.intent){
    case "precheckData":
      if(!t.fullName.trim()){t.stage="failed";t.lastError="姓名缺失"} else {t.stage="prechecked";t.lastCheckpoint="資料預檢完成";t.lastError=null}
      break;
    case "generateCandidate":
      t.candidateEmail=t.candidateEmail||generateCandidate(t.fullName);t.stage="candidateGenerated";t.lastCheckpoint="Gmail 候選名稱已產生";break;
    case "openWebWorkspace":
      t.stage="webInProgress";t.lastCheckpoint="準備進入 Google 官方註冊流程";break;
    case "verifyCompletion":
      t.stage="verifying";t.lastCheckpoint="等待實際可用性驗證";break;
    case "recover":
      t.retryCount++;
      if(t.retryCount>=3){t.stage="deferred";t.lastCheckpoint="重試達上限，已延後處理"}
      else {t.stage="ready";t.lastCheckpoint=`Recovery ${t.retryCount}/3 已排入安全重試`}
      break;
    case "waitForHuman": t.stage="waitingHuman";t.lastCheckpoint="等待本人完成 Google 安全驗證";break;
  }
  t.updatedAt=now(); saveTasks(tasks); showAgentDecision(t,d);
}
function runNext(){
  const t=nextRunnable(); if(!t){modal("AI Agent","目前沒有可安全自動處理的任務。");return}
  runAction(t.id);
}
function markHumanDone(id){
  const tasks=loadTasks(),t=tasks.find(x=>x.id===id); if(!t)return;
  t.stage="verifying";t.lastCheckpoint="本人安全驗證已完成，交回 AI";t.updatedAt=now();audit("human_gate_done","本人完成驗證",id);saveTasks(tasks);
}
function markCompleted(id){
  const tasks=loadTasks(),t=tasks.find(x=>x.id===id); if(!t)return;
  t.stage="completed";t.lastCheckpoint="已由使用者確認完成";t.updatedAt=now();audit("completed","任務完成",id);saveTasks(tasks);
}
function setHumanGate(id){
  const tasks=loadTasks(),t=tasks.find(x=>x.id===id); if(!t)return;
  t.stage="waitingHuman";t.lastCheckpoint="需要本人操作";t.updatedAt=now();audit("human_gate","轉入 Human Gate",id);saveTasks(tasks);
}
function removeTask(id){
  saveTasks(loadTasks().filter(x=>x.id!==id)); audit("delete","刪除任務",id);
}

function renderSummary(){
  const t=loadTasks();
  const metrics=[
    ["全部",t.length],["可處理",t.filter(x=>["ready","imported","prechecked","candidateGenerated"].includes(x.stage)).length],
    ["等待本人",t.filter(x=>x.stage==="waitingHuman").length],["完成",t.filter(x=>x.stage==="completed").length]
  ];
  summaryGrid.innerHTML=metrics.map(([k,v])=>`<div class="metric"><strong>${v}</strong><span>${k}</span></div>`).join("");
}
function badgeClass(stage){ return stage==="completed"?"ok":stage==="failed"?"danger":stage==="waitingHuman"?"warn":""}
function taskCard(t){
  return `<div class="task">
    <div class="task-top"><div><h3>${escapeHtml(t.fullName)}</h3><small>${escapeHtml(t.candidateEmail||"尚未產生 Gmail 候選")}</small></div>
      <span class="badge ${badgeClass(t.stage)}">${STAGES[t.stage]||t.stage}</span></div>
    ${t.lastCheckpoint?`<p><small>${escapeHtml(t.lastCheckpoint)}</small></p>`:""}
    ${t.lastError?`<p style="color:var(--danger)"><small>${escapeHtml(t.lastError)}</small></p>`:""}
    <div class="task-actions">
      ${!["completed","waitingHuman"].includes(t.stage)?`<button onclick="runAction('${t.id}')">AI 下一步</button>`:""}
      ${t.stage==="webInProgress"?`<button onclick="setHumanGate('${t.id}')">需要本人</button>`:""}
      ${t.stage==="waitingHuman"?`<button onclick="markHumanDone('${t.id}')">我已完成</button>`:""}
      ${t.stage==="verifying"?`<button onclick="markCompleted('${t.id}')">確認完成</button>`:""}
      <button onclick="removeTask('${t.id}')">刪除</button>
    </div>
  </div>`;
}
function renderTasks(){
  const t=loadTasks();
  const filtered=t.filter(x=>{
    if(currentFilter==="all")return true;
    if(currentFilter==="ready")return ["ready","imported","prechecked","candidateGenerated"].includes(x.stage);
    if(currentFilter==="human")return x.stage==="waitingHuman";
    if(currentFilter==="failed")return x.stage==="failed";
    if(currentFilter==="completed")return x.stage==="completed";
  });
  taskList.innerHTML=filtered.length?filtered.map(taskCard).join(""):`<div class="empty">目前沒有資料</div>`;
}
function renderHuman(){
  const t=loadTasks().filter(x=>x.stage==="waitingHuman");
  humanList.innerHTML=t.length?t.map(taskCard).join(""):`<div class="empty">目前沒有等待本人處理的任務</div>`;
}
function renderNext(){
  const t=nextRunnable();
  nextTaskCard.innerHTML=t?`${taskCard(t)}`:`<div class="empty">目前沒有可處理任務</div>`;
}
function renderAnalytics(){
  const t=loadTasks(),a=loadAudit();
  analytics.innerHTML=`<div class="grid">
    <div class="metric"><strong>${a.filter(x=>x.type==="agent_decision").length}</strong><span>Agent 決策</span></div>
    <div class="metric"><strong>${a.filter(x=>x.type==="human_gate").length}</strong><span>Human Gate</span></div>
    <div class="metric"><strong>${t.filter(x=>x.stage==="failed").length}</strong><span>異常</span></div>
    <div class="metric"><strong>${t.filter(x=>x.stage==="completed").length}</strong><span>完成</span></div>
  </div>`;
}
function renderAll(){renderSummary();renderTasks();renderHuman();renderNext();renderAnalytics()}
function showAgentDecision(t,d){
  agentDecision.innerHTML=`<p><strong>${escapeHtml(t.fullName)}</strong></p>
  <p>意圖：${escapeHtml(d.intent)}<br>信心：${Math.round(d.confidence*100)}%<br>原因：${escapeHtml(d.reason)}</p>`;
}
function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}

function navigate(id){
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.querySelectorAll(".bottom-nav button").forEach(b=>b.classList.toggle("active",b.dataset.nav===id));
  window.scrollTo(0,0);
}
function modal(title,html){
  modalTitle.textContent=title;modalBody.innerHTML=html;
  if(typeof modalDialog.showModal==="function") modalDialog.showModal();
  else modalDialog.setAttribute("open","");
}
function closeModal(){
  if(typeof modalDialog.close==="function") modalDialog.close();
  else modalDialog.removeAttribute("open");
}
function createDemo(){
  const tasks=loadTasks();
  ["王小明","陳怡君","林志豪","張雅婷","黃俊傑"].forEach(n=>tasks.push(makeTask(n)));
  saveTasks(tasks);audit("demo","建立測試資料");
}

function normalizeCell(value){
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\uFEFF/g, "")
    .replace(/[\u00A0\u3000]/g, " ")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[:：()（）\[\]【】「」"'`*＊]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}
function detectDelimiter(text){
  const sample = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(x=>x.trim()).slice(0,12);
  const candidates = [",","\t",";","|"];
  let best = ",", bestScore = -1;
  for(const d of candidates){
    const counts = sample.map(line => {
      let q=false,c=0;
      for(let i=0;i<line.length;i++){
        const ch=line[i];
        if(ch==='"') q=!q;
        else if(ch===d && !q) c++;
      }
      return c;
    });
    const nonZero = counts.filter(x=>x>0);
    if(!nonZero.length) continue;
    const avg = nonZero.reduce((a,b)=>a+b,0)/nonZero.length;
    const variance = nonZero.reduce((a,b)=>a+Math.abs(b-avg),0)/nonZero.length;
    const score = nonZero.length*10 + avg - variance;
    if(score>bestScore){bestScore=score;best=d}
  }
  return best;
}
function parseDelimitedLine(line, delimiter){
  const out=[]; let cur="", q=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){
      if(q && line[i+1]==='"'){cur+='"';i++}
      else q=!q;
    } else if(c===delimiter && !q){
      out.push(cur); cur="";
    } else cur+=c;
  }
  out.push(cur);
  return out.map(x=>x.replace(/^\uFEFF/,"").trim());
}
function parseCSV(text){
  text=String(text||"").replace(/^\uFEFF/,"");
  const delimiter=detectDelimiter(text);
  const lines=text.split(/\r?\n/);
  while(lines.length && !lines[lines.length-1].trim()) lines.pop();
  return lines.map(line=>parseDelimitedLine(line,delimiter));
}
const HEADER_ALIASES = {
  fullName:["姓名","姓名*","姓名(必填)","姓名（必填）","中文姓名","申請人姓名","申請姓名","申請者姓名","真實姓名","真實姓名*","使用者姓名","註冊人姓名","會員姓名","name","full name","fullname","user name","real name","chinese name"],
  birthDate:["生日","出生日期","出生年月日","birthdate","dateofbirth","dob"],
  gender:["性別","gender","sex"],
  phone:["手機","手機號碼","行動電話","電話","phone","mobile"],
  email:["gmail","電子郵件","email","候選gmail","候選信箱"],
  enabled:["是否啟用","啟用","enabled","active","是否使用"]
};
function headerMatchScore(row){
  const normalized=row.map(normalizeCell);
  let score=0;
  for(const [key,list] of Object.entries(HEADER_ALIASES)){
    if(normalized.some(h=>list.some(a=>{
      const na=normalizeCell(a);
      return Boolean(h && na) && (h===na || h.includes(na) || na.includes(h));
    }))) score += key==="fullName" ? 50 : 10;
  }
  return score;
}
function scanHeaderRows(rows){
  let bestIndex=-1,bestScore=-1;
  const limit=Math.min(rows.length,30);
  for(let i=0;i<limit;i++){
    if(!rows[i] || !rows[i].some(x=>String(x).trim())) continue;
    const score=headerMatchScore(rows[i]);
    if(score>bestScore){bestScore=score;bestIndex=i}
  }
  return {bestIndex,bestScore,scanned:limit};
}
function findHeaderRow(rows){
  const result=scanHeaderRows(rows);
  return result.bestScore>=50 ? result.bestIndex : -1;
}
function inferNameIndex(headers){
  const aliases=HEADER_ALIASES.fullName;
  const normalized=headers.map(normalizeCell);
  let idx=normalized.findIndex(h=>aliases.some(a=>{
    const na=normalizeCell(a);
    return Boolean(h && na) && (h===na || h.includes(na) || na.includes(h));
  }));
  if(idx<0) idx=normalized.findIndex(h=>h==="姓名" || h.endsWith("姓名"));
  return idx;
}
function delimiterLabel(delimiter){ return delimiter==="\t" ? "Tab" : delimiter }
function importDiagnostic(text,rows,scan){
  const delimiter=detectDelimiter(text);
  const preview=rows.slice(0,5).map((r,i)=>`第 ${i+1} 列：${r.join(" | ")}`).join("\n") || "（沒有內容）";
  return `<h4>AI 匯入診斷</h4>
    <p>偵測分隔符：<strong>${escapeHtml(delimiterLabel(delimiter))}</strong><br>
    掃描列數：${scan.scanned}<br>
    最佳表頭候選：${scan.bestIndex>=0?`第 ${scan.bestIndex+1} 列`:"無"}<br>
    最佳分數：${Math.max(0,scan.bestScore)}</p>
    <p>實際讀取前 5 列：</p><pre>${escapeHtml(preview)}</pre>`;
}
function aiAutoPrecheckTask(t,seenNames=new Set()){
  const nameKey=normalizeCell(t?.fullName);
  if(!nameKey){
    t.stage="failed";t.lastError="姓名缺失";t.lastCheckpoint="AI 預檢失敗：姓名缺失";t.updatedAt=now();
    audit("ai_precheck_failed",t.lastError,t.id);return false;
  }
  if(t.isEnabled===false){
    t.stage="failed";t.lastError="任務未啟用";t.lastCheckpoint="AI 預檢失敗：任務未啟用";t.updatedAt=now();
    audit("ai_precheck_failed",t.lastError,t.id);return false;
  }
  if(!Object.prototype.hasOwnProperty.call(STAGES,t.stage)){
    t.stage="failed";t.lastError="任務狀態無效";t.lastCheckpoint="AI 預檢失敗：任務狀態無效";t.updatedAt=now();
    audit("ai_precheck_failed",t.lastError,t.id);return false;
  }
  if(seenNames.has(nameKey)){
    t.stage="failed";t.lastError="同名任務重複";t.lastCheckpoint="AI 預檢失敗：同名任務重複";t.updatedAt=now();
    audit("ai_precheck_failed",t.lastError,t.id);return false;
  }
  t.stage="prechecked";t.lastError=null;t.lastCheckpoint="AI 自動預檢完成";t.updatedAt=now();
  audit("ai_precheck","AI 自動預檢完成",t.id);return true;
}
function aiAutoGenerateCandidate(t){
  if(!t.candidateEmail)t.candidateEmail=generateCandidate(t.fullName);
  t.stage="candidateGenerated";t.lastCheckpoint="AI 自動產生 Gmail 候選名稱";t.updatedAt=now();
  audit("ai_candidate",`AI 產生候選：${t.candidateEmail}`,t.id);return t.candidateEmail;
}
function aiPrepareImportedTasks(taskIds){
  const tasks=loadTasks(),idSet=new Set(taskIds);
  const seenNames=new Set(tasks.filter(t=>!idSet.has(t.id)).map(t=>normalizeCell(t.fullName)).filter(Boolean));
  let prechecked=0,failed=0,queued=0;
  for(const taskId of taskIds){
    const t=tasks.find(x=>x.id===taskId);if(!t){failed++;continue}
    if(!aiAutoPrecheckTask(t,seenNames)){failed++;continue}
    seenNames.add(normalizeCell(t.fullName));prechecked++;
    aiAutoGenerateCandidate(t);
    t.stage="ready";t.lastCheckpoint="AI 已完成資料準備，加入智慧任務佇列";t.updatedAt=now();queued++;
    audit("ai_queue","AI 已建立可處理任務",t.id);
  }
  saveTasks(tasks);
  return {tasks,prechecked,failed,queued};
}
function aiProcessSafeStep(t,signals="",failureMessage=""){
  if(protectedSignal(signals)){
    t.stage="waitingHuman";t.lastError=null;t.lastCheckpoint="偵測到本人／安全驗證，已保存 Checkpoint 並轉入 Human Gate";t.updatedAt=now();
    audit("human_gate",t.lastCheckpoint,t.id);return {status:"waitingHuman",requiresHuman:true};
  }
  if(failureMessage){
    t.retryCount=(t.retryCount||0)+1;t.lastError=failureMessage;t.updatedAt=now();
    if(t.retryCount>=3){t.stage="deferred";t.lastCheckpoint="Retry 3/3 仍失敗，已轉 Deferred / Exception Center"}
    else {t.stage="failed";t.lastCheckpoint=`Retry ${t.retryCount}/3 已排入安全重試`}
    audit("ai_retry",t.lastCheckpoint,t.id);return {status:t.stage,retryCount:t.retryCount};
  }
  t.stage="ready";t.lastError=null;t.lastCheckpoint="AI Agent 已接手，等待下一個可安全執行節點";t.updatedAt=now();
  audit("ai_takeover_step",t.lastCheckpoint,t.id);return {status:"ready",requiresHuman:false};
}
function aiTakeOverAfterImport(importedTaskIds){
  const prepared=aiPrepareImportedTasks(importedTaskIds);
  const queue=prepared.tasks.filter(t=>t.stage==="ready"&&t.isEnabled).sort((a,b)=>priority(b)-priority(a));
  if(queue[0])aiProcessSafeStep(queue[0]);
  saveTasks(prepared.tasks);
  audit("ai_takeover",`智慧匯入後 AI 接手 ${prepared.queued} 筆；失敗 ${prepared.failed} 筆`);
  const next=nextRunnable(prepared.tasks);
  if(next)showAgentDecision(next,{intent:"manageReadyQueue",reason:"智慧匯入完成，AI 已完成預檢、候選產生與優先排序",confidence:.95,requiresHuman:false});
  return {prechecked:prepared.prechecked,failed:prepared.failed,queued:prepared.queued};
}
async function importCSV(file){
  try{
    let text=await file.text();
    text=text.replace(/^\uFEFF/,"");
    const rows=parseCSV(text);
    const meaningful=rows.filter(r=>r.some(x=>String(x).trim()));
    if(meaningful.length<2){
      importStatus.textContent="沒有可匯入資料";
      return;
    }
    const scan=scanHeaderRows(rows);
    const headerIndex=findHeaderRow(rows);
    if(headerIndex<0){
      importStatus.textContent="AI 無法辨識姓名欄位；已建立欄位診斷。";
      modal("AI 匯入診斷",importDiagnostic(text,rows,scan));
      return;
    }
    const headers=rows[headerIndex];
    const nameIndex=inferNameIndex(headers);
    if(nameIndex<0){
      importStatus.textContent="AI 已找到表頭，但無法定位姓名欄位；已建立欄位診斷。";
      modal("AI 匯入診斷",importDiagnostic(text,rows,scan));
      return;
    }
    const tasks=loadTasks();
    const existingNames=new Set(tasks.map(t=>normalizeCell(t.fullName)));
    const importedTaskIds=[];
    let imported=0, skippedBlank=0, skippedDuplicate=0, errors=0;
    const dataRows=rows.slice(headerIndex+1);
    for(const row of dataRows){
      try{
        if(!row || !row.some(x=>String(x).trim())){skippedBlank++;continue}
        const name=(row[nameIndex]||"").replace(/^\uFEFF/,"").trim();
        if(!name){skippedBlank++;continue}
        const nk=normalizeCell(name);
        if(!nk){skippedBlank++;continue}
        if(existingNames.has(nk)){skippedDuplicate++;continue}
        const newTask=makeTask(name);
        tasks.push(newTask);importedTaskIds.push(newTask.id);
        existingNames.add(nk);
        imported++;
      }catch{ errors++ }
    }
    saveTasks(tasks);
    audit("import",`CSV 匯入 ${imported} 筆；空白 ${skippedBlank}；重複 ${skippedDuplicate}`);
    const takeover=aiTakeOverAfterImport(importedTaskIds);
    const accounted=imported+skippedDuplicate+skippedBlank+errors;
    importStatus.textContent=`成功 ${imported}｜AI 接手 ${takeover.queued}｜重複 ${skippedDuplicate}｜錯誤 ${errors}`;
    modal("匯入完成，AI 已接手",
      `<p>原始資料列：${dataRows.length}<br>
       <strong>成功匯入：${imported}</strong><br>
       重複略過：${skippedDuplicate}<br>
       空白略過：${skippedBlank}<br>
       錯誤：${errors}<br>
       核對合計：${accounted}</p>
       <p>AI 預檢完成：${takeover.prechecked}<br>
       AI 已建立可處理任務：${takeover.queued}<br>
       預檢失敗：${takeover.failed}</p>
       <p>偵測分隔符：${escapeHtml(delimiterLabel(detectDelimiter(text)))}<br>
       實際辨識表頭：第 ${headerIndex+1} 列<br>
       姓名欄位：${escapeHtml(headers[nameIndex])}<br>
       掃描列數：${scan.scanned}</p>
       <p><strong>後續流程已交由 AI Agent 管理。</strong></p>`);
  }catch(err){
    importStatus.textContent=`匯入失敗：${err?.message||err}`;
    modal("匯入錯誤",`<pre>${escapeHtml(err?.stack||String(err))}</pre>`);
  }
}
function exportBackup(){
  const blob=new Blob([JSON.stringify({version:VERSION,tasks:loadTasks(),audit:loadAudit(),exportedAt:now()},null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`gmail-agent-backup-${Date.now()}.json`;a.click();URL.revokeObjectURL(url);
}
function addTask(){
  modal("新增任務",`<label>姓名</label><input id="newTaskName" style="width:100%;padding:12px;margin:8px 0 14px;border-radius:12px;border:1px solid var(--line);background:#111;color:#fff">
  <button class="primary" onclick="confirmAddTask()">建立任務</button>`);
}
function confirmAddTask(){
  const n=document.getElementById("newTaskName").value.trim();if(!n)return;
  const t=loadTasks();t.push(makeTask(n));saveTasks(t);closeModal();
}
function installHelp(){
  modal("加入 iPhone 主畫面",`<p>請用 Safari 開啟本系統，點底部「分享」按鈕 →「加入主畫面」→「加入」。</p>
  <p>安裝後會以獨立全螢幕 App 模式開啟。</p><p><strong>注意：</strong>PWA 必須由 HTTPS 網址提供，不能直接從 ZIP 檔安裝。</p>`);
}
function diagnostics(){
  const t=loadTasks(),a=loadAudit();
  modal("診斷與恢復",`<pre>Version: ${VERSION}
Tasks: ${t.length}
Audit events: ${a.length}
LocalStorage: OK
Service Worker: ${serviceWorkerStatus}
Online: ${navigator.onLine}
Standalone: ${window.matchMedia("(display-mode: standalone)").matches}</pre>`);
}
function about(){
  modal("版本與狀態",`<p><strong>${VERSION}</strong></p>
  <p>狀態：PWA_PRIVATE_V22_AI_TAKEOVER_READY</p>
  <p>本版為 iPhone 私有 PWA，不經 App Store。核心資料預設保存在本機瀏覽器。</p>`);
}

document.querySelectorAll("[data-nav]").forEach(b=>b.addEventListener("click",()=>navigate(b.dataset.nav)));
runNextBtn.onclick=runNext;demoDataBtn.onclick=createDemo;exportBtn.onclick=exportBackup;addTaskBtn.onclick=addTask;
modalClose.onclick=closeModal;installHelpBtn.onclick=installHelp;diagnosticsBtn.onclick=diagnostics;aboutBtn.onclick=about;
backupRestoreBtn.onclick=()=>modal("備份／還原","目前已支援 JSON 備份匯出；正式還原匯入可在下一版加入檔案選擇器。");
csvInput.addEventListener("change",e=>{if(e.target.files[0])importCSV(e.target.files[0])});
taskFilters.querySelectorAll("button").forEach(b=>b.onclick=()=>{currentFilter=b.dataset.filter;taskFilters.querySelectorAll("button").forEach(x=>x.classList.remove("active"));b.classList.add("active");renderTasks()});

window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredInstallPrompt=e;installBtn.classList.remove("hidden")});
installBtn.onclick=async()=>{if(deferredInstallPrompt){deferredInstallPrompt.prompt();deferredInstallPrompt=null}else installHelp()};

if("serviceWorker" in navigator){
  serviceWorkerStatus="pending";
  window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js?v=22-2")
    .then(reg=>{serviceWorkerStatus=`registered${reg.active?` (${reg.active.state})`:""}`})
    .catch(err=>{serviceWorkerStatus=`error (${err.name||"unknown"})`}));
}
window.runAction=runAction;window.markHumanDone=markHumanDone;window.markCompleted=markCompleted;window.setHumanGate=setHumanGate;window.removeTask=removeTask;window.confirmAddTask=confirmAddTask;
window.aiAutoPrecheckTask=aiAutoPrecheckTask;window.aiAutoGenerateCandidate=aiAutoGenerateCandidate;window.aiPrepareImportedTasks=aiPrepareImportedTasks;window.aiProcessSafeStep=aiProcessSafeStep;window.aiTakeOverAfterImport=aiTakeOverAfterImport;

renderAll();
