(() => {
  "use strict";

  const data = window.STATIC_DEMO_DATA;
  const pages = [
    { key: "summary", label: "エグゼクティブ サマリー", title: "M365 License FinOps  /  ライセンス運用サマリー" },
    { key: "department", label: "部門比較", title: "M365 License FinOps  /  部門別の利用効率" },
    { key: "features", label: "E5機能チェック", title: "M365 License FinOps  /  E5の高度機能が誰に有効かを確認" },
    { key: "users", label: "ユーザー・Copilot詳細", title: "M365 License FinOps  /  ユーザー・Copilot利用状況" }
  ];

  document.body.innerHTML = `
    <a class="skip-link" href="#reportCanvas">メイン コンテンツにスキップ</a>
    <div class="pbi-host">
      <main class="pbi-stage" id="pbiStage">
        <div class="pbi-canvas-wrap" id="canvasWrap"><section id="reportCanvas" class="pbi-report-page" aria-live="polite"></section></div>
      </main>
      <footer class="pbi-footer">
        <a class="pbi-brand-link" href="https://powerbi.microsoft.com/" target="_blank" rel="noreferrer">Microsoft Power BI</a>
        <div class="pbi-page-controls">
          <button class="pbi-footer-button" id="previousPage" type="button" aria-label="前のページ" title="前のページ"><i data-lucide="chevron-left"></i></button>
          <button class="pbi-page-indicator" id="pageIndicator" type="button" aria-haspopup="menu" aria-expanded="false"></button>
          <button class="pbi-footer-button" id="nextPage" type="button" aria-label="次のページ" title="次のページ"><i data-lucide="chevron-right"></i></button>
        </div>
        <div class="pbi-footer-right">
          <div class="pbi-zoom-controls">
            <button class="pbi-footer-button" id="zoomOut" type="button" aria-label="縮小" title="縮小"><i data-lucide="minus"></i></button>
            <input class="pbi-zoom-range" id="zoomRange" type="range" min="50" max="150" step="5" value="100" aria-label="ズーム レベル">
            <button class="pbi-footer-button" id="zoomIn" type="button" aria-label="拡大" title="拡大"><i data-lucide="plus"></i></button>
            <span class="pbi-zoom-text" id="zoomText"></span>
            <button class="pbi-footer-button" id="fitPage" type="button" aria-label="ページに合わせる" title="ページに合わせる"><i data-lucide="scan"></i></button>
          </div>
          <div class="pbi-social-controls" aria-label="共有先">
            <span class="pbi-footer-button pbi-social-button" aria-hidden="true">f</span>
            <span class="pbi-footer-button pbi-social-button" aria-hidden="true">𝕏</span>
            <span class="pbi-footer-button pbi-social-button" aria-hidden="true">in</span>
          </div>
          <button class="pbi-footer-button" id="sharePage" type="button" aria-label="共有" title="共有"><i data-lucide="share-2"></i></button>
          <button class="pbi-footer-button" id="fullScreen" type="button" aria-label="全画面表示モードで開く" title="全画面表示モードで開く"><i data-lucide="maximize-2"></i></button>
        </div>
        <div class="pbi-page-menu" id="pageMenu" role="menu">${pages.map((page, index) => `<button type="button" role="menuitem" data-page-index="${index}">${page.label}</button>`).join("")}</div>
      </footer>
    </div>
    <div class="pbi-toast" id="toast" role="status" hidden></div>`;

  const reportCanvas = document.getElementById("reportCanvas");
  const stage = document.getElementById("pbiStage");
  const canvasWrap = document.getElementById("canvasWrap");
  const pageIndicator = document.getElementById("pageIndicator");
  const pageMenu = document.getElementById("pageMenu");
  const zoomRange = document.getElementById("zoomRange");
  const zoomText = document.getElementById("zoomText");
  const toast = document.getElementById("toast");
  const charts = [];
  let toastTimer;
  let fitScale = 1;

  if (!data) {
    reportCanvas.innerHTML = '<div class="pbi-error">固定データを読み込めませんでした。</div>';
    return;
  }

  const state = {
    pageIndex: 0,
    zoom: 1,
    skuId: "all",
    location: "all",
    selectedDepartment: null,
    selectedUserId: null,
    expandedFeatures: new Set(),
    selectedFeature: null,
    selectedPlanId: null
  };

  const usersById = new Map(data.users.map((row) => [row.userId, row]));
  const skusById = new Map(data.skus.map((row) => [row.skuId, row]));
  const pricesBySku = new Map(data.prices.map((row) => [row.skuId, Number(row.monthlyUnitPrice) || 0]));
  const utilizationByUser = groupBy(data.utilization, "userId");
  const copilotByUser = new Map(data.copilotUsage.map((row) => [row.userId, row]));
  const m365ByUser = new Map(data.m365Usage.map((row) => [row.userId, row]));
  const e5Sku = data.skus.find((row) => /\bE5\b/i.test(row.licenseName));
  const statusPriority = ["Active", "LowUsage", "Dormant", "DisabledAccount", "NeverUsed"];

  function groupBy(rows, key) {
    const map = new Map();
    rows.forEach((row) => {
      const value = row[key];
      if (!map.has(value)) map.set(value, []);
      map.get(value).push(row);
    });
    return map;
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function text(value, fallback = "Unassigned") {
    return String(value ?? "").trim() || fallback;
  }

  function number(value) { return Number(value) || 0; }
  function unique(values) { return [...new Set(values)]; }
  function formatNumber(value, digits = 0) { return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: digits }).format(number(value)); }
  function formatCompactYen(value) { return `¥${Math.round(number(value) / 1000)}K`; }
  function formatPercent(value) { return new Intl.NumberFormat("ja-JP", { style: "percent", maximumFractionDigits: 1 }).format(Number.isFinite(value) ? value : 0); }
  function formatDate(value) {
    if (!value) return "—";
    const raw = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? raw.slice(0, 10) : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function department(user) { return text(user?.department); }
  function userStatus(userId) {
    const statuses = new Set((utilizationByUser.get(userId) || []).map((row) => row.utilizationStatus));
    return statusPriority.find((status) => statuses.has(status)) || "NeverUsed";
  }
  function lastActivity(userId) {
    return (utilizationByUser.get(userId) || []).map((row) => row.lastActivityDate).filter(Boolean).sort().at(-1) || null;
  }
  function sumCost(rows) { return rows.reduce((sum, row) => sum + (pricesBySku.get(row.skuId) || 0), 0); }

  function colors() {
    const styles = getComputedStyle(document.documentElement);
    const get = (name) => styles.getPropertyValue(name).trim();
    return {
      text: get("--cp-pbi-text"), muted: get("--cp-pbi-muted"), teal: get("--cp-pbi-teal"),
      tealDark: get("--cp-pbi-teal-dark"), blue: get("--cp-pbi-blue"), grid: get("--cp-pbi-grid"),
      panel: get("--cp-pbi-panel"), pie: [1,2,3,4,5,6,7,8,9,10].map((index) => get(`--cp-pbi-pie-${index}`))
    };
  }

  function pageTitle(title) { return `<div class="pbi-page-title">${escapeHtml(title)}</div>`; }
  function panel(title, content, extraClass = "") { return `<section class="pbi-panel ${extraClass}"><div class="pbi-panel-title">${escapeHtml(title)}</div>${content}</section>`; }
  function kpi(title, value) { return `<section class="pbi-panel pbi-kpi"><div class="pbi-panel-title">${escapeHtml(title)}</div><div class="pbi-kpi-inner">${escapeHtml(value)}</div></section>`; }
  function slicer(title, label, id, options, selected) {
    return `<section class="pbi-panel pbi-slicer"><div class="pbi-panel-title">${escapeHtml(title)}</div><div class="pbi-slicer-label">${escapeHtml(label)}</div><select id="${id}">${options.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === selected ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></section>`;
  }

  function baseUtilization({ departmentFilter = false } = {}) {
    return data.utilization.filter((row) => {
      const user = usersById.get(row.userId);
      if (!user) return false;
      if (state.skuId !== "all" && row.skuId !== state.skuId) return false;
      if (state.location !== "all" && text(user.officeLocation) !== state.location) return false;
      if (departmentFilter && state.selectedDepartment && department(user) !== state.selectedDepartment) return false;
      return true;
    });
  }

  function departmentMetrics(rows = data.utilization) {
    const map = new Map();
    rows.forEach((row) => {
      const user = usersById.get(row.userId);
      if (!user) return;
      const name = department(user);
      if (!map.has(name)) map.set(name, { name, userIds: new Set(), activeUserIds: new Set(), assignedSeats: 0, activeSeats: 0, cost: 0, recoverableCost: 0 });
      const metric = map.get(name);
      metric.userIds.add(row.userId);
      metric.assignedSeats += 1;
      if (row.utilizationStatus === "Active") { metric.activeUserIds.add(row.userId); metric.activeSeats += 1; }
      const price = pricesBySku.get(row.skuId) || 0;
      metric.cost += price;
      if (["Dormant", "NeverUsed", "DisabledAccount"].includes(row.utilizationStatus)) metric.recoverableCost += price;
    });
    return [...map.values()].map((metric) => ({ ...metric, users: metric.userIds.size, activeUsers: metric.activeUserIds.size })).sort((a, b) => b.users - a.users || a.name.localeCompare(b.name, "ja"));
  }

  function renderSummary() {
    const chartRows = baseUtilization();
    const rows = baseUtilization({ departmentFilter: true });
    const userIds = unique(rows.map((row) => row.userId));
    const assignmentCounts = new Map(userIds.map((id) => [id, rows.filter((row) => row.userId === id).length]));
    const users = userIds.map((id) => usersById.get(id)).filter(Boolean).sort((a, b) =>
      (assignmentCounts.get(b.userId) || 0) - (assignmentCounts.get(a.userId) || 0) ||
      a.displayName.localeCompare(b.displayName, "en")
    );
    const skuOptions = [{ value: "all", label: "すべて" }, ...data.skus.map((sku) => ({ value: sku.skuId, label: sku.licenseName }))];
    const locations = unique(data.users.filter((user) => data.utilization.some((row) => row.userId === user.userId)).map((user) => text(user.officeLocation))).sort((a,b) => a.localeCompare(b,"ja"));
    const locationOptions = [{ value: "all", label: "すべて" }, ...locations.map((value) => ({ value, label: value }))];
    const table = `<div class="pbi-table-wrap"><table class="pbi-table"><colgroup><col style="width:24%"><col style="width:22%"><col style="width:15%"><col style="width:26%"><col style="width:13%"></colgroup><thead><tr><th>氏名</th><th>部門</th><th>拠点</th><th>役職</th><th class="numeric">割当数</th></tr></thead><tbody>${users.map((user) => {
      const assignmentCount = assignmentCounts.get(user.userId) || 0;
      return `<tr data-user-id="${escapeHtml(user.userId)}" class="${state.selectedUserId === user.userId ? "is-selected" : ""}"><td>${escapeHtml(user.displayName)}</td><td>${escapeHtml(department(user))}</td><td>${escapeHtml(text(user.officeLocation))}</td><td>${escapeHtml(text(user.jobTitle))}</td><td class="numeric">${assignmentCount}</td></tr>`;
    }).join("")}</tbody></table></div>`;
    return `<div class="pbi-page-summary">${pageTitle(pages[0].title)}<div class="pbi-top-grid">${slicer("ライセンスを選択", "ライセンス名", "skuSlicer", skuOptions, state.skuId)}${slicer("拠点を選択", "拠点", "locationSlicer", locationOptions, state.location)}${kpi("ライセンス保有ユーザー", formatNumber(users.length))}${kpi("推定月額コスト", formatCompactYen(sumCost(rows)))}</div><div class="pbi-main-grid">${panel("部門別 割当ユーザー", '<div id="summaryDepartmentChart" class="pbi-chart" role="img" aria-label="部門別割当ユーザー"></div>')}${panel("割当ユーザー一覧", table)}</div></div>`;
  }

  function renderDepartment() {
    const allRows = data.utilization;
    const rows = state.selectedDepartment ? allRows.filter((row) => department(usersById.get(row.userId)) === state.selectedDepartment) : allRows;
    const users = unique(rows.map((row) => row.userId));
    const activeUsers = unique(rows.filter((row) => row.utilizationStatus === "Active").map((row) => row.userId));
    const cost = sumCost(rows);
    const recoverable = sumCost(rows.filter((row) => ["Dormant", "NeverUsed", "DisabledAccount"].includes(row.utilizationStatus)));
    return `<div class="pbi-page-department">${pageTitle(pages[1].title)}<div class="pbi-top-grid">${kpi("ライセンス保有ユーザー", formatNumber(users.length))}${kpi("Activeユーザー", formatNumber(activeUsers.length))}${kpi("Activeユーザー単価", formatCompactYen(activeUsers.length ? cost / activeUsers.length : 0))}${kpi("削減可能率", formatPercent(cost ? recoverable / cost : 0))}</div><div class="pbi-main-grid equal">${panel("部門別 Active / 割り当て", '<div id="departmentActivityChart" class="pbi-chart" role="img" aria-label="部門別Activeと割り当て"></div>')}${panel("部門別 削減可能額", '<div id="departmentSavingsChart" class="pbi-chart" role="img" aria-label="部門別削減可能額"></div>')}</div></div>`;
  }

  function buildFeatures() {
    const e5UserIds = new Set(data.utilization.filter((row) => row.skuId === e5Sku?.skuId).map((row) => row.userId));
    const e5Users = [...e5UserIds].map((id) => usersById.get(id)).filter(Boolean).sort((a,b) => a.displayName.localeCompare(b.displayName,"en"));
    const plans = data.servicePlans.filter((plan) => Boolean(plan.isReportable));
    const groups = groupBy(plans, "featureName");
    const entitlements = new Map();
    data.entitlements.filter((row) => row.skuId === e5Sku?.skuId && e5UserIds.has(row.userId)).forEach((row) => entitlements.set(`${row.userId}|${row.servicePlanId}`, Boolean(row.isEnabled)));
    const features = [...groups.entries()].map(([featureName, featurePlans]) => {
      const users = e5Users.map((user) => ({ user, enabled: featurePlans.every((plan) => entitlements.get(`${user.userId}|${plan.servicePlanId}`) === true) }));
      const enabledCount = users.filter((entry) => entry.enabled).length;
      const activeCount = users.filter((entry) => userStatus(entry.user.userId) === "Active").length;
      return { featureName, category: text(featurePlans[0]?.category, "その他"), plans: featurePlans, users, enabledCount, activeCount, allEnabled: enabledCount === e5Users.length };
    }).sort((a,b) => a.featureName.localeCompare(b.featureName,"ja"));
    if (!state.selectedFeature || !features.some((feature) => feature.featureName === state.selectedFeature)) state.selectedFeature = features[0]?.featureName || null;
    return { e5Users, features, entitlements };
  }

  function featureMatrix(metrics) {
    const rows = [];
    metrics.features.forEach((feature) => {
      const expanded = state.expandedFeatures.has(feature.featureName);
      rows.push(`<tr data-feature="${escapeHtml(feature.featureName)}" class="${state.selectedFeature === feature.featureName && !state.selectedPlanId ? "is-selected" : ""}"><td><div class="pbi-matrix-label"><button class="pbi-expander" type="button" data-toggle-feature="${escapeHtml(feature.featureName)}" aria-label="${expanded ? "折りたたみ" : "展開"}">${expanded ? "−" : "+"}</button><span>${escapeHtml(feature.featureName)}</span></div></td><td class="numeric">${feature.enabledCount}</td><td class="numeric">${feature.activeCount}</td></tr>`);
      if (expanded) feature.plans.forEach((plan) => rows.push(`<tr class="pbi-plan-row ${state.selectedPlanId === plan.servicePlanId ? "is-selected" : ""}" data-feature="${escapeHtml(feature.featureName)}" data-plan-id="${escapeHtml(plan.servicePlanId)}"><td>${escapeHtml(plan.servicePlanName)}</td><td class="numeric">${feature.enabledCount}</td><td class="numeric">${feature.activeCount}</td></tr>`));
    });
    return `<div class="pbi-table-wrap"><table class="pbi-table"><colgroup><col style="width:72%"><col style="width:14%"><col style="width:14%"></colgroup><thead><tr><th>機能名</th><th class="numeric">有効ユーザー数</th><th class="numeric">利用中ユーザー数</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  }

  function selectedFeatureUsers(metrics) {
    const feature = metrics.features.find((item) => item.featureName === state.selectedFeature) || metrics.features[0];
    if (!feature) return [];
    if (!state.selectedPlanId) return feature.users.map((entry) => ({ ...entry, planEnabled: entry.enabled }));
    return feature.users.map((entry) => ({ ...entry, planEnabled: metrics.entitlements.get(`${entry.user.userId}|${state.selectedPlanId}`) === true }));
  }

  function renderFeatures() {
    const metrics = buildFeatures();
    const allEnabled = metrics.features.filter((feature) => feature.allEnabled).length;
    const review = metrics.features.length - allEnabled;
    const selectedUsers = selectedFeatureUsers(metrics);
    const userTable = `<div class="pbi-table-wrap"><table class="pbi-table"><colgroup><col style="width:23%"><col style="width:20%"><col style="width:15%"><col style="width:13%"><col style="width:14%"><col style="width:15%"></colgroup><thead><tr><th>氏名</th><th>部門</th><th>拠点</th><th>機能の設定</th><th>利用状態</th><th>最終利用日</th></tr></thead><tbody>${selectedUsers.map(({ user, planEnabled }) => `<tr data-user-id="${escapeHtml(user.userId)}" class="${state.selectedUserId === user.userId ? "is-selected" : ""}"><td>${escapeHtml(user.displayName)}</td><td>${escapeHtml(department(user))}</td><td>${escapeHtml(text(user.officeLocation))}</td><td>${planEnabled ? "有効" : "無効"}</td><td>${escapeHtml(userStatus(user.userId))}</td><td>${formatDate(lastActivity(user.userId))}</td></tr>`).join("")}</tbody></table></div>`;
    return `<div class="pbi-page-features">${pageTitle(pages[2].title)}<div class="pbi-top-grid">${kpi("Microsoft 365 E5 ユーザー", formatNumber(metrics.e5Users.length))}${kpi("確認する高度機能", formatNumber(metrics.features.length))}${kpi("全対象ユーザーで有効", formatNumber(allEnabled))}${kpi("一部または全員で無効", formatNumber(review))}</div><div class="pbi-feature-middle">${panel("機能カテゴリ別の確認対象数", '<div id="featureCategoryChart" class="pbi-chart" role="img" aria-label="機能カテゴリ別の確認対象数"></div>')}${panel("E5の高度機能（機能名の＋で管理センターの品番を展開）", featureMatrix(metrics))}</div><div class="pbi-feature-bottom">${panel("選択中の機能の対象ユーザー", userTable)}${panel("部門別のE5利用割合", '<div id="e5DepartmentChart" class="pbi-chart" role="img" aria-label="部門別のE5利用割合"></div>')}</div></div>`;
  }

  function renderUsers() {
    const userIds = unique(data.utilization.map((row) => row.userId));
    const users = userIds.map((id) => usersById.get(id)).filter(Boolean).sort((a,b) => a.displayName.localeCompare(b.displayName,"en"));
    const copilotRows = data.copilotUsage.filter((row) => userIds.includes(row.userId));
    const activeCopilot = copilotRows.filter((row) => row.lastActivityDate);
    const prompts = copilotRows.reduce((sum,row) => sum + number(row.promptsAnyApp), 0);
    const m365Active = data.m365Usage.filter((row) => userIds.includes(row.userId) && row.overallLastActivityDate).length;
    const table = `<div class="pbi-table-wrap"><table class="pbi-table"><colgroup><col style="width:26%"><col style="width:24%"><col style="width:18%"><col style="width:18%"><col style="width:14%"></colgroup><thead><tr><th>氏名</th><th>部門</th><th>利用状態</th><th>最終利用日</th><th class="numeric">プロンプト数</th></tr></thead><tbody>${users.map((user) => `<tr data-user-id="${escapeHtml(user.userId)}" class="${state.selectedUserId === user.userId ? "is-selected" : ""}"><td>${escapeHtml(user.displayName)}</td><td>${escapeHtml(department(user))}</td><td>${escapeHtml(userStatus(user.userId))}</td><td>${formatDate(lastActivity(user.userId))}</td><td class="numeric">${formatNumber(copilotByUser.get(user.userId)?.promptsAnyApp)}</td></tr>`).join("")}</tbody></table></div>`;
    return `<div class="pbi-page-users">${pageTitle(pages[3].title)}<div class="pbi-top-grid">${kpi("Copilot Activeユーザー", formatNumber(activeCopilot.length))}${kpi("Copilot プロンプト", formatNumber(prompts))}${kpi("ユーザー当たりプロンプト", (activeCopilot.length ? prompts / activeCopilot.length : 0).toFixed(1))}${kpi("M365利用ユーザー", formatNumber(m365Active))}</div><div class="pbi-main-grid">${panel("部門別 Copilotプロンプト", '<div id="copilotDepartmentChart" class="pbi-chart" role="img" aria-label="部門別Copilotプロンプト"></div>')}${panel("ユーザー利用詳細", table)}</div></div>`;
  }

  function disposeCharts() { while (charts.length) charts.pop().dispose(); }
  function chartBase() {
    const c = colors();
    return { animationDuration: 350, textStyle: { fontFamily: '"Segoe UI", Aptos, Calibri, sans-serif', color: c.text, fontSize: 11 }, tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: c.panel, borderColor: c.grid, textStyle: { color: c.text } } };
  }
  function horizontalBar(id, items, options = {}) {
    const element = document.getElementById(id); if (!element || !window.echarts) return;
    const c = colors(); const chart = window.echarts.init(element); charts.push(chart);
    const secondary = items.some((item) => item.secondary !== undefined);
    chart.setOption({ ...chartBase(), color: [c.teal, c.blue], legend: secondary ? { top: 0, left: 10, data: [options.primary || "割当", options.secondary || "Active"], textStyle: { color: c.muted, fontSize: 11 }, itemWidth: 10, itemHeight: 10 } : undefined, grid: { left: 18, right: 42, top: secondary ? 42 : 14, bottom: 18, containLabel: true }, xAxis: { type: "value", splitNumber: options.splitNumber, axisLabel: { color: c.muted, formatter: options.axisFormatter }, splitLine: { lineStyle: { color: c.grid, type: "dashed" } }, axisLine: { show: false }, axisTick: { show: false } }, yAxis: { type: "category", inverse: true, data: items.map((item) => item.name), axisLabel: { color: c.muted, width: options.axisLabelWidth || 145, overflow: "truncate" }, axisLine: { show: false }, axisTick: { show: false } }, series: [{ name: options.primary || "値", type: "bar", stack: secondary ? "total" : undefined, data: items.map((item) => item.value), barMaxWidth: 22, itemStyle: { color: c.teal }, label: { show: true, position: secondary ? "insideRight" : "right", color: c.text, formatter: options.formatter || "{c}" } }, ...(secondary ? [{ name: options.secondary || "Active", type: "bar", stack: "total", data: items.map((item) => item.secondary), barMaxWidth: 22, itemStyle: { color: c.blue }, label: { show: true, position: "insideRight", color: c.text, formatter: (params) => params.value ? params.value : "" } }] : [])] });
    if (options.onClick) chart.on("click", (params) => options.onClick(params.name));
  }
  function donut(id, items, onClick) {
    const element = document.getElementById(id); if (!element || !window.echarts) return;
    const c = colors(); const chart = window.echarts.init(element); charts.push(chart);
    chart.setOption({ ...chartBase(), color: c.pie, tooltip: { trigger: "item", backgroundColor: c.panel, borderColor: c.grid, textStyle: { color: c.text } }, legend: { type: "scroll", orient: "vertical", right: 4, top: "middle", width: "40%", textStyle: { color: c.muted, fontSize: 10 }, itemWidth: 9, itemHeight: 9 }, series: [{ type: "pie", radius: [0, "62%"], center: ["34%", "54%"], label: { show: true, color: c.text, fontSize: 9, formatter: "{b}\n{d}%" }, labelLine: { length: 6, length2: 5 }, data: items }] });
    if (onClick) chart.on("click", (params) => onClick(params.name));
  }

  function renderCharts() {
    if (state.pageIndex === 0) {
      const metrics = departmentMetrics(baseUtilization());
      horizontalBar("summaryDepartmentChart", metrics.map((item) => ({ name: item.name, value: item.users })), { axisLabelWidth: 108, splitNumber: 2, onClick: (name) => { state.selectedDepartment = state.selectedDepartment === name ? null : name; render(); } });
    }
    if (state.pageIndex === 1) {
      const metrics = departmentMetrics(data.utilization);
      horizontalBar("departmentActivityChart", metrics.map((item) => ({ name: item.name, value: item.assignedSeats, secondary: item.activeSeats })), { primary: "割当", secondary: "Active", splitNumber: 2, onClick: selectDepartment });
      horizontalBar("departmentSavingsChart", metrics.map((item) => ({ name: item.name, value: item.recoverableCost })), { splitNumber: 3, formatter: (params) => formatCompactYen(params.value), axisFormatter: (value) => formatCompactYen(value), onClick: selectDepartment });
    }
    if (state.pageIndex === 2) {
      const metrics = buildFeatures();
      const categories = [...groupBy(metrics.features, "category").entries()].map(([name, rows]) => ({ name, value: rows.length })).sort((a,b) => b.value-a.value);
      horizontalBar("featureCategoryChart", categories);
      const departments = [...groupBy(metrics.e5Users, "department").entries()].map(([name, rows]) => ({ name: text(name), value: rows.length }));
      donut("e5DepartmentChart", departments, (name) => { state.selectedDepartment = name; });
    }
    if (state.pageIndex === 3) {
      const prompts = new Map();
      data.copilotUsage.forEach((row) => { const name = department(usersById.get(row.userId)); prompts.set(name, (prompts.get(name) || 0) + number(row.promptsAnyApp)); });
      horizontalBar("copilotDepartmentChart", [...prompts.entries()].map(([name,value]) => ({name,value})).sort((a,b) => a.name.localeCompare(b.name,"ja")), { axisLabelWidth: 108, splitNumber: 2 });
    }
  }

  function selectDepartment(name) { state.selectedDepartment = state.selectedDepartment === name ? null : name; render(); }
  function render() {
    disposeCharts();
    const page = pages[state.pageIndex];
    reportCanvas.className = `pbi-report-page pbi-page-${page.key}`;
    reportCanvas.innerHTML = [renderSummary, renderDepartment, renderFeatures, renderUsers][state.pageIndex]();
    pageIndicator.textContent = `${state.pageIndex + 1} / ${pages.length}`;
    document.getElementById("previousPage").disabled = state.pageIndex === 0;
    document.getElementById("nextPage").disabled = state.pageIndex === pages.length - 1;
    pageMenu.querySelectorAll("button").forEach((button) => button.classList.toggle("is-current", Number(button.dataset.pageIndex) === state.pageIndex));
    if (window.lucide) window.lucide.createIcons();
    bindPageInteractions();
    renderCharts();
    fitCanvas();
  }

  function bindPageInteractions() {
    document.getElementById("skuSlicer")?.addEventListener("change", (event) => { state.skuId = event.target.value; state.selectedDepartment = null; render(); });
    document.getElementById("locationSlicer")?.addEventListener("change", (event) => { state.location = event.target.value; state.selectedDepartment = null; render(); });
  }

  reportCanvas.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-toggle-feature]");
    if (toggle) {
      const key = toggle.dataset.toggleFeature;
      state.expandedFeatures.has(key) ? state.expandedFeatures.delete(key) : state.expandedFeatures.add(key);
      state.selectedFeature = key; state.selectedPlanId = null; render(); return;
    }
    const featureRow = event.target.closest("[data-feature]");
    if (featureRow && state.pageIndex === 2) {
      state.selectedFeature = featureRow.dataset.feature;
      state.selectedPlanId = featureRow.dataset.planId || null;
      render(); return;
    }
    const userRow = event.target.closest("[data-user-id]");
    if (userRow) { state.selectedUserId = state.selectedUserId === userRow.dataset.userId ? null : userRow.dataset.userId; render(); }
  });

  function fitCanvas() {
    stage.style.overflow = state.zoom > 1 ? "auto" : "hidden";
    fitScale = Math.min(stage.clientWidth / 1280, stage.clientHeight / 720);
    const scale = fitScale * state.zoom;
    canvasWrap.style.width = `${1280 * scale}px`;
    canvasWrap.style.height = `${720 * scale}px`;
    reportCanvas.style.transform = `scale(${scale})`;
    zoomText.textContent = `${Math.round(scale * 100)}%`;
    charts.forEach((chart) => chart.resize());
  }
  function setPage(index) { state.pageIndex = Math.max(0, Math.min(pages.length - 1, index)); state.selectedDepartment = null; state.selectedUserId = null; pageMenu.classList.remove("is-open"); pageIndicator.setAttribute("aria-expanded", "false"); render(); }
  function setZoom(value) { state.zoom = Math.max(0.5, Math.min(1.5, value)); zoomRange.value = String(Math.round(state.zoom * 100)); fitCanvas(); }
  function showToast(message) { clearTimeout(toastTimer); toast.textContent = message; toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, 2200); }

  document.getElementById("previousPage").addEventListener("click", () => setPage(state.pageIndex - 1));
  document.getElementById("nextPage").addEventListener("click", () => setPage(state.pageIndex + 1));
  pageIndicator.addEventListener("click", () => { const open = !pageMenu.classList.contains("is-open"); pageMenu.classList.toggle("is-open", open); pageIndicator.setAttribute("aria-expanded", String(open)); });
  pageMenu.addEventListener("click", (event) => { const button = event.target.closest("[data-page-index]"); if (button) setPage(Number(button.dataset.pageIndex)); });
  document.getElementById("zoomOut").addEventListener("click", () => setZoom(state.zoom - 0.05));
  document.getElementById("zoomIn").addEventListener("click", () => setZoom(state.zoom + 0.05));
  zoomRange.addEventListener("input", () => setZoom(Number(zoomRange.value) / 100));
  document.getElementById("fitPage").addEventListener("click", () => setZoom(1));
  document.getElementById("sharePage").addEventListener("click", async () => {
    try { if (navigator.share) await navigator.share({ title: document.title, url: location.href }); else await navigator.clipboard.writeText(location.href); showToast("リンクを共有しました"); } catch { showToast("共有をキャンセルしました"); }
  });
  document.getElementById("fullScreen").addEventListener("click", async () => { if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.(); else await document.exitFullscreen?.(); });
  window.addEventListener("resize", fitCanvas);
  document.addEventListener("keydown", (event) => { if (event.key === "ArrowLeft") setPage(state.pageIndex - 1); if (event.key === "ArrowRight") setPage(state.pageIndex + 1); if (event.key === "Escape") pageMenu.classList.remove("is-open"); });

  render();
})();