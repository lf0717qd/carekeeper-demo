(() => {
  "use strict";

  const CONFIG = window.CAREKEEPER_CONFIG || {};
  const API_BASE = String(CONFIG.apiBase || "").replace(/\/$/, "");
  const apiUrl = (path) => API_BASE + path;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const state = {
    autoSpeak: false,
    cantoneseVoice: null,
    apiOnline: false,
    apiChecked: false,
    history: [],
    realAsr: false,
    recognition: null,
    cloudAsr: false,
    mediaRecorder: null,
    mediaStream: null,
    recording: false,
    recordTimer: null,
    trace: [],
    stage: "idle",
    lastUserText: "",
    lastAgentText: "",
    scenario: null,
    micIndex: 0,
    optionsEl: null,
    typingEl: null,
    tasks: [
      { id: "bp", label: "朝早量血压", done: false },
      { id: "med-am", label: "食早上药", done: false },
      { id: "med-pm", label: "食晚上药", done: false },
      { id: "followup", label: "下星期三复诊", done: false }
    ],
    familyReport: {
      date: "2026-11-18",
      summary: "今日 3 次对话，已完成用药提醒与血压复测；未出现红线。",
      bp: "180/100 → 165/95",
      med: "1 / 2",
      alerts: 0,
      alertText: "",
      notes: [
        "今晚 8 点提醒食晚上药。",
        "建议家属今晚回电，问下婆婆有冇头晕。",
        "下星期三 11 月 25 日朝早 9 点复诊，带身份证、医保卡、血压记录。"
      ],
      messages: []
    }
  };

  const profile = {
    name: "陈婆婆",
    age: 76,
    area: "广州荔湾",
    conditions: ["高血压 2 级", "2 型糖尿病"],
    meds: [
      { name: "氨氯地平", dose: "5mg", when: "早上饭后 · 每日 1 次" },
      { name: "二甲双胍", dose: "0.5g", when: "早晚饭后 · 每日 2 次" }
    ],
    allergy: "无已知过敏",
    family: "儿子陈先生，常住深圳",
    doctor: "社区医院李医生"
  };

  const micPhrases = [
    "呢只药点食？",
    "今日血压 180/100。",
    "我心口闷，出冷汗，唞唔到气。"
  ];

  const scenarioUserText = {
    medication: "呢只药点食？",
    bp: "今日血压 180/100。",
    emergency: "我心口闷，出冷汗，唞唔到气。",
    followup: "几时复诊？",
    family: "帮我出一份家属报告。"
  };

  // ---------- rendering ----------
  async function init() {
    bindEvents();
    renderFamilyReport();
    addMessage("agent", "婆婆，你好，我系智能助手，唔系真人。你按一下讲嘢，或者直接同我讲。今日想讲咩？");
    addTrace({ tool: "session.start", title: "会话开始", detail: "用户：陈婆婆；方言：粤语（广府片）；入口：老人端一屏" });
    addTrace({ tool: "ai.identity", title: "AI 身份告知", detail: "开场白明确：智能助手，不是真人" });
    addTrace({ tool: "memory.load", title: "载入健康画像", detail: "高血压、2 型糖尿病；在服 2 种药；家属：儿子陈先生" });
    addTrace({ tool: "policy.load", title: "载入安全规则", detail: "胸痛 / 呼吸困难 / 意识改变 / 跌倒 / 低血糖 → 转人工或 120" });
    loadVoices();
    setTimeout(loadVoices, 600);
    if ("speechSynthesis" in window) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
    checkApi();
    const params = new URLSearchParams(window.location.search);
    if (params.get("static") === "1") {
      document.body.classList.add("static");
    }
    if (params.get("tab") === "family") {
      switchTab("family");
    }
    if (params.get("unauth") === "1") {
      ensureFamilyState().access.authorized = false;
      renderFamilyReport();
    }
    const demoParam = params.get("demo");
    if (demoParam && scenarioUserText[demoParam]) {
      setTimeout(() => startScenario(demoParam), 700);
    }
    const askParam = params.get("ask");
    if (askParam) {
      setTimeout(() => startScenario(route(askParam), askParam), 700);
    }
  }

  function bindEvents() {
    $$(".chip").forEach((chip) => {
      chip.addEventListener("click", () => startScenario(chip.dataset.scenario));
    });
    $("#sendBtn").addEventListener("click", sendFromInput);
    $("#textInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendFromInput();
      }
    });
    $("#micBtn").addEventListener("click", handleMic);
    setupAsr();
    $$(".phone-actions button").forEach((button) => {
      button.addEventListener("click", () => handlePhoneAction(button.dataset.action));
    });
    $("#autoSpeak").addEventListener("change", (event) => {
      state.autoSpeak = event.target.checked;
      if (state.autoSpeak && !state.cantoneseVoice) {
        showToast("浏览器未检测到粤语声线，当前只能文字演示");
      }
    });
    $$(".tab").forEach((tab) => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });
    $("#exportTrace").addEventListener("click", exportTrace);
    $("#sendFamily").addEventListener("click", async () => {
      const ok = await confirmAction({
        title: "发送今日报告给家属？",
        message: "将发送今日摘要、血压、用药和复诊提醒；不会发送原始对话。",
        confirmText: "发送报告"
      });
      if (!ok) return;
      notifyFamily("已把今日报告发送给家属（演示）。");
      reportAudit("report.send", "sent", "今日报告");
      showToast("已模拟发送到家属微信");
    });
  }

  function addMessage(role, text) {
    const chat = $("#chat");
    const wrap = document.createElement("div");
    wrap.className = "message " + role;

    if (role === "agent") {
      const avatar = document.createElement("div");
      avatar.className = "msg-avatar";
      avatar.textContent = "乡";
      wrap.appendChild(avatar);
    }

    const bubbleWrap = document.createElement("div");
    bubbleWrap.className = "bubble-wrap";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    bubbleWrap.appendChild(bubble);

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const time = document.createElement("span");
    time.textContent = nowTime();
    meta.appendChild(time);

    if (role === "agent") {
      const speaker = document.createElement("button");
      speaker.type = "button";
      speaker.innerHTML = '<svg><use href="#i-speaker"></use></svg>粤语播报';
      speaker.addEventListener("click", () => speak(text));
      meta.appendChild(speaker);
      state.lastAgentText = text;
    }

    bubbleWrap.appendChild(meta);
    wrap.appendChild(bubbleWrap);
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return wrap;
  }

  function showTyping() {
    hideTyping();
    const chat = $("#chat");
    const wrap = document.createElement("div");
    wrap.className = "message agent";
    wrap.innerHTML = '<div class="msg-avatar">乡</div><div class="bubble-wrap"><div class="bubble"><span class="typing-bubble"><i></i><i></i><i></i></span></div></div>';
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    state.typingEl = wrap;
  }

  function hideTyping() {
    if (state.typingEl && state.typingEl.parentNode) {
      state.typingEl.parentNode.removeChild(state.typingEl);
    }
    state.typingEl = null;
  }

  async function agentReply(text, opts = {}) {
    const { trace = [], options = [], delay = 620, speakText = true, citations = [] } = opts;
    clearOptions();
    showTyping();
    setStage("act");
    await sleep(delay);
    hideTyping();
    const wrap = addMessage("agent", text);
    appendCitations(wrap, citations);
    state.history.push({ role: "assistant", content: text });
    state.history = state.history.slice(-10);
    if (speakText) maybeSpeak(text);
    trace.forEach((item) => addTrace(item));
    if (options.length) showOptions(options);
    setStage("reflect");
    setTimeout(() => setStage("idle"), 900);
  }


  function appendCitations(wrap, citations) {
    const unique = [...new Set((citations || []).filter(Boolean))];
    if (!unique.length) return;
    const bubbleWrap = wrap.querySelector(".bubble-wrap");
    if (!bubbleWrap) return;
    const box = document.createElement("div");
    box.className = "citations";
    box.textContent = "来源：" + unique.slice(0, 3).join("；");
    bubbleWrap.appendChild(box);
  }

  function showOptions(options) {
    clearOptions();
    const chat = $("#chat");
    const box = document.createElement("div");
    box.className = "options";
    options.forEach((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "option-btn";
      button.textContent = option.label;
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        box.remove();
        state.optionsEl = null;
        await option.action();
      });
      box.appendChild(button);
    });
    chat.appendChild(box);
    chat.scrollTop = chat.scrollHeight;
    state.optionsEl = box;
  }

  function clearOptions() {
    if (state.optionsEl && state.optionsEl.parentNode) {
      state.optionsEl.parentNode.removeChild(state.optionsEl);
    }
    state.optionsEl = null;
  }

  function userSays(text) {
    state.lastUserText = text;
    state.history.push({ role: "user", content: text });
    state.history = state.history.slice(-10);
    addMessage("elder", text);
    setStage("observe");
    addTrace({ tool: "asr.transcribe", title: "粤语识别", detail: "“" + text + "”" });
    setStage("understand");
  }

  function addTrace(item) {
    state.trace.push({
      time: nowTime(),
      tool: item.tool,
      title: item.title,
      detail: item.detail || "",
      tone: item.tone || ""
    });
    renderTrace();
  }

  function renderTrace() {
    const list = $("#traceList");
    list.innerHTML = "";
    if (!state.trace.length) {
      const empty = document.createElement("div");
      empty.className = "trace-empty";
      empty.textContent = "等待对话。点一下老人端的「讲嘢」，或选一个场景。";
      list.appendChild(empty);
      return;
    }
    state.trace.forEach((item) => {
      const row = document.createElement("div");
      row.className = "trace-item " + item.tone;
      const dot = document.createElement("div");
      dot.className = "trace-dot";
      const body = document.createElement("div");
      body.className = "trace-body";
      const top = document.createElement("div");
      top.className = "trace-top";
      const tool = document.createElement("span");
      tool.className = "tool";
      tool.textContent = item.tool;
      const time = document.createElement("span");
      time.className = "trace-time";
      time.textContent = item.time;
      top.appendChild(tool);
      top.appendChild(time);
      const title = document.createElement("p");
      title.textContent = item.title;
      body.appendChild(top);
      body.appendChild(title);
      if (item.detail) {
        const detail = document.createElement("small");
        detail.textContent = item.detail;
        body.appendChild(detail);
      }
      row.appendChild(dot);
      row.appendChild(body);
      list.appendChild(row);
    });
    list.scrollTop = list.scrollHeight;
  }

  function clearTrace() {
    state.trace = [];
    renderTrace();
  }

  function setStage(stage) {
    const order = ["observe", "understand", "decide", "act", "reflect"];
    const index = order.indexOf(stage);
    $$(".stage-pill").forEach((pill) => {
      const i = order.indexOf(pill.dataset.stage);
      pill.classList.toggle("active", i === index);
      pill.classList.toggle("done", index >= 0 && i < index);
    });
    state.stage = stage;
  }

  function switchTab(name) {
    $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
    $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === "panel-" + name));
    if (name === "family") renderFamilyReport();
  }

  // ---------- scenarios ----------
  function startScenario(name, text) {
    clearOptions();
    clearTrace();
    setAlert(false);
    state.scenario = name;
    const utterance = text || scenarioUserText[name] || "";
    userSays(utterance);
    addTrace({ tool: "session.turn", title: "新一轮对话", detail: "场景：" + scenarioLabel(name) });
    runScenario(name);
  }

  function runScenario(name) {
    if (name === "medication") return runMedication();
    if (name === "bp") return runBP();
    if (name === "emergency") return runEmergency(false);
    if (name === "followup") return runFollowup();
    if (name === "family") return runFamily();
    return runUnknown();
  }

  async function runMedication() {
    addTrace({ tool: "nlu.intent", title: "意图识别", detail: "用药咨询 · 置信度 0.96" });
    addTrace({ tool: "memory.get_profile", title: "读取健康画像", detail: "高血压、2 型糖尿病；在服氨氯地平、二甲双胍；无已知过敏" });
    addTrace({ tool: "policy.check_medication", title: "用药规则检查", detail: "未发现重复用药；未发现已知过敏冲突" });
    setStage("decide");
    addTrace({ tool: "tts.speak", title: "粤语口语生成", detail: "慢速、短句、先讲结论；不使用普通话书面语" });
    await agentReply(
      "婆婆，你而家食紧两种药：\n氨氯地平，早上饭后一粒；\n二甲双胍，早晚饭后各一粒。\n唔好空肚食，亦都唔好一次食两粒补返。漏咗就同我讲，我帮你问医生/药师。",
      {
        options: [
          { label: "好，提醒我", action: confirmMedicationReminder },
          { label: "我漏食咗", action: missedDose }
        ]
      }
    );
  }

  async function confirmMedicationReminder() {
    userSays("好，你提醒我。");
    addTrace({ tool: "create_reminder", title: "创建用药提醒", detail: "今晚 20:00 提醒食晚上药；未完成则 20:30 再提醒" });
    await agentReply("好，我今晚八点提醒你食晚上药。如果你唔记得，我会再讲一次，亦会通知你仔。");
    notifyFamily("婆婆已确认今晚用药提醒；如未完成，系统会在 20:30 再提醒。");
    showToast("已创建用药提醒（演示）");
  }

  async function missedDose() {
    userSays("我漏食咗一次。");
    addTrace({ tool: "policy.missed_dose", title: "漏服规则", detail: "不自动补双倍剂量；转药师/医生确认" });
    await agentReply("你漏咗边一餐？唔好自己加量补返。我帮你记低，等阵问下医生/药师。", {
      options: [
        { label: "早上", action: () => missedDoseAnswer("早上") },
        { label: "晚上", action: () => missedDoseAnswer("晚上") }
      ]
    });
  }

  async function missedDoseAnswer(meal) {
    userSays(meal + "嗰餐。");
    addTrace({ tool: "escalate.pharmacist", title: "转药师确认", detail: "漏服：" + meal + "；已生成用药咨询工单" });
    await agentReply("好，我记低咗。你下次食药之前，先等我问清楚医生/药师，唔好自己补双倍。");
    notifyFamily("婆婆报告漏服一次（" + meal + "），已转药师确认，未建议自行补服。");
  }

  async function askBPMissingReading() {
    addTrace({ tool: "triage.bp_rule", title: "血压读数缺失", detail: "先问具体读数 + 红线症状；不默认 180/100", tone: "warm" });
    setStage("decide");
    await agentReply(
      "婆婆，你有冇量到具体读数？几多／几多？有冇头痛、胸痛、唞唔到气、睇嘢模糊？",
      {
        options: [
          { label: "我量到 180/100", action: () => startScenario("bp", "今日血压 180/100。") },
          { label: "我未量", action: () => agentReply("好，你先坐低休息五分钟，再量一次。量完同我讲几多／几多。如果期间胸痛、唞唔到气，立即同我讲。") },
          { label: "有胸痛/气促", action: () => runEmergency(true) }
        ]
      }
    );
  }

  async function runBP() {
    const match = state.lastUserText.match(/(\d{2,3})\s*[\/／]\s*(\d{2,3})/);
    if (!match) {
      return askBPMissingReading();
    }
    const systolic = match[1];
    const diastolic = match[2];
    addTrace({ tool: "nlu.intent", title: "意图识别", detail: "血压读数咨询 · 置信度 0.94" });
    addTrace({ tool: "memory.get_vitals", title: "读取本次读数", detail: "本次 " + systolic + "/" + diastolic + "；不替用户编造历史读数" });
    setStage("decide");
    addTrace({ tool: "triage.red_flags", title: "红线问诊", detail: "询问胸痛、气促、神经症状、视物模糊" });
    await agentReply(
      "婆婆，" + systolic + "/" + diastolic + " 偏高。你有冇头痛、胸痛、唞唔到气、睇嘢模糊？",
      {
        options: [
          { label: "有少少头痛", action: bpHeadache },
          { label: "胸口痛", action: bpChestPain },
          { label: "冇，只系血压高", action: bpNoSymptoms }
        ]
      }
    );
  }

  async function bpHeadache() {
    userSays("有少少头痛。");
    addTrace({ tool: "risk.stratify", title: "风险分层", detail: "血压高 + 头痛 → 中高风险；建议复测并通知家属", tone: "warm" });
    notifyFamily("婆婆血压 180/100，伴轻微头痛；已建议静坐 10 分钟复测，请家属今晚回电。");
    await agentReply(
      "你先坐低休息十分钟，再量一次。如果仲系 180 以上，或者头痛加剧、想呕、睇嘢模糊，我帮你叫医生。",
      { options: [{ label: "好，我休息下", action: () => agentReply("好，我十分钟后再问你。如果唔舒服，随时按「讲嘢」。") }] }
    );
    addTrace({ tool: "create_task", title: "创建复测任务", detail: "10 分钟后复测血压；未完成则提醒家属" });
  }

  async function bpNoSymptoms() {
    userSays("冇，只系血压高。");
    addTrace({ tool: "risk.stratify", title: "风险分层", detail: "无伴随症状 → 中风险；先复测，暂不升级 120", tone: "warm" });
    await agentReply(
      "好，你先坐低休息十分钟，再量一次。记录下来，听日复诊同医生讲。如果等阵有胸痛、唞唔到气，立即同我讲。",
      { options: [{ label: "好", action: () => agentReply("好，我十分钟后再问你。") }] }
    );
    addTrace({ tool: "create_task", title: "创建复测任务", detail: "10 分钟后复测血压；结果写入健康档案" });
    notifyFamily("婆婆今日自述血压偏高，无伴随症状；已建议静坐复测，暂未升级。");
  }

  async function bpChestPain() {
    userSays("胸口痛，有少少唞唔到气。");
    await runEmergency(true);
  }

  async function runEmergency(fromBP = false) {
    setAlert(true);
    const familyState = ensureFamilyState();
    familyState.alerts += 1;
    familyState.alertText = "胸痛 + 出冷汗 + 气促：已按红线升级，模拟通知家属并转人工/120。";
    familyState.alertsList.unshift({ time: nowTime(), text: familyState.alertText, handled: false });
    addTrace({ tool: "triage.red_flag", title: "红线命中", detail: "胸痛 + 出冷汗 + 气促 → 立即升级", tone: "danger" });
    setStage("decide");
    addTrace({ tool: "escalate.120", title: "紧急升级", detail: "保持在线；模拟生成急救工单；提示不要自行走动", tone: "danger" });
    setStage("act");
    await agentReply(
      "婆婆，你而家唔好行，坐低或者半躺。我而家帮你叫家人同 120。你保持同我讲嘢，唔好自己走出去。",
      {
        options: [
          { label: "我仲系好唔舒服", action: () => emergencyStillBad() },
          { label: "好少少", action: () => emergencyBetter() }
        ]
      }
    );
    notifyFamily("【红线】婆婆心口闷、出冷汗、唞唔到气；已模拟转人工/120，请立即回电。");
    showToast("已模拟通知家属并转人工/120");
  }

  async function emergencyStillBad() {
    userSays("我仲系好唔舒服。");
    addTrace({ tool: "human.takeover", title: "人工接管", detail: "坐席已接入；保持通话；急救工单升级", tone: "danger" });
    await agentReply("好，我唔收线。你继续坐低，慢慢呼吸。姑娘已经接住，会陪你等家人同救护车。");
  }

  async function emergencyBetter() {
    userSays("好少少。");
    addTrace({ tool: "human.takeover", title: "人工接管", detail: "坐席已接入；继续观察；不建议自行外出", tone: "warm" });
    await agentReply("好，继续保持坐低，等家人或者救护车到。唔好自己走出去，有咩变化即刻同我讲。");
  }

  async function runFollowup() {
    addTrace({ tool: "memory.get_events", title: "查询照护事件", detail: "下星期三 11 月 25 日 09:00；社区医院二楼慢病门诊；李医生" });
    addTrace({ tool: "knowledge.visit_prep", title: "复诊准备", detail: "带身份证、医保卡、近两个月血压记录；空肚抽血" });
    setStage("decide");
    await agentReply(
      "下星期三，11 月 25 日，朝早九点，去社区医院二楼慢病门诊。带身份证、医保卡，同呢两个月嘅血压记录。空肚去，要抽血。",
      {
        options: [
          { label: "加入日历", action: addToCalendar },
          { label: "叫家人陪我去", action: askFamilyToAccompany }
        ]
      }
    );
    addTrace({ tool: "create_task", title: "创建复诊任务", detail: "11 月 25 日 09:00；提前一天提醒；家属同步" });
  }

  async function addToCalendar() {
    userSays("好，帮我加入日历。");
    addTrace({ tool: "calendar.create", title: "生成日历事件", detail: "复诊提醒 · 11 月 25 日 09:00 · 提前 24h / 2h 闹钟" });
    downloadICS();
    await agentReply("好，我帮你整咗个日历提醒，你叫家人帮你加入手机日历就得。");
    showToast("已下载复诊提醒 .ics（演示）");
  }

  async function askFamilyToAccompany() {
    userSays("叫我仔陪我去。");
    addTrace({ tool: "notify.family", title: "通知家属", detail: "复诊陪同请求：11 月 25 日 09:00，社区医院二楼" });
    notifyFamily("婆婆想请你陪她 11 月 25 日 09:00 去社区医院二楼复诊。");
    await agentReply("好，我同你仔讲。佢覆你之前，我提前一日再提醒你。");
  }

  async function runFamily() {
    switchTab("family");
    addTrace({ tool: "family.report", title: "生成家属报告", detail: "汇总今日血压、用药、告警、下一步；隐藏原始对话中的敏感信息" });
    await agentReply("我已经整理好今日报告，转去「家属报告」畀你睇。你可以叫家人睇，或者我帮你发送。");
  }

  async function runUnknown() {
    if (!state.apiChecked) {
      await checkApi();
    }
    if (/血压高|血压升|血压又高/.test(state.lastUserText) && !/\d{2,3}\s*[\/／]\s*\d{2,3}/.test(state.lastUserText)) {
      return askBPMissingReading();
    }
    addTrace({
      tool: "nlu.intent",
      title: "本地意图未命中",
      detail: state.apiOnline
        ? "交给 LLM 做粤语理解与解释；红线仍由服务端规则兜底"
        : "静态演示：使用预置回答；关键场景仍按脚本走",
      tone: "warm"
    });
    if (state.apiOnline) {
      return askLLM(state.lastUserText);
    }
    const canned = staticAnswer(state.lastUserText);
    if (canned) {
      addTrace({ tool: "demo.static", title: "静态演示回答", detail: "GitHub Pages 无后端，使用预置答案", tone: "warm" });
      await agentReply(canned, {
        options: [
          { label: "叫家人", action: async () => { notifyFamily("婆婆需要家人协助（静态演示）。"); await agentReply("好，我帮你叫家人。你等阵，唔使急。"); } },
          { label: "再讲一次", action: () => $("#textInput").focus() }
        ]
      });
      return;
    }
    await agentReply(
      "婆婆，我未系好听得明。你可以讲多次，或者我帮你叫家人/姑娘。",
      {
        options: [
          { label: "再讲一次", action: () => { $("#textInput").focus(); showToast("请再讲一次（演示：可打字或按讲嘢）"); } },
          { label: "叫家人", action: async () => { notifyFamily("婆婆需要家人协助，当前对话未能识别。"); await agentReply("好，我帮你叫家人。你等阵，唔使急。"); } }
        ]
      }
    );
  }

  // ---------- static demo fallback ----------
  function staticAnswer(text) {
    if (/食粥|食饭|饮食|食乜|食咩|水果|甜品|糖水/.test(text)) {
      return "婆婆，粥可以食，但份量要控制，唔好食太多；最好搭配菜或者蛋白质，食后记得测下血糖。呢个只系健康教育，唔系诊断。\n\n（在线静态演示：呢句系预置回答；真实 LLM 请本地运行 server.py。）";
    }
    if (/头晕|头痛/.test(text)) {
      return "婆婆，你先坐低，唔好急住起身。如果有一边身无力、讲唔清、胸痛或者唞唔到气，立即叫家人/120。如果只系普通头晕，我帮你记低，等阵问家医。呢个只系健康教育，唔系诊断。\n\n（在线静态演示：呢句系预置回答。）";
    }
    if (/睡不着|失眠|唔想食|无胃口/.test(text)) {
      return "婆婆，今晚少饮茶同咖啡，固定时间上床；如果持续好耐，或者体重跌得好快，我帮你叫家医睇下。呢个只系健康教育，唔系诊断。\n\n（在线静态演示：呢句系预置回答。）";
    }
    return null;
  }

  // ---------- real LLM API ----------
  async function checkApi() {
    try {
      const response = await fetch(apiUrl("/api/health"), { cache: "no-store" });
      const data = await response.json();
      state.apiOnline = Boolean(data.ok);
      state.apiChecked = true;
      showOfflineNotice(!state.apiOnline);
      const status = $("#agentStatus");
      if (status) {
        status.innerHTML = state.apiOnline
          ? '<i></i> LLM 在线'
          : '<i></i> 脚本模式';
        status.title = state.apiOnline ? ("模型：" + data.model) : "未连接后端，使用脚本化 Agent";
      }
    } catch (error) {
      state.apiOnline = false;
      state.apiChecked = true;
      showOfflineNotice(true);
      const status = $("#agentStatus");
      if (status) status.innerHTML = '<i></i> 脚本模式';
    }
  }

  function showOfflineNotice(show) {
    const notice = $("#offlineNotice");
    if (notice) notice.classList.toggle("hidden", !show);
  }

  function confirmAction(options = {}) {
    return new Promise((resolve) => {
      const title = options.title || "确认操作";
      const message = options.message || "";
      const confirmText = options.confirmText || "确认";
      const cancelText = options.cancelText || "取消";
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      const card = document.createElement("div");
      card.className = "confirm-card";
      const h = document.createElement("h3");
      h.textContent = title;
      const p = document.createElement("p");
      p.textContent = message;
      const actions = document.createElement("div");
      actions.className = "confirm-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = cancelText;
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = options.danger ? "danger" : "primary";
      ok.textContent = confirmText;
      actions.appendChild(cancel);
      actions.appendChild(ok);
      card.appendChild(h);
      card.appendChild(p);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      const close = (value) => {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === "Escape") close(false);
        if (event.key === "Enter") close(true);
      };
      cancel.addEventListener("click", () => close(false));
      ok.addEventListener("click", () => close(true));
      overlay.addEventListener("click", (event) => { if (event.target === overlay) close(false); });
      document.addEventListener("keydown", onKey);
      ok.focus();
    });
  }

  async function askLLM(text) {
    if (state.apiOnline) {
      const ok = await askLLMStream(text);
      if (ok) return;
    }
    return askLLMOnce(text);
  }

  function beginAgentStream() {
    clearOptions();
    const chat = $("#chat");
    const wrap = document.createElement("div");
    wrap.className = "message agent";
    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.textContent = "乡";
    wrap.appendChild(avatar);
    const bubbleWrap = document.createElement("div");
    bubbleWrap.className = "bubble-wrap";
    const bubble = document.createElement("div");
    bubble.className = "bubble streaming";
    bubbleWrap.appendChild(bubble);
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const time = document.createElement("span");
    time.textContent = nowTime();
    meta.appendChild(time);
    bubbleWrap.appendChild(meta);
    wrap.appendChild(bubbleWrap);
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return { wrap, bubble, meta };
  }

  function finishAgentStream(stream, text, citations = []) {
    stream.bubble.classList.remove("streaming");
    stream.bubble.textContent = text;
    const speaker = document.createElement("button");
    speaker.type = "button";
    speaker.innerHTML = '<svg><use href="#i-speaker"></use></svg>粤语播报';
    speaker.addEventListener("click", () => speak(text));
    stream.meta.appendChild(speaker);
    appendCitations(stream.wrap, citations);
    state.lastAgentText = text;
    state.history.push({ role: "assistant", content: text });
    state.history = state.history.slice(-10);
    if (state.autoSpeak) maybeSpeak(text);
    const chat = $("#chat");
    chat.scrollTop = chat.scrollHeight;
  }

  function parseSSE(part) {
    let event = "message";
    let data = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return null;
    try {
      return { event, data: JSON.parse(data) };
    } catch (error) {
      return null;
    }
  }

  async function askLLMStream(text) {
    addTrace({ tool: "llm.stream", title: "LLM 流式回答", detail: "SSE · 逐字返回 · 问题：" + text.slice(0, 60), tone: "warm" });
    const stream = beginAgentStream();
    let full = "";
    let doneData = null;
    try {
      const response = await fetch(apiUrl("/api/chat_stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          profile: profile,
          history: state.history.slice(-8, -1)
        })
      });
      if (!response.ok || !response.body) {
        throw new Error("HTTP " + response.status);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop();
        for (const part of parts) {
          const parsed = parseSSE(part);
          if (!parsed) continue;
          if (parsed.event === "delta") {
            const piece = parsed.data.text || "";
            full += piece;
            stream.bubble.textContent += piece;
            $("#chat").scrollTop = $("#chat").scrollHeight;
          } else if (parsed.event === "suffix") {
            const piece = parsed.data.text || "";
            full += piece;
            stream.bubble.textContent += piece;
          } else if (parsed.event === "done") {
            doneData = parsed.data;
          } else if (parsed.event === "error") {
            throw new Error(parsed.data.message || "stream error");
          }
        }
      }
      if (!full.trim()) throw new Error("empty stream");
      finishAgentStream(stream, full, doneData && doneData.citations);
      addTrace({
        tool: "llm.complete",
        title: "LLM 流式完成",
        detail: "来源：" + ((doneData && doneData.source) || "llm_stream") + " · " + ((doneData && doneData.latency_ms) || 0) + "ms"
      });
      if (doneData && doneData.needs_human) {
        addTrace({ tool: "policy.guardrail", title: "安全兜底", detail: "流式回答触发人工/家属确认", tone: "warm" });
        showOptions([
          { label: "叫家人", action: async () => { notifyFamily("LLM 流式回答触发人工协助。"); await agentReply("好，我帮你叫家人。你等阵，唔使急。"); } },
          { label: "叫医生", action: () => handlePhoneAction("doctor") }
        ]);
      }
      setStage("reflect");
      setTimeout(() => setStage("idle"), 900);
      return true;
    } catch (error) {
      if (full.trim()) {
        finishAgentStream(stream, full);
        addTrace({ tool: "llm.error", title: "流式中断", detail: String(error), tone: "warm" });
        showToast("流式回答中断，已保留已生成内容");
        return true;
      }
      if (stream.wrap.parentNode) stream.wrap.parentNode.removeChild(stream.wrap);
      addTrace({ tool: "llm.error", title: "流式调用失败", detail: String(error), tone: "danger" });
      return false;
    }
  }

  async function askLLMOnce(text) {
    addTrace({ tool: "llm.request", title: "调用 LLM", detail: "非流式兜底 · 问题：" + text.slice(0, 80), tone: "warm" });
    let data;
    try {
      const response = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          profile: profile,
          history: state.history.slice(-8, -1)
        })
      });
      data = await response.json();
    } catch (error) {
      addTrace({ tool: "llm.error", title: "LLM 调用失败", detail: String(error), tone: "danger" });
      await agentReply("婆婆，我而家网络唔系好通。你可以讲多次，或者我帮你叫家人/姑娘。", {
        options: [
          { label: "再讲一次", action: () => $("#textInput").focus() },
          { label: "叫家人", action: async () => { notifyFamily("LLM 不可用，婆婆需要家人协助。"); await agentReply("好，我帮你叫家人。你等阵，唔使急。"); } }
        ]
      });
      return;
    }

    addTrace({
      tool: "llm.complete",
      title: "LLM 粤语解释",
      detail: "来源：" + (data.source || "-") + " · " + (data.latency_ms || 0) + "ms · risk=" + (data.risk || "low")
    });
    if (Array.isArray(data.tool_calls)) {
      data.tool_calls.forEach((tool) => {
        addTrace({ tool: String(tool), title: "工具调用", detail: "由 Agent / LLM 触发" });
      });
    }
    if (data.needs_human) {
      addTrace({ tool: "policy.guardrail", title: "安全兜底", detail: data.follow_up || "转家人/人工确认", tone: "warm" });
    }
    await agentReply(data.reply || "婆婆，我未系好听得明，可以讲多次吗？", {
      citations: data.citations || [],
      options: data.needs_human
        ? [
            { label: "叫家人", action: async () => { notifyFamily("LLM 判断需要人工协助。"); await agentReply("好，我帮你叫家人。你等阵，唔使急。"); } },
            { label: "叫医生", action: () => handlePhoneAction("doctor") }
          ]
        : []
    });
  }

  // ---------- phone actions ----------
  function handlePhoneAction(action) {
    if (action === "repeat") {
      if (state.lastAgentText) {
        addMessage("agent", "我讲多一次：" + state.lastAgentText);
        maybeSpeak(state.lastAgentText);
      } else {
        showToast("暂时未有可以重听嘅内容");
      }
      return;
    }
    if (action === "family") {
      notifyFamily("婆婆按了「家人」按钮，请回电。");
      addMessage("agent", "好，我帮你叫家人。你等阵，唔使急。");
      showToast("已模拟呼叫家属");
      return;
    }
    if (action === "doctor") {
      addTrace({ tool: "human.takeover", title: "转人工/家医", detail: "老人主动按「医生」；带上下文转接", tone: "warm" });
      addMessage("agent", "好，我帮你接社区医院李医生。你唔使重复讲，我已经将情况交低。");
      notifyFamily("婆婆按了「医生」按钮，已转社区医院李医生（演示）。");
      showToast("已模拟转接家医");
    }
  }

  // ---------- mic / input ----------
  function setupAsr() {
    const button = $("#asrModeBtn");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (button) {
        button.textContent = "浏览器不支持录音";
        button.disabled = true;
      }
      return;
    }
    if (!window.MediaRecorder) {
      if (button) {
        button.textContent = "浏览器不支持录音";
        button.disabled = true;
      }
      return;
    }
    button.textContent = "录音识别";
    button.addEventListener("click", () => {
      if (!state.apiOnline) {
        showToast("当前是静态演示版，录音识别需要后端；请用本地版或等公网后端");
        return;
      }
      state.cloudAsr = !state.cloudAsr;
      button.textContent = state.cloudAsr ? "切回模拟" : "录音识别";
      showToast(state.cloudAsr ? "已开启云端粤语识别：按一下，讲 5 秒" : "已切回模拟语音");
    });
  }

  function handleMic() {
    if (state.recording) {
      stopCloudRecording();
      return;
    }
    if (state.cloudAsr) {
      startCloudAsr();
    } else {
      simulateMic();
    }
  }

  function pickAudioMime() {
    const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (const mime of options) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return "";
  }

  async function startCloudAsr() {
    if (state.recording) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast("当前浏览器不支持录音，请换 Chrome/Safari");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.mediaStream = stream;
      const mime = pickAudioMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      state.mediaRecorder = recorder;
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        state.recording = false;
        clearTimeout(state.recordTimer);
        state.recordTimer = null;
        $("#micBtn").classList.remove("listening");
        $("#micHint").textContent = "唔识字、唔识用手机，都可以讲";
        if (state.mediaStream) state.mediaStream.getTracks().forEach((t) => t.stop());
        state.mediaStream = null;
        state.mediaRecorder = null;
        if (!chunks.length) {
          showToast("未录到声音，请再试一次");
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
        addTrace({ tool: "asr.record", title: "录音完成", detail: Math.round(blob.size / 1024) + " KB · " + (blob.type || "unknown") });
        await uploadAudioForAsr(blob);
      };
      recorder.start();
      state.recording = true;
      $("#micBtn").classList.add("listening");
      $("#micHint").textContent = "听紧… 讲 5 秒，讲完会自动停";
      addTrace({ tool: "asr.cloud", title: "云端粤语识别", detail: "录音 5 秒 → GLM-ASR-2512", tone: "warm" });
      state.recordTimer = setTimeout(() => {
        if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
          state.mediaRecorder.stop();
        }
      }, 5000);
    } catch (error) {
      state.recording = false;
      $("#micBtn").classList.remove("listening");
      $("#micHint").textContent = "唔识字、唔识用手机，都可以讲";
      const message = asrErrorMessage(error.name || "unknown");
      addTrace({ tool: "asr.error", title: "录音失败", detail: (error.name || "unknown") + " · " + message, tone: "danger" });
      showToast(message);
    }
  }

  function stopCloudRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
      state.mediaRecorder.stop();
    }
  }

  function encodeWav(audioBuffer) {
    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample;
    const dataSize = length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);
    const channelData = [];
    for (let c = 0; c < channels; c += 1) channelData.push(audioBuffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < length; i += 1) {
      let sample = 0;
      for (let c = 0; c < channels; c += 1) sample += channelData[c][i];
      sample /= channels;
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
    return buffer;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function uploadAudioForAsr(blob) {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      await audioCtx.close();
      const wav = encodeWav(audioBuffer);
      const base64 = arrayBufferToBase64(wav);
      addTrace({ tool: "asr.upload", title: "上传云端 ASR", detail: "WAV " + Math.round(wav.byteLength / 1024) + " KB · glm-asr-2512" });
      const response = await fetch(apiUrl("/api/asr"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_base64: base64, mime: "audio/wav" })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
      const text = String(data.text || "").trim();
      if (!text) {
        showToast("未听到内容，请再讲一次");
        addTrace({ tool: "asr.empty", title: "ASR 未返回文字", detail: "可能是太短/太吵", tone: "warm" });
        return;
      }
      addTrace({ tool: "asr.transcript", title: "云端粤语转写", detail: "“" + text + "” · " + (data.latency_ms || 0) + "ms" });
      startScenario(route(text), text);
    } catch (error) {
      addTrace({ tool: "asr.error", title: "云端 ASR 失败", detail: String(error), tone: "danger" });
      showToast("云端识别失败：" + String(error).slice(0, 80));
    }
  }

  async function ensureMicPermission() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { ok: false, reason: "mediaDevices-unavailable" };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      return { ok: true, reason: "granted" };
    } catch (error) {
      return { ok: false, reason: error.name || "unknown" };
    }
  }

  function asrErrorMessage(reason) {
    if (reason === "mediaDevices-unavailable") {
      return "当前浏览器不支持麦克风权限检测，请用 Chrome/Safari 直接打开，别用微信内置浏览器。";
    }
    if (reason === "NotAllowedError" || reason === "SecurityError") {
      return "麦克风被浏览器拒绝：请在地址栏/网站设置里允许麦克风，刷新后再试。";
    }
    if (reason === "NotFoundError" || reason === "DevicesNotFoundError") {
      return "没有检测到麦克风，请检查手机/耳机麦克风。";
    }
    if (reason === "NotReadableError") {
      return "麦克风被其他 App 占用，请关掉通话/录音 App 再试。";
    }
    if (reason === "service-not-allowed") {
      return "麦克风可能已授权，但浏览器语音服务不可用：请用 Chrome/Safari 直接打开，别用微信内置浏览器；或换云 ASR。";
    }
    if (reason === "language-not-supported") {
      return "当前浏览器不支持粤语识别，请换 Chrome/Safari，或换云 ASR。";
    }
    if (reason === "network") {
      return "浏览器语音服务网络不通（国内网络常见），需要换云 ASR。";
    }
    if (reason === "audio-capture") {
      return "没有检测到麦克风，请检查权限和设备。";
    }
    if (reason === "no-speech") {
      return "未听到声音，请靠近麦克风再讲一次。";
    }
    return "真实语音失败：" + reason;
  }

  async function startRealRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast("当前浏览器不支持真实语音，已用模拟输入");
      simulateMic();
      return;
    }
    if (state.recognition) {
      try { state.recognition.abort(); } catch (e) { /* ignore */ }
    }
    const button = $("#micBtn");
    const hint = $("#micHint");
    const rec = new SpeechRecognition();
    state.recognition = rec;
    rec.lang = "yue-Hant-HK";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let finalText = "";
    let failed = false;
    let micGranted = false;

    button.classList.add("listening");
    hint.textContent = "检查麦克风授权…";
    addTrace({ tool: "asr.permission", title: "检查麦克风", detail: "先请求 getUserMedia，区分“权限问题”和“语音服务问题" });
    const permission = await ensureMicPermission();
    if (!permission.ok) {
      button.classList.remove("listening");
      hint.textContent = "唔识字、唔识用手机，都可以讲";
      state.realAsr = false;
      const btn = $("#asrModeBtn");
      if (btn) btn.textContent = "用真实语音";
      const message = asrErrorMessage(permission.reason);
      addTrace({ tool: "asr.permission_denied", title: "麦克风不可用", detail: permission.reason + " · " + message, tone: "danger" });
      showToast(message);
      return;
    }
    micGranted = true;
    hint.textContent = "听紧… 讲完会自动停";
    addTrace({ tool: "asr.real", title: "真实粤语 ASR", detail: "麦克风已授权；lang=yue-Hant-HK" });

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += transcript;
        } else {
          interim += transcript;
        }
      }
      if (interim) hint.textContent = "听到：" + interim;
    };

    rec.onerror = (event) => {
      failed = true;
      const reason = event.error || "unknown";
      const effectiveReason = (reason === "not-allowed" && micGranted) ? "service-not-allowed" : reason;
      addTrace({ tool: "asr.error", title: "真实语音失败", detail: reason + " (micGranted=" + micGranted + ")", tone: "warm" });
      const message = asrErrorMessage(effectiveReason);
      showToast(message);
      if (effectiveReason === "not-allowed" || effectiveReason === "service-not-allowed" || effectiveReason === "language-not-supported") {
        state.realAsr = false;
        const btn = $("#asrModeBtn");
        if (btn) btn.textContent = "用真实语音";
      }
    };

    rec.onend = () => {
      button.classList.remove("listening");
      hint.textContent = "唔识字、唔识用手机，都可以讲";
      state.recognition = null;
      if (finalText.trim()) {
        const text = finalText.trim();
        addTrace({ tool: "asr.transcript", title: "真实粤语转写", detail: "“" + text + "”" });
        startScenario(route(text), text);
      } else if (!failed) {
        showToast("未听到内容，可以再按一次");
      }
    };

    try {
      rec.start();
    } catch (error) {
      button.classList.remove("listening");
      hint.textContent = "唔识字、唔识用手机，都可以讲";
      showToast("真实语音启动失败，已用模拟输入");
      simulateMic();
    }
  }

  function simulateMic() {
    const button = $("#micBtn");
    if (button.classList.contains("listening")) return;
    button.classList.add("listening");
    $("#micHint").textContent = "听紧… 你慢慢讲";
    addTrace({ tool: "vad.speech", title: "检测到语音", detail: "模拟粤语输入；真实设备接 ASR" });
    setTimeout(() => {
      button.classList.remove("listening");
      $("#micHint").textContent = "唔识字、唔识用手机，都可以讲";
      const text = micPhrases[state.micIndex % micPhrases.length];
      state.micIndex += 1;
      startScenario(route(text), text);
    }, 1100);
  }

  function sendFromInput() {
    const input = $("#textInput");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    startScenario(route(text), text);
  }

  function route(text) {
    if (/心口|胸|闷|唞唔到气|呼吸困难|冷汗|晕倒|跌倒|昏迷/.test(text)) return "emergency";
    if (/药|食药|降压|降糖|漏食|食咗/.test(text)) return "medication";
    if (/血压|血糖|\d{2,3}\s*[\/／]\s*\d{2,3}/.test(text)) return "bp";
    if (/复诊|几时|医院|门诊|体检|覆诊/.test(text)) return "followup";
    if (/报告|家人|仔|女|儿子|女儿/.test(text)) return "family";
    return "unknown";
  }

  function scenarioLabel(name) {
    if (name === "unknown") return state.apiOnline ? "自由问答（LLM）" : "自由问答（静态演示）";
    return { medication: "用药", bp: "血压高", emergency: "心口闷 / 红线", followup: "复诊", family: "家属报告" }[name] || "未识别";
  }

  // ---------- family report ----------
  function familyToday() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function ensureFamilyState() {
    const r = state.familyReport;
    r.date = familyToday();
    if (!r.access) {
      r.access = {
        authorized: true,
        agent: "儿子陈先生",
        scopes: ["查看今日报告", "接收红线告警", "复诊提醒"],
        updated: familyToday(),
        audit: [{ time: "2026-11-19", action: "初始授权", detail: "Demo 预置" }]
      };
    }
    if (!Array.isArray(r.access.audit)) r.access.audit = [];
    if (!Array.isArray(r.alertsList)) r.alertsList = [];
    if (!r.followup) {
      r.followup = {
        date: "2026-11-25 09:00",
        dept: "社区医院二楼",
        items: "身份证、医保卡、血压记录",
        fasting: "不需要空腹"
      };
    }
    return r;
  }

  function auditAuth(r, action, detail) {
    if (!Array.isArray(r.access.audit)) r.access.audit = [];
    r.access.audit.push({ time: nowTime(), action: action, detail: detail });
    r.access.audit = r.access.audit.slice(-20);
  }

  function reportAudit(event, action, detail = "") {
    fetch(apiUrl("/api/audit/event"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: event, action: action, detail: detail }),
      keepalive: true
    }).catch(() => {});
  }

  function authCard(r) {
    const scopes = (r.access.scopes || []).map((x) => "<span class='auth-scope'>" + escapeHTML(x) + "</span>").join("");
    const audit = (r.access.audit || []).slice(-3).reverse().map((a) =>
      '<li><strong>' + escapeHTML(a.action) + '</strong> · ' + escapeHTML(a.time) + '<br>' + escapeHTML(a.detail) + '</li>').join("");
    return '<div class="family-auth">' +
      '<div><span class="auth-pill">已授权</span> <strong>' + escapeHTML(r.access.agent) + '</strong>' +
      '<div class="auth-scopes">' + scopes + '</div>' +
      '<small>授权时间：' + escapeHTML(r.access.updated) + ' · 老人可随时撤回</small>' +
      '<details class="auth-audit"><summary>授权记录（' + (r.access.audit || []).length + '）</summary><ul>' + audit + '</ul></details>' +
      '</div>' +
      '<div class="auth-actions">' +
      '<button class="small-btn ghost" id="familyRevoke">撤回授权</button>' +
      '<button class="small-btn danger" id="familyDelete">删除今日数据</button>' +
      '</div>' +
      '</div>';
  }

  function lockedCard(r, msg) {
    const hasCode = !!r.access.code;
    const codeBox = hasCode
      ? '<div class="code-box"><small>老人授权码（5分钟有效）</small><strong>' + escapeHTML(r.access.code) + '</strong></div>' +
        '<div class="code-row"><input id="familyCodeInput" inputmode="numeric" maxlength="6" placeholder="输入6位授权码">' +
        '<input id="familyAgentInput" maxlength="20" placeholder="家属称呼，如儿子陈先生">' +
        '<button class="small-btn" id="familyVerify">确认授权</button></div>'
      : '<button class="small-btn" id="familyGenCode">生成授权码（老人操作）</button>';
    return '<div class="family-locked">' +
      '<div class="lock-icon">锁</div>' +
      '<h4>未授权，家属看不到报告</h4>' +
      '<p>老人生成 6 位授权码，家属输入后生效；5 分钟有效，可随时撤回。</p>' +
      codeBox +
      '<p class="code-msg" id="familyCodeMsg">' + escapeHTML(msg || "") + '</p>' +
      '<p class="muted tiny">演示：真实产品需要短信/人脸/现场确认，并记录授权与撤回。</p>' +
      (r.deleteReceipt ? '<p class="delete-receipt">删除凭证：' + escapeHTML(r.deleteReceipt) + '</p>' : '') +
      '</div>';
  }

  function alertsHTML(r) {
    if (!r.alertsList.length) return '<div class="report-alert good">今日未出现红线；继续观察血压与用药。</div>';
    return '<div class="alert-list">' + r.alertsList.map((a, i) =>
      '<div class="alert-item ' + (a.handled ? "handled" : "") + '">' +
      '<div><strong>' + (a.handled ? "已处理" : "待处理") + '</strong> · ' + escapeHTML(a.time) + '<br>' + escapeHTML(a.text) + '</div>' +
      (a.handled ? '<span class="muted">已确认</span>' : '<button class="small-btn" data-alert-index="' + i + '">标记已处理</button>') +
      '</div>').join("") + '</div>';
  }

  function medsHTML() {
    const rows = profile.meds.map((m) =>
      '<tr><td>' + escapeHTML(m.name) + '</td><td>' + escapeHTML(m.dose) + '</td><td>' + escapeHTML(m.when) + '</td></tr>').join("");
    return '<table class="med-table"><thead><tr><th>通用名</th><th>规格</th><th>用法</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="muted tiny">只读清单；不调剂量、不建议换药。具体以药袋/医生医嘱为准。</p>';
  }

  function receiptHTML(r) {
    return '<div class="receipt-paper">' +
      '<h1>今日照护回执</h1>' +
      '<p class="receipt-date">' + escapeHTML(r.date) + ' · 乡音健康管家</p>' +
      '<h2>今日摘要</h2><p>' + escapeHTML(r.summary) + '</p>' +
      '<h2>血压 / 用药</h2><p>血压：' + escapeHTML(r.bp) + '；用药完成：' + escapeHTML(r.med) + '。</p>' +
      '<h2>复诊</h2><p>' + escapeHTML(r.followup.date) + ' · ' + escapeHTML(r.followup.dept) + '；带：' + escapeHTML(r.followup.items) + '；' + escapeHTML(r.followup.fasting) + '。</p>' +
      '<h2>下一步</h2><ul>' + r.notes.map((n) => '<li>' + escapeHTML(n) + '</li>').join("") + '</ul>' +
      '<h2>红线</h2><p>' + (r.alertText ? escapeHTML(r.alertText) : "今日未出现红线。") + '</p>' +
      '<p class="receipt-foot">本回执只用于健康教育/照护提醒，不是诊断、处方或病历。</p>' +
      '</div>';
  }

  function doctorSummaryHTML(r) {
    return '<div class="doctor-paper">' +
      '<h1>医生只读摘要</h1>' +
      '<p class="muted">仅用于试点沟通；不可开药、不可改写病历、不替代医生判断。</p>' +
      '<h2>基本信息</h2><p>' + escapeHTML(profile.name) + '，' + profile.age + ' 岁，' + escapeHTML(profile.area) + '；诊断：' + escapeHTML(profile.conditions.join("、")) + '。</p>' +
      '<h2>今日情况</h2><p>' + escapeHTML(r.summary) + ' 血压：' + escapeHTML(r.bp) + '；用药：' + escapeHTML(r.med) + '。</p>' +
      '<h2>红线/告警</h2><p>' + (r.alertText ? escapeHTML(r.alertText) : "今日未出现红线。") + '</p>' +
      '<h2>复诊</h2><p>' + escapeHTML(r.followup.date) + ' · ' + escapeHTML(r.followup.dept) + '；带：' + escapeHTML(r.followup.items) + '。</p>' +
      '<h2>在服药物（只读）</h2>' + medsHTML() +
      '<h2>来源</h2><p>KB v0.2；回答带 citations；规则层优先。</p>' +
      '</div>';
  }

  function openPrintWindow(title, body, cls) {
    const w = window.open("", "_blank", "width=760,height=920");
    if (!w) {
      showToast("浏览器拦截了打印窗口，请允许弹窗");
      return;
    }
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + escapeHTML(title) + '</title>' +
      '<style>body{font-family:"Microsoft YaHei",sans-serif;color:#17363d;padding:28px;line-height:1.7}' +
      'h1{font-size:26px}h2{font-size:19px;margin-top:20px;border-left:4px solid #e07a3f;padding-left:8px}' +
      'p,li{font-size:16pt}table{width:100%;border-collapse:collapse;font-size:14pt}' +
      'th,td{border:1px solid #cfdedb;padding:6px;text-align:left}' +
      '.muted{color:#6b7b7d;font-size:14px}.receipt-foot{font-size:13px;color:#7a5a3a;border-top:1px dashed #d8c3a5;padding-top:10px}' +
      (cls === "doctor" ? 'body{background:#f7fbfa}' : '') + '</style></head><body>' + body + '</body></html>');
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 350);
  }

  function renderFamilyReport() {
    const root = $("#familyReport");
    if (!root) return;
    const r = ensureFamilyState();

    if (!r.access.authorized) {
      root.innerHTML = lockedCard(r, "");
      const gen = $("#familyGenCode");
      if (gen) gen.addEventListener("click", () => {
        r.access.code = String(Math.floor(100000 + Math.random() * 900000));
        r.access.codeExpires = Date.now() + 5 * 60 * 1000;
        auditAuth(r, "生成授权码", "老人侧生成；5分钟有效");
        renderFamilyReport();
        showToast("授权码已生成");
      });
      const verify = $("#familyVerify");
      if (verify) verify.addEventListener("click", () => {
        const code = ($("#familyCodeInput").value || "").trim();
        const name = ($("#familyAgentInput").value || "").trim() || "家属";
        const msg = $("#familyCodeMsg");
        if (!r.access.code || !r.access.codeExpires || Date.now() > r.access.codeExpires) {
          if (msg) msg.textContent = "授权码已过期，请老人重新生成。";
          return;
        }
        if (code !== r.access.code) {
          if (msg) msg.textContent = "授权码不对，请核对后重试。";
          return;
        }
        r.access.authorized = true;
        r.access.agent = name;
        r.access.updated = familyToday();
        r.access.code = null;
        r.access.codeExpires = 0;
        auditAuth(r, "授权成功", name + " 输入授权码");
        reportAudit("consent.authorize", "granted", "授权码验证");
        renderFamilyReport();
        showToast("授权成功");
      });
      return;
    }

    const messages = r.messages.length
      ? r.messages.map((m) => '<div class="family-message"><div class="fm-avatar">乡</div><div><strong>已发送给家属</strong><br>' + escapeHTML(m.text) + '<br><span class="muted">' + escapeHTML(m.time) + "</span></div></div>").join("")
      : '<p class="muted tiny">还没有发送记录。点下面「发送今日报告」。</p>';

    let html = authCard(r);
    html += '<div class="report-card">';
    html += '<div class="report-top">';
    html += '<div class="report-kicker">FAMILY REPORT · ' + escapeHTML(r.date) + '</div>';
    html += '<h4>陈婆婆今日照护报告</h4>';
    html += '<p>乡音健康管家 · 粤语优先 · 自动汇总</p>';
    html += '</div><div class="report-body">';
    html += '<div class="report-metrics">';
    html += '<div class="report-metric"><strong>' + escapeHTML(r.bp) + '</strong><span>血压（复测后）</span></div>';
    html += '<div class="report-metric"><strong>' + escapeHTML(r.med) + '</strong><span>用药完成</span></div>';
    html += '<div class="report-metric"><strong>' + r.alerts + '</strong><span>红线告警</span></div>';
    html += '</div>';
    html += '<div class="report-section"><h5>今日摘要</h5><p>' + escapeHTML(r.summary) + '</p></div>';
    html += '<div class="report-section"><h5>红线告警</h5>' + alertsHTML(r) + '</div>';
    html += '<div class="report-section"><h5>复诊提醒</h5><p><strong>' + escapeHTML(r.followup.date) + '</strong> · ' + escapeHTML(r.followup.dept) + '<br>带：' + escapeHTML(r.followup.items) + '；' + escapeHTML(r.followup.fasting) + '</p></div>';
    html += '<div class="report-section"><h5>在服药物（只读）</h5>' + medsHTML() + '</div>';
    html += '<div class="report-section"><h5>家属可以做什么</h5><ul>';
    r.notes.forEach((n) => { html += '<li>' + escapeHTML(n) + '</li>'; });
    html += '</ul></div>';
    html += '<div class="family-actions">';
    html += '<button class="small-btn" id="familySend">发送今日报告</button>';
    html += '<button class="small-btn ghost" id="familyPrint">打印大字回执</button>';
    html += '<button class="small-btn ghost" id="familyDoctor">医生只读摘要</button>';
    html += '</div>';
    html += '<div id="familyMessages">' + messages + '</div>';
    html += '</div></div>';
    root.innerHTML = html;

    const revoke = $("#familyRevoke");
    if (revoke) revoke.addEventListener("click", async () => {
      const ok = await confirmAction({
        title: "撤回家属授权？",
        message: "撤回后家属立即看不到今日报告、告警和复诊提醒，直到重新授权。",
        confirmText: "撤回授权",
        danger: true
      });
      if (!ok) return;
      r.access.authorized = false;
      r.access.code = null;
      r.access.codeExpires = 0;
      auditAuth(r, "撤回授权", "家属端立即锁定");
      reportAudit("consent.revoke", "revoked", "家属端锁定");
      renderFamilyReport();
      showToast("已撤回授权，家属端已锁定");
      addTrace({ tool: "consent.revoke", title: "撤回授权", detail: "家属端立即锁定；不再发送报告/告警" });
    });
    const del = $("#familyDelete");
    if (del) del.addEventListener("click", async () => {
      const ok = await confirmAction({
        title: "删除今日数据？",
        message: "将删除今日报告、红线告警、用药清单，并同时撤回授权。删除后不可恢复，只保留一条不含健康内容的删除凭证。",
        confirmText: "删除数据",
        danger: true
      });
      if (!ok) return;
      await deleteFamilyData(r);
    });
    const send = $("#familySend");
    if (send) send.addEventListener("click", async () => {
      const ok = await confirmAction({
        title: "发送今日报告给家属？",
        message: "将发送：今日摘要、血压、用药完成情况、复诊提醒。不会发送原始对话。",
        confirmText: "发送报告"
      });
      if (!ok) return;
      notifyFamily("已发送今日照护报告。");
      reportAudit("report.send", "sent", "今日报告");
      showToast("已模拟发送到家属微信");
    });
    const print = $("#familyPrint");
    if (print) print.addEventListener("click", () => openPrintWindow("今日照护回执", receiptHTML(r), "receipt"));
    const doctor = $("#familyDoctor");
    if (doctor) doctor.addEventListener("click", () => openPrintWindow("医生只读摘要", doctorSummaryHTML(r), "doctor"));
    root.querySelectorAll("[data-alert-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.getAttribute("data-alert-index"));
        if (r.alertsList[i]) r.alertsList[i].handled = true;
        renderFamilyReport();
        showToast("已标记处理");
      });
    });
  }

  async function deleteFamilyData(r) {
    const now = nowTime();
    const receipt = "DEL-" + familyToday().replace(/-/g, "") + "-" + now.replace(/:/g, "");
    const audit = Array.isArray(r.access.audit) ? r.access.audit.slice(-20) : [];
    audit.push({ time: now, action: "删除数据", detail: receipt });
    state.familyReport = {
      date: familyToday(),
      summary: "今日数据已删除。",
      bp: "—",
      med: "—",
      alerts: 0,
      alertText: "",
      notes: [],
      messages: [],
      alertsList: [],
      followup: r.followup,
      deletedAt: now,
      deleteReceipt: receipt,
      access: {
        authorized: false,
        agent: "",
        scopes: [],
        updated: familyToday(),
        code: null,
        codeExpires: 0,
        audit: audit
      }
    };
    renderFamilyReport();
    reportAudit("privacy.delete", "deleted", receipt);
    showToast("已删除；凭证 " + receipt);
    addTrace({ tool: "privacy.delete", title: "删除今日数据", detail: "报告/告警/用药已清空；授权已撤回；凭证 " + receipt });
  }

  function notifyFamily(text) {
    const r = ensureFamilyState();
    if (!r.access.authorized) {
      addTrace({ tool: "consent.block", title: "未授权，已拦截", detail: text });
      showToast("未授权，未发送给家属");
      return;
    }
    r.messages.push({ text: text, time: nowTime() });
    renderFamilyReport();
    addTrace({ tool: "notify.family", title: "通知家属", detail: text });
    showToast("已模拟发送给家属");
  }

  function setAlert(on) {
    $("#alertBanner").classList.toggle("hidden", !on);
    $("#phoneScreen").classList.toggle("alert", on);
    if (!on) {
      state.familyReport.alertText = "";
    }
  }

  // ---------- voice ----------
  function loadVoices() {
    if (!("speechSynthesis" in window)) {
      $("#voiceStatus").textContent = "当前浏览器不支持语音播报，仅文字演示";
      $("#autoSpeak").disabled = true;
      return;
    }
    const voices = window.speechSynthesis.getVoices();
    state.cantoneseVoice = voices.find((v) => {
      const label = (v.lang + " " + v.name).toLowerCase();
      const looksCantonese = /zh[-_]hk|yue|cantonese|粵語|粤语|hiumaan|wanlung|sinji|kwan/.test(label);
      const isEnglish = /english/.test(label);
      return looksCantonese && !isEnglish;
    }) || null;
    if (state.cantoneseVoice) {
      $("#voiceStatus").textContent = "粤语声线：已就绪（" + state.cantoneseVoice.name + "）";
      $("#autoSpeak").disabled = false;
    } else {
      $("#voiceStatus").textContent = "未检测到粤语声线：可文字演示；真实设备接粤语 TTS";
      $("#autoSpeak").disabled = true;
      $("#autoSpeak").checked = false;
      state.autoSpeak = false;
    }
  }

  function maybeSpeak(text) {
    if (state.autoSpeak) speak(text);
  }

  function normalizeSpeechText(text) {
    let t = String(text || "");
    t = t.replace(/mmHg/gi, "毫米汞柱");
    t = t.replace(/mmol\s*\/\s*L/gi, "毫摩尔每升");
    t = t.replace(/(\d+(?:\.\d+)?)\s*mg\b/gi, "$1毫克");
    t = t.replace(/℃/g, "度");
    t = t.replace(/(\d{4})-(\d{1,2})-(\d{1,2})/g, (_, y, m, d) => y + "年" + Number(m) + "月" + Number(d) + "日");
    t = t.replace(/(\d{2,3})\s*\/\s*(\d{2,3})/g, "$1，$2");
    t = t.replace(/(\d+(?:\.\d+)?)\s*%/g, "百分之$1");
    return t;
  }

  function speak(text) {
    if (!("speechSynthesis" in window)) {
      showToast("当前浏览器不支持语音播报");
      return;
    }
    if (!state.cantoneseVoice) {
      showToast("浏览器未安装粤语声线，当前用文字演示；真实设备接粤语 TTS");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(normalizeSpeechText(text));
    utterance.lang = "zh-HK";
    utterance.voice = state.cantoneseVoice;
    utterance.rate = 0.82;
    utterance.pitch = 0.95;
    utterance.onerror = () => showToast("粤语播报失败，请检查浏览器语音包");
    window.speechSynthesis.speak(utterance);
  }

  // ---------- download / export ----------
  function addToCalendar() {
    downloadICS();
  }

  function downloadICS() {
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//XiangYin Health Agent//Cantonese Demo//CN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:chen-popo-followup-20261125@local",
      "DTSTAMP:20261118T040000Z",
      "DTSTART;TZID=Asia/Shanghai:20261125T090000",
      "DTEND;TZID=Asia/Shanghai:20261125T093000",
      "SUMMARY:陈婆婆复诊 · 社区医院二楼慢病门诊",
      "DESCRIPTION:带身份证、医保卡、近两个月血压记录；空肚抽血。",
      "LOCATION:社区医院二楼慢病门诊",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT24H",
      "DESCRIPTION:听日复诊，记得带身份证、医保卡、血压记录",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT2H",
      "DESCRIPTION:两个钟后复诊",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR"
    ];
    downloadBlob("陈婆婆_复诊提醒.ics", lines.join("\r\n") + "\r\n", "text/calendar;charset=utf-8");
  }

  function exportTrace() {
    const payload = {
      demo: "乡音健康管家 V1.1",
      generatedAt: new Date().toISOString(),
      profile: profile,
      trace: state.trace,
      familyReport: state.familyReport
    };
    downloadBlob("agent-trace.json", JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
    showToast("已导出 Agent 轨迹 JSON");
  }

  function downloadBlob(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- misc ----------
  function nowTime() {
    return new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
  }

  function escapeHTML(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }

  let toastTimer = null;
  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  window.__demo = {
    startScenario,
    state
  };

  init();
})();
