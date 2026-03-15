(function () {
  "use strict";

  const DEFAULTS = Object.freeze({
    half_life_h: 30.0,
    tau_h: 24.0,
    baseline_a: 0.0,
    scale_s: 1.0,
    emin: 0.0,
    emax: 1.0,
    calibration_points: [
      [10.0, 0.5],
      [25.0, 0.72],
      [50.0, 0.82],
      [100.0, 0.87],
    ],
    days: 90,
    r_end_pct: 5.0,
    start_dose_mg: 25.0,
    mode: "peak",
    start_date: todayIso(),
    csv_filename: "schedule.csv",
    plot_filename: "schedule_summary.png",
    find_days: false,
    min_days: 1,
    max_days: 3650,
  });

  const CSV_COLUMNS = [
    "day",
    "R_target",
    "A_target",
    "dose_mg",
    "A_peak",
    "A_trough",
    "R_peak",
    "R_trough",
  ];

  const SCHEDULE_PREVIEW_COLUMNS = [
    { key: "day", label: "day" },
    { key: "weekday", label: "weekday" },
    { key: "date", label: "date" },
    { key: "dose_mg", label: "dose_mg" },
    { key: "R_target", label: "R_target" },
    { key: "R_peak", label: "R_peak" },
    { key: "R_trough", label: "R_trough" },
    { key: "A_target", label: "A_target" },
    { key: "A_peak", label: "A_peak" },
    { key: "A_trough", label: "A_trough" },
  ];

  const SCREEN_CHART_THEME = Object.freeze({
    pageFill: "#fffdfa",
    panelFill: "#fffdf9",
    panelStroke: "rgba(27,29,32,0.12)",
    legendFill: "rgba(255,255,255,0.86)",
    legendStroke: "rgba(27,29,32,0.12)",
  });

  const PRINT_CHART_THEME = Object.freeze({
    pageFill: "#ffffff",
    panelFill: "#ffffff",
    panelStroke: "rgba(27,29,32,0.12)",
    legendFill: "#ffffff",
    legendStroke: "rgba(27,29,32,0.12)",
  });

  const state = {
    values: cloneDefaults(),
    result: null,
    configUsed: null,
    calibrationPoints: null,
    n: null,
    ec50: null,
    chartSvg: "",
    effectiveDays: DEFAULTS.days,
    downloadRows: [],
    errorMessage: "",
  };

  const dom = {};
  const dualControlKeys = ["half_life_h", "tau_h", "days", "r_end_pct", "start_dose_mg"];

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheDom();
    bindEvents();
    hydrateControlsFromState();
    recompute();
  }

  function cacheDom() {
    dualControlKeys.forEach((key) => {
      dom[key + "_range"] = document.getElementById(key + "_range");
      dom[key + "_number"] = document.getElementById(key + "_number");
    });

    [
      "mode_select",
      "starting_date",
      "chart_mount",
      "schedule_table",
      "anchor-controls",
      "add-anchor",
      "download_csv",
      "print_preview",
      "reset-defaults",
    ].forEach((id) => {
      dom[id.replace(/-/g, "_")] = document.getElementById(id);
    });
  }

  function buildAnchorControls() {
    const mount = dom.anchor_controls;
    mount.innerHTML = "";
    const canRemove = state.values.calibration_points.length > 2;
    state.values.calibration_points.forEach((point, index) => {
      const row = document.createElement("div");
      row.className = "anchor-row";
      row.innerHTML = [
        `<div class="anchor-field">`,
        `<label for="anchor_${index}_dose_number">Dose</label>`,
        `<input id="anchor_${index}_dose_number" type="number" min="0.01" max="500" step="0.1" data-anchor-index="${index}" data-anchor-field="dose" value="${trimNumeric(point[0])}">`,
        `</div>`,
        `<div class="anchor-field">`,
        `<label for="anchor_${index}_response_number">Response</label>`,
        `<input id="anchor_${index}_response_number" type="number" min="0" max="1" step="0.01" data-anchor-index="${index}" data-anchor-field="response" value="${trimNumeric(point[1])}">`,
        `</div>`,
        `<button class="ghost-button anchor-remove-button" type="button" data-anchor-remove="${index}" title="Remove anchor" aria-label="Remove anchor"${canRemove ? "" : " disabled"}>x</button>`,
      ].join("");
      mount.appendChild(row);
    });
  }

  function hydrateControlsFromState() {
    dualControlKeys.forEach((key) => {
      syncDualControl(key, state.values[key]);
    });
    dom.mode_select.value = state.values.mode;
    dom.starting_date.value = state.values.start_date;
    buildAnchorControls();
  }

  function bindEvents() {
    const debouncedRecompute = debounce(recompute, 150);

    dualControlKeys.forEach((key) => {
      const rangeEl = dom[key + "_range"];
      const numberEl = dom[key + "_number"];
      rangeEl.addEventListener("input", () => {
        numberEl.value = rangeEl.value;
        updateStateFromControls();
        debouncedRecompute();
      });
      numberEl.addEventListener("input", () => {
        rangeEl.value = numberEl.value;
        updateStateFromControls();
        debouncedRecompute();
      });
    });

    dom.anchor_controls.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.dataset.anchorField) {
        return;
      }
      const index = Number(target.dataset.anchorIndex);
      const fieldIndex = target.dataset.anchorField === "dose" ? 0 : 1;
      state.values.calibration_points[index][fieldIndex] = Number(target.value);
      debouncedRecompute();
    });

    dom.anchor_controls.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const removeButton = target.closest("[data-anchor-remove]");
      if (!removeButton) {
        return;
      }
      if (state.values.calibration_points.length <= 2) {
        return;
      }
      const index = Number(removeButton.getAttribute("data-anchor-remove"));
      state.values.calibration_points.splice(index, 1);
      buildAnchorControls();
      recompute();
    });

    [
      "mode_select",
      "starting_date",
    ].forEach((key) => {
      dom[key].addEventListener("input", () => {
        updateStateFromControls();
        debouncedRecompute();
      });
      dom[key].addEventListener("change", () => {
        updateStateFromControls();
        debouncedRecompute();
      });
    });

    dom.download_csv.addEventListener("click", downloadCsv);
    dom.print_preview.addEventListener("click", openPrintPopup);
    dom.add_anchor.addEventListener("click", () => {
      state.values.calibration_points.push(defaultNewAnchorPoint());
      buildAnchorControls();
      recompute();
    });
    dom.reset_defaults.addEventListener("click", () => {
      state.values = cloneDefaults();
      hydrateControlsFromState();
      recompute();
    });
  }

  function updateStateFromControls() {
    dualControlKeys.forEach((key) => {
      state.values[key] = Number(dom[key + "_number"].value);
    });
    state.values.mode = dom.mode_select.value;
    state.values.start_date = dom.starting_date.value || todayIso();
  }

  function syncDualControl(key, value) {
    dom[key + "_range"].value = String(value);
    dom[key + "_number"].value = String(value);
  }

  function syncAnchorControl(index, field, value) {
    const input = document.getElementById(`anchor_${index}_${field}_number`);
    if (input) {
      input.value = String(value);
    }
  }

  function defaultNewAnchorPoint() {
    const last = state.values.calibration_points[state.values.calibration_points.length - 1] || DEFAULTS.calibration_points[DEFAULTS.calibration_points.length - 1];
    return [
      Math.min(500, Math.max(0.01, Number((last[0] * 1.25).toFixed(2)))),
      Math.min(1, Math.max(0, Number(last[1].toFixed(3)))),
    ];
  }

  function recompute() {
    updateStateFromControls();
    try {
      const config = configFromState(state.values);
      validateConfig(config);

      let workingConfig = { ...config };
      const eliminationLambda = eliminationRate(workingConfig.half_life_h);
      const fDaily = decayFactor(eliminationLambda, workingConfig.tau_h);
      const calibrationPoints = workingConfig.calibration_points.map((point) => [point[0], point[1]]);
      const calibrationAmountPoints = calibrationPoints.map(([dose, response]) => [
        steadyStatePeakAmountFromDailyDose(dose, workingConfig.scale_s, fDaily),
        response,
      ]);
      const [n, ec50] = calibrateHillPoints(calibrationAmountPoints, workingConfig.emin, workingConfig.emax);

      const schedule = generateSchedule(workingConfig, n, ec50, true);
      state.result = schedule;
      state.configUsed = workingConfig;
      state.calibrationPoints = calibrationPoints;
      state.n = n;
      state.ec50 = ec50;
      state.effectiveDays = workingConfig.days;
      state.errorMessage = "";
      state.chartSvg = buildSummarySvg(schedule, workingConfig, n, ec50, calibrationPoints, { width: 1180, height: 360 });
      state.downloadRows = schedule.rows.map((row) => enrichRowWithDate(row, state.values.start_date));
      render();
    } catch (error) {
      state.result = null;
      state.chartSvg = "";
      state.downloadRows = [];
      state.errorMessage = `Error: ${error.message}`;
      render();
    }
  }

  function render() {
    dom.chart_mount.innerHTML = state.chartSvg || `<div class="empty-state">${escapeHtml(state.errorMessage || "No chart available.")}</div>`;
    renderScheduleTable();
  }

  function renderScheduleTable() {
    const table = dom.schedule_table;
    const thead = table.querySelector("thead");
    const tbody = table.querySelector("tbody");
    if (!state.downloadRows.length) {
      thead.innerHTML = "";
      tbody.innerHTML = "";
      return;
    }

    thead.innerHTML = `<tr>${SCHEDULE_PREVIEW_COLUMNS.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr>`;
    tbody.innerHTML = state.downloadRows
      .slice(0, 160)
      .map((row) => {
        return `<tr>${SCHEDULE_PREVIEW_COLUMNS.map((column) => `<td>${escapeHtml(formatSchedulePreviewValue(row, column.key))}</td>`).join("")}</tr>`;
      })
      .join("");
  }

  function configFromState(values) {
    return {
      half_life_h: values.half_life_h,
      tau_h: values.tau_h,
      baseline_a: values.baseline_a,
      scale_s: values.scale_s,
      emin: values.emin,
      emax: values.emax,
      calibration_points: values.calibration_points.map((point) => [Number(point[0]), Number(point[1])]),
      days: Math.round(values.days),
      r_end_pct: values.r_end_pct,
      start_dose_mg: values.start_dose_mg,
      mode: values.mode,
    };
  }

  function validateConfig(config) {
    if (!(config.half_life_h > 0)) {
      throw new Error("half_life_h must be positive.");
    }
    if (!(config.tau_h > 0)) {
      throw new Error("tau_h must be positive.");
    }
    if (!(config.scale_s > 0)) {
      throw new Error("scale_s must be positive.");
    }
    if (!(config.emax > config.emin)) {
      throw new Error("Emax must be greater than Emin.");
    }
    if (config.calibration_points.length < 2) {
      throw new Error("At least two calibration points are required.");
    }
    config.calibration_points.forEach(([concentration, response]) => {
      if (!(concentration > 0)) {
        throw new Error("Calibration concentrations must be positive.");
      }
      if (!(response >= config.emin && response <= config.emax)) {
        throw new Error("Calibration responses must be within [emin, emax].");
      }
    });
    if (!(config.r_end_pct >= 0 && config.r_end_pct <= 100)) {
      throw new Error("r_end_pct must be within [0, 100].");
    }
    if (!(config.days > 0)) {
      throw new Error("days must be > 0.");
    }
    if (config.start_dose_mg != null && config.start_dose_mg < 0) {
      throw new Error("start_dose_mg must be >= 0 when provided.");
    }
    if (!(config.mode === "peak" || config.mode === "trough")) {
      throw new Error("mode must be 'peak' or 'trough'.");
    }
  }

  function eliminationRate(halfLifeH) {
    if (!(halfLifeH > 0)) {
      throw new Error("half_life_h must be positive.");
    }
    return Math.log(2) / halfLifeH;
  }

  function decayFactor(eliminationLambda, tauH) {
    if (!(tauH > 0)) {
      throw new Error("tau_h must be positive.");
    }
    return Math.exp(-eliminationLambda * tauH);
  }

  function steadyStatePeakAmountFromDailyDose(doseMg, scaleS, dailyDecay) {
    if (doseMg < 0) {
      throw new Error("dose_mg must be non-negative.");
    }
    if (!(scaleS > 0)) {
      throw new Error("scale_s must be positive.");
    }
    if (!(dailyDecay > 0 && dailyDecay < 1)) {
      throw new Error("daily_decay must be in (0, 1).");
    }
    return (scaleS * doseMg) / (1 - dailyDecay);
  }

  function dailyDoseForSteadyStateAmount(amount, scaleS, dailyDecay, mode) {
    if (amount < 0) {
      throw new Error("amount must be non-negative.");
    }
    if (!(scaleS > 0)) {
      throw new Error("scale_s must be positive.");
    }
    if (!(dailyDecay > 0 && dailyDecay < 1)) {
      throw new Error("daily_decay must be in (0, 1).");
    }
    if (mode === "peak") {
      return (amount * (1 - dailyDecay)) / scaleS;
    }
    if (mode === "trough") {
      return (amount * (1 - dailyDecay)) / (scaleS * dailyDecay);
    }
    throw new Error("mode must be 'peak' or 'trough'.");
  }

  function clampUnitInterval(value, epsilon) {
    const eps = epsilon == null ? 1e-9 : epsilon;
    return Math.min(1 - eps, Math.max(eps, value));
  }

  function normalizeResponse(response, emin, emax, epsilon) {
    if (!(emax > emin)) {
      throw new Error("emax must be greater than emin.");
    }
    const y = (response - emin) / (emax - emin);
    return clampUnitInterval(y, epsilon);
  }

  function hillResponse(amount, n, ec50, emin, emax) {
    if (amount < 0) {
      throw new Error("amount must be non-negative.");
    }
    if (!(n > 0)) {
      throw new Error("n must be positive.");
    }
    if (!(ec50 > 0)) {
      throw new Error("ec50 must be positive.");
    }
    const numerator = Math.pow(amount, n);
    const denominator = Math.pow(ec50, n) + numerator;
    return emin + (emax - emin) * (numerator / denominator);
  }

  function inverseHillResponse(response, n, ec50, emin, emax, epsilon) {
    if (!(n > 0)) {
      throw new Error("n must be positive.");
    }
    if (!(ec50 > 0)) {
      throw new Error("ec50 must be positive.");
    }
    const y = normalizeResponse(response, emin, emax, epsilon == null ? 1e-9 : epsilon);
    return ec50 * Math.pow(y / (1 - y), 1 / n);
  }

  function calibrateHillPoints(points, emin, emax, epsilon) {
    if (points.length < 2) {
      throw new Error("At least two calibration points are required.");
    }
    const xs = [];
    const zs = [];
    points.forEach(([concentration, response]) => {
      if (!(concentration > 0)) {
        throw new Error("Calibration concentrations must be positive.");
      }
      const y = normalizeResponse(response, emin, emax, epsilon == null ? 1e-9 : epsilon);
      xs.push(Math.log10(concentration));
      zs.push(Math.log10((1 / y) - 1));
    });
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanZ = zs.reduce((sum, value) => sum + value, 0) / zs.length;
    let sxx = 0;
    let sxz = 0;
    for (let index = 0; index < xs.length; index += 1) {
      sxx += Math.pow(xs[index] - meanX, 2);
      sxz += (xs[index] - meanX) * (zs[index] - meanZ);
    }
    if (sxx === 0) {
      throw new Error("Calibration concentrations must be distinct.");
    }
    const slope = sxz / sxx;
    const intercept = meanZ - slope * meanX;
    const n = -slope;
    if (!(n > 0)) {
      throw new Error("Derived Hill coefficient is non-positive.");
    }
    const log10Ec50 = intercept / n;
    const ec50 = Math.pow(10, log10Ec50);
    return [n, ec50];
  }

  function linearTargets(start, end, days) {
    const slope = (end - start) / days;
    const out = [];
    for (let day = 0; day <= days; day += 1) {
      out.push(start + slope * day);
    }
    return out;
  }

  function shiftedLinearTargets(start, end, days) {
    if (days <= 1) {
      return linearTargets(start, end, days);
    }
    return [start].concat(linearTargets(start, end, days - 1));
  }

  function day0PreloadIntervals(config) {
    return (100 * config.tau_h) / config.half_life_h;
  }

  function finitePreloadTroughAmount(config, fDaily) {
    const startDose = config.start_dose_mg == null ? 0 : config.start_dose_mg;
    const preloadIntervals = day0PreloadIntervals(config);
    const geometricSum = (1 - Math.pow(fDaily, preloadIntervals)) / (1 - fDaily);
    return config.baseline_a + (config.scale_s * startDose * fDaily * geometricSum);
  }

  function targetAmounts(config, n, ec50, fDaily) {
    const startDose = config.start_dose_mg == null ? 0 : config.start_dose_mg;
    const startTrough = finitePreloadTroughAmount(config, fDaily);
    const startAmount = config.mode === "peak"
      ? startTrough + (config.scale_s * startDose)
      : startTrough;
    const startResponse = hillResponse(startAmount, n, ec50, config.emin, config.emax);
    const endResponse = startResponse * (config.r_end_pct / 100);
    if (!(endResponse >= config.emin && endResponse <= config.emax)) {
      throw new Error("r_end_pct implies a final response outside [emin, emax]. Adjust r_end_pct or response bounds.");
    }
    const responses = config.mode === "peak"
      ? linearTargets(startResponse, endResponse, config.days)
      : shiftedLinearTargets(startResponse, endResponse, config.days);
    const amounts = responses.map((response) => inverseHillResponse(response, n, ec50, config.emin, config.emax));
    amounts[0] = startAmount;
    return [responses, amounts];
  }

  function generateSchedule(config, n, ec50, clampNegativeDoses) {
    validateConfig(config);
    const eliminationLambda = eliminationRate(config.half_life_h);
    const fDaily = decayFactor(eliminationLambda, config.tau_h);
    const tuple = targetAmounts(config, n, ec50, fDaily);
    const rTargets = tuple[0];
    const aTargets = tuple[1];
    const pair = config.mode === "peak"
      ? generatePeakRows(config, aTargets, rTargets, n, ec50, fDaily, clampNegativeDoses)
      : generateTroughRows(config, aTargets, rTargets, n, ec50, fDaily, clampNegativeDoses);

    return {
      rows: pair[0],
      elimination_lambda: eliminationLambda,
      daily_decay_factor: fDaily,
      negative_dose_days: pair[1],
      feasible: pair[1].length === 0,
    };
  }

  function generatePeakRows(config, aTargets, rTargets, n, ec50, fDaily, clampNegativeDoses) {
    const rows = [];
    const negativeDays = [];
    let residual = finitePreloadTroughAmount(config, fDaily);
    for (let day = 0; day <= config.days; day += 1) {
      const aTarget = aTargets[day];
      const rawDose = (day === 0 && config.start_dose_mg != null)
        ? config.start_dose_mg
        : (aTarget - residual) / config.scale_s;
      let dose = rawDose;
      if (rawDose < 0) {
        negativeDays.push(day);
        if (clampNegativeDoses) {
          dose = 0;
        }
      }
      const finalDose = clampNegativeDoses ? Math.max(0, dose) : dose;
      const aPeak = residual + (config.scale_s * finalDose);
      const aTrough = aPeak * fDaily;
      rows.push({
        day,
        r_target: rTargets[day],
        a_target: aTarget,
        dose_mg: finalDose,
        a_peak: aPeak,
        a_trough: aTrough,
        r_peak: hillResponse(aPeak, n, ec50, config.emin, config.emax),
        r_trough: hillResponse(aTrough, n, ec50, config.emin, config.emax),
        raw_dose_mg: rawDose,
      });
      residual = aTrough;
    }
    return [rows, negativeDays];
  }

  function generateTroughRows(config, aTargets, rTargets, n, ec50, fDaily, clampNegativeDoses) {
    const rows = [];
    const negativeDays = [];
    let currentTrough = finitePreloadTroughAmount(config, fDaily);
    for (let day = 0; day <= config.days; day += 1) {
      let rawDose = 0;
      if (day === 0 && config.start_dose_mg != null) {
        rawDose = config.start_dose_mg;
      } else if (day < config.days) {
        rawDose = (aTargets[day + 1] / fDaily - currentTrough) / config.scale_s;
      }
      let dose = rawDose;
      if (rawDose < 0) {
        negativeDays.push(day);
        if (clampNegativeDoses) {
          dose = 0;
        }
      }
      const boundedDose = clampNegativeDoses ? Math.max(0, dose) : dose;
      const aPeak = currentTrough + (config.scale_s * boundedDose);
      const nextTrough = aPeak * fDaily;
      rows.push({
        day,
        r_target: rTargets[day],
        a_target: aTargets[day],
        dose_mg: boundedDose,
        a_peak: aPeak,
        a_trough: currentTrough,
        r_peak: hillResponse(aPeak, n, ec50, config.emin, config.emax),
        r_trough: hillResponse(currentTrough, n, ec50, config.emin, config.emax),
        raw_dose_mg: rawDose,
      });
      currentTrough = nextTrough;
    }
    return [rows, negativeDays];
  }

  function findMinimumFeasibleDays(config, n, ec50, minDays, maxDays) {
    if (!(minDays > 0)) {
      throw new Error("min_days must be positive.");
    }
    if (maxDays < minDays) {
      throw new Error("max_days must be >= min_days.");
    }

    function isFeasible(days) {
      const candidate = { ...config, days };
      return generateSchedule(candidate, n, ec50, false).feasible;
    }

    if (isFeasible(minDays)) {
      return minDays;
    }

    let low = minDays;
    let high = minDays;
    while (high < maxDays && !isFeasible(high)) {
      high = Math.min(maxDays, high * 2);
    }
    if (!isFeasible(high)) {
      return null;
    }
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (isFeasible(mid)) {
        high = mid;
      } else {
        low = mid;
      }
    }
    return high;
  }

  function buildCommandPreview(config, calibrationPoints) {
    const parts = [
      "python -m taperingdosereponsefitter",
      `--half_life_h ${trimNumeric(config.half_life_h)}`,
      `--tau_h ${trimNumeric(config.tau_h)}`,
      `--baseline_A ${trimNumeric(config.baseline_a)}`,
      `--scale_s ${trimNumeric(config.scale_s)}`,
      `--Emin ${trimNumeric(config.emin)}`,
      `--Emax ${trimNumeric(config.emax)}`,
      `--days ${config.days}`,
      `--R_end_pct ${trimNumeric(config.r_end_pct)}`,
      `--start_dose_mg ${trimNumeric(config.start_dose_mg)}`,
      `--mode ${config.mode}`,
      `--csv ${shellQuote(normalizeFilename(state.values.csv_filename || "schedule.csv"))}`,
      `--plot_png ${shellQuote(stripFileExtension(normalizeFilename(state.values.plot_filename || "schedule_summary.png")))}`,
    ];
    calibrationPoints.forEach(([dose, response]) => {
      parts.push(`--anchor ${shellQuote(`${trimNumeric(dose)}:${trimNumeric(response)}`)}`);
    });
    if (state.values.find_days) {
      parts.push("--find_days");
      parts.push(`--min_days ${state.values.min_days}`);
      parts.push(`--max_days ${state.values.max_days}`);
    }
    return parts.join(" ");
  }

  function buildCliOutput(schedule, config, calibrationPoints, n, ec50) {
    const lines = [];
    lines.push(`Calibrated Hill params: n=${formatFixed(n, 10)}, EC50=${formatFixed(ec50, 10)}`);
    lines.push("Calibration context: sustained-dosing steady state (peak reference).");
    lines.push("Calibration check (dose observed -> model):");
    calibrationPoints.forEach(([dose, response]) => {
      const amount = steadyStatePeakAmountFromDailyDose(dose, config.scale_s, schedule.daily_decay_factor);
      const predicted = hillResponse(amount, n, ec50, config.emin, config.emax);
      lines.push(`  D=${formatFixed(dose, 6)}: ${formatFixed(response, 6)} -> ${formatFixed(predicted, 6)}`);
    });
    lines.push(`Derived taper start: start_dose_mg=${formatFixed(config.start_dose_mg, 6)} -> R_start=${formatFixed(schedule.rows[0].r_target, 6)}`);
    lines.push(`PK constants: lambda=${formatFixed(schedule.elimination_lambda, 10)} 1/h, f=${formatFixed(schedule.daily_decay_factor, 10)}`);
    lines.push(`R_end_pct=${formatFixed(config.r_end_pct, 2)}% (implied final absolute response ${formatFixed(schedule.rows[schedule.rows.length - 1].r_target, 6)})`);
    lines.push(`Mode=${config.mode}, N=${config.days}`);
    if (!schedule.feasible) {
      lines.push(`Warning: unconstrained math produced negative doses on days ${schedule.negative_dose_days.join(", ")}; values were clamped to 0 mg.`);
    }
    lines.push(`Prepared CSV download: ${normalizeFilename(state.values.csv_filename || "schedule.csv")}`);
    lines.push("Preview (first days):");
    lines.push("day | R_target | dose_mg | R_peak | R_trough");
    schedule.rows.slice(0, 10).forEach((row) => {
      lines.push(
        `${String(row.day).padStart(3, " ")} | ${padLeft(formatFixed(row.r_target, 4), 8)} | ${padLeft(formatFixed(row.dose_mg, 4), 7)} | ${padLeft(formatFixed(row.r_peak, 4), 6)} | ${padLeft(formatFixed(row.r_trough, 4), 8)}`
      );
    });
    return lines.join("\n");
  }

  function buildSummarySvg(schedule, config, n, ec50, calibrationPoints, options) {
    const width = options.width || 1180;
    const height = options.height || 360;
    const theme = options.theme || SCREEN_CHART_THEME;
    const gutter = 20;
    const panelWidth = (width - (gutter * 4)) / 3;
    const panelHeight = height - 34;
    const days = schedule.rows.map((row) => row.day);
    const doses = schedule.rows.map((row) => row.dose_mg);
    const accumulated = schedule.rows.map((row) => (config.mode === "peak" ? row.a_peak : row.a_trough));
    const rTarget = schedule.rows.map((row) => row.r_target);
    const rPeak = schedule.rows.map((row) => row.r_peak);
    const rTrough = schedule.rows.map((row) => row.r_trough);

    const positiveForCurve = doses.filter((dose) => dose > 0);
    calibrationPoints.forEach(([dose]) => {
      if (dose > 0) {
        positiveForCurve.push(dose);
      }
    });
    if (config.start_dose_mg > 0) {
      positiveForCurve.push(config.start_dose_mg);
    }
    const minPositive = positiveForCurve.length ? Math.min.apply(null, positiveForCurve) : 0.1;
    let maxPositive;
    try {
      const maxAmount = inverseHillResponse(0.9, n, ec50, config.emin, config.emax);
      maxPositive = dailyDoseForSteadyStateAmount(maxAmount, config.scale_s, schedule.daily_decay_factor, "peak");
    } catch (error) {
      maxPositive = positiveForCurve.length ? Math.max.apply(null, positiveForCurve) : 100;
    }

    const minX = Math.max(minPositive / 2, 1e-6);
    const maxX = Math.max(maxPositive, minX * 10);
    const logMin = Math.log10(minX);
    const logMax = Math.log10(maxX);
    const curveX = [];
    for (let index = 0; index <= 200; index += 1) {
      curveX.push(Math.pow(10, logMin + ((logMax - logMin) * index / 200)));
    }
    const curveY = curveX.map((dose) => {
      const amount = steadyStatePeakAmountFromDailyDose(dose, config.scale_s, schedule.daily_decay_factor);
      return hillResponse(amount, n, ec50, config.emin, config.emax);
    });

    const sections = [
      buildDosePanel(days, doses, accumulated, gutter, 18, panelWidth, panelHeight, theme),
      buildCurvePanel(curveX, curveY, calibrationPoints, config.start_dose_mg, config, n, ec50, gutter * 2 + panelWidth, 18, panelWidth, panelHeight, theme),
      buildResponsePanel(days, rTarget, rPeak, rTrough, gutter * 3 + panelWidth * 2, 18, panelWidth, panelHeight, theme),
    ].join("");

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Summary charts">`,
      `<rect width="${width}" height="${height}" fill="${theme.pageFill}" rx="18" ry="18"></rect>`,
      sections,
      `</svg>`,
    ].join("");
  }

  function buildDosePanel(days, doses, accumulated, x, y, width, height, theme) {
    const maxDose = maxOrFallback(doses, 1);
    const chart = buildChartFrame("Dose vs day", "Day", "Dose (mg)", x, y, width, height, theme);
    const inner = chart.inner;
    const dosePoints = polylinePoints(days, doses, inner.x, inner.y, inner.width, inner.height, 0, maxOrPad(days), 0, maxDose);
    const accumScaleMax = maxOrFallback(accumulated, 1);
    const accumPoints = polylinePoints(days, accumulated, inner.x, inner.y, inner.width, inner.height, 0, maxOrPad(days), 0, accumScaleMax);
    const legend = buildLegend([
      ["Dose", "#0e5a67"],
      ["Accumulated", "#c76637"],
    ], inner.x + 12, inner.y + 14, theme);
    return [
      chart.open,
      buildGrid(inner.x, inner.y, inner.width, inner.height, 5, 5),
      buildLeftAxisTicks(0, maxDose, inner),
      buildBottomLinearTicks(0, maxOrPad(days), inner, 0),
      `<polyline fill="none" stroke="#0e5a67" stroke-width="2.2" points="${dosePoints}"></polyline>`,
      `<polyline fill="none" stroke="#c76637" stroke-width="2" stroke-dasharray="8 5" points="${accumPoints}"></polyline>`,
      legend,
      chart.close,
    ].join("");
  }

  function buildCurvePanel(curveX, curveY, calibrationPoints, startDose, config, n, ec50, x, y, width, height, theme) {
    const chart = buildChartFrame("Dose-response curve", "Sustained daily dose (mg)", "Response fraction", x, y, width, height, theme);
    const inner = chart.inner;
    const curvePoints = polylinePointsLogX(curveX, curveY, inner.x, inner.y, inner.width, inner.height, curveX[0], curveX[curveX.length - 1], 0, 1);
    const anchorDots = calibrationPoints.map(([dose, response]) => {
      if (dose <= 0) {
        return "";
      }
      const px = scaleLog(dose, curveX[0], curveX[curveX.length - 1], inner.x, inner.x + inner.width);
      const py = scaleLinear(response, 0, 1, inner.y + inner.height, inner.y);
      return `<circle cx="${px}" cy="${py}" r="3.8" fill="#c76637"></circle>`;
    }).join("");
    const startLine = startDose > 0
      ? `<line x1="${scaleLog(startDose, curveX[0], curveX[curveX.length - 1], inner.x, inner.x + inner.width)}" y1="${inner.y}" x2="${scaleLog(startDose, curveX[0], curveX[curveX.length - 1], inner.x, inner.x + inner.width)}" y2="${inner.y + inner.height}" stroke="#8a3d14" stroke-dasharray="6 4" stroke-width="1.5"></line>`
      : "";
    const legend = buildLegend([
      ["Hill fit", "#0e5a67"],
      ["Anchors", "#c76637"],
      ["Start dose", "#8a3d14"],
    ], inner.x + 12, inner.y + 14, theme);
    return [
      chart.open,
      buildGrid(inner.x, inner.y, inner.width, inner.height, 5, 5),
      buildLeftAxisTicks(0, 1, inner, 2),
      buildBottomLogTicks(curveX[0], curveX[curveX.length - 1], inner),
      `<polyline fill="none" stroke="#0e5a67" stroke-width="2.2" points="${curvePoints}"></polyline>`,
      startLine,
      anchorDots,
      legend,
      chart.close,
    ].join("");
  }

  function buildResponsePanel(days, rTarget, rPeak, rTrough, x, y, width, height, theme) {
    const chart = buildChartFrame("Response vs day", "Day", "Response fraction", x, y, width, height, theme);
    const inner = chart.inner;
    const maxDay = maxOrPad(days);
    const targetPoints = polylinePoints(days, rTarget, inner.x, inner.y, inner.width, inner.height, 0, maxDay, 0, 1);
    const peakPoints = polylinePoints(days, rPeak, inner.x, inner.y, inner.width, inner.height, 0, maxDay, 0, 1);
    const troughPoints = polylinePoints(days, rTrough, inner.x, inner.y, inner.width, inner.height, 0, maxDay, 0, 1);
    const legend = buildLegend([
      ["R_target", "#0e5a67"],
      ["R_peak", "#c76637"],
      ["R_trough", "#8a3d14"],
    ], inner.x + 12, inner.y + 14, theme);
    return [
      chart.open,
      buildGrid(inner.x, inner.y, inner.width, inner.height, 5, 5),
      buildLeftAxisTicks(0, 1, inner, 2),
      buildBottomLinearTicks(0, maxDay, inner, 0),
      `<polyline fill="none" stroke="#0e5a67" stroke-width="2.2" points="${targetPoints}"></polyline>`,
      `<polyline fill="none" stroke="#c76637" stroke-width="2" stroke-dasharray="8 5" points="${peakPoints}"></polyline>`,
      `<polyline fill="none" stroke="#8a3d14" stroke-width="2" stroke-dasharray="3 5" points="${troughPoints}"></polyline>`,
      legend,
      chart.close,
    ].join("");
  }

  function buildChartFrame(title, xLabel, yLabel, x, y, width, height, theme) {
    const inner = {
      x: x + 56,
      y: y + 34,
      width: width - 98,
      height: height - 78,
    };
    const open = [
      `<g>`,
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18" ry="18" fill="${theme.panelFill}" stroke="${theme.panelStroke}"></rect>`,
      `<text x="${x + 18}" y="${y + 24}" font-family="'Segoe UI','Arial',sans-serif" font-size="16" font-weight="400" fill="#1b1d20">${escapeHtml(title)}</text>`,
      `<text x="${inner.x + inner.width / 2}" y="${y + height - 14}" font-size="10" fill="#5e615e" text-anchor="middle">${escapeHtml(xLabel)}</text>`,
      `<text transform="translate(${x + 18} ${inner.y + inner.height / 2}) rotate(-90)" font-size="10" fill="#5e615e" text-anchor="middle">${escapeHtml(yLabel)}</text>`,
    ].join("");
    const close = `</g>`;
    return { open, close, inner };
  }

  function buildLegend(items, x, y, theme) {
    const rowHeight = 16;
    const legendWidth = items.reduce((maxWidth, item) => Math.max(maxWidth, 34 + item[0].length * 6), 110);
    const legendHeight = 14 + items.length * rowHeight;
    const rows = items.map((item, index) => {
      const y0 = y + 14 + index * rowHeight;
      return [
        `<line x1="${x + 10}" y1="${y0}" x2="${x + 26}" y2="${y0}" stroke="${item[1]}" stroke-width="2.2"></line>`,
        `<text x="${x + 32}" y="${y0 + 4}" font-size="10" fill="#5e615e">${escapeHtml(item[0])}</text>`,
      ].join("");
    }).join("");
    return [
      `<rect x="${x}" y="${y}" width="${legendWidth}" height="${legendHeight}" rx="10" ry="10" fill="${theme.legendFill}" stroke="${theme.legendStroke}"></rect>`,
      rows,
    ].join("");
  }

  function buildGrid(x, y, width, height, verticalSteps, horizontalSteps) {
    const lines = [];
    for (let index = 0; index <= verticalSteps; index += 1) {
      const px = x + (width * index / verticalSteps);
      lines.push(`<line x1="${px}" y1="${y}" x2="${px}" y2="${y + height}" stroke="rgba(27,29,32,0.08)" stroke-width="1"></line>`);
    }
    for (let index = 0; index <= horizontalSteps; index += 1) {
      const py = y + (height * index / horizontalSteps);
      lines.push(`<line x1="${x}" y1="${py}" x2="${x + width}" y2="${py}" stroke="rgba(27,29,32,0.08)" stroke-width="1"></line>`);
    }
    lines.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="rgba(27,29,32,0.18)"></rect>`);
    return lines.join("");
  }

  function buildAxisTicks(min, max, count) {
    const out = [];
    if (count <= 1 || max === min) {
      return [min];
    }
    for (let index = 0; index < count; index += 1) {
      out.push(min + ((max - min) * index / (count - 1)));
    }
    return out;
  }

  function buildLeftAxisTicks(min, max, inner, decimals) {
    const ticks = buildAxisTicks(min, max, 5);
    return ticks.map((value) => {
      const py = scaleLinear(value, min, max, inner.y + inner.height, inner.y);
      return `<text x="${inner.x - 10}" y="${py + 4}" font-size="10" fill="#5e615e" text-anchor="end">${escapeHtml(formatFixed(value, decimals == null ? 2 : decimals))}</text>`;
    }).join("");
  }

  function buildBottomLogTicks(min, max, inner) {
    const minPow = Math.ceil(Math.log10(min));
    const maxPow = Math.floor(Math.log10(max));
    const labels = [];
    for (let pow = minPow; pow <= maxPow; pow += 1) {
      const value = Math.pow(10, pow);
      const px = scaleLog(value, min, max, inner.x, inner.x + inner.width);
      labels.push(`<text x="${px}" y="${inner.y + inner.height + 16}" font-size="10" fill="#5e615e" text-anchor="middle">${escapeHtml(trimNumeric(value))}</text>`);
    }
    return labels.join("");
  }

  function buildBottomLinearTicks(min, max, inner, decimals) {
    const ticks = buildAxisTicks(min, max, 6);
    return ticks.map((value) => {
      const px = scaleLinear(value, min, max, inner.x, inner.x + inner.width);
      const label = decimals === 0 ? String(Math.round(value)) : formatFixed(value, decimals == null ? 0 : decimals);
      return `<text x="${px}" y="${inner.y + inner.height + 16}" font-size="10" fill="#5e615e" text-anchor="middle">${escapeHtml(label)}</text>`;
    }).join("");
  }

  function polylinePoints(xs, ys, x, y, width, height, minX, maxX, minY, maxY) {
    return xs.map((value, index) => {
      const px = scaleLinear(value, minX, maxX, x, x + width);
      const py = scaleLinear(ys[index], minY, maxY, y + height, y);
      return `${px},${py}`;
    }).join(" ");
  }

  function polylinePointsLogX(xs, ys, x, y, width, height, minX, maxX, minY, maxY) {
    return xs.map((value, index) => {
      const px = scaleLog(value, minX, maxX, x, x + width);
      const py = scaleLinear(ys[index], minY, maxY, y + height, y);
      return `${px},${py}`;
    }).join(" ");
  }

  function scaleLinear(value, min, max, outMin, outMax) {
    if (max === min) {
      return (outMin + outMax) / 2;
    }
    return outMin + ((value - min) / (max - min)) * (outMax - outMin);
  }

  function scaleLog(value, min, max, outMin, outMax) {
    return scaleLinear(Math.log10(value), Math.log10(min), Math.log10(max), outMin, outMax);
  }

  function enrichRowWithDate(row, startDateIso) {
    const date = addDaysIso(startDateIso || todayIso(), row.day);
    return {
      date,
      day: row.day,
      weekday: weekdayShort(date),
      R_target: row.r_target,
      A_target: row.a_target,
      dose_mg: row.dose_mg,
      A_peak: row.a_peak,
      A_trough: row.a_trough,
      R_peak: row.r_peak,
      R_trough: row.r_trough,
    };
  }

  function csvStringFromRows(rows) {
    const columns = ["date"].concat(CSV_COLUMNS);
    const out = [columns.join(",")];
    rows.forEach((row) => {
      out.push(columns.map((column) => csvEscape(formatTableValue(row[column]))).join(","));
    });
    return out.join("\r\n");
  }

  function downloadCsv() {
    if (!state.downloadRows.length) {
      return;
    }
    const filename = ensureExtension(normalizeFilename(state.values.csv_filename || "schedule.csv"), ".csv");
    downloadBlob(filename, "text/csv;charset=utf-8", csvStringFromRows(state.downloadRows));
  }

  function openPrintPopup() {
    if (!state.result || !state.configUsed || !state.chartSvg) {
      return;
    }
    const popup = window.open("", "_blank", "width=1200,height=900");
    if (!popup) {
      window.alert("Popup blocked by the browser.");
      return;
    }
    popup.document.open();
    popup.document.write(buildPrintPageHtml());
    popup.document.close();
  }

  function buildPrintPageHtml() {
    const printChartSvg = buildPrintChartSvg();
    return [
      "<!doctype html>",
      "<html lang='en'>",
      "<head>",
      "<meta charset='utf-8'>",
      "<title>Print Preview - Dose Schedule</title>",
      "<style>",
      "body{font-family:'Trebuchet MS','Lucida Sans Unicode',sans-serif;margin:0;background:#ffffff;color:#1b1d20;}",
      ".shell{max-width:1180px;margin:0 auto;padding:28px;}",
      ".toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:18px;}",
      ".toolbar button{padding:10px 14px;border:0;border-radius:10px;background:#0e5a67;color:#fff;cursor:pointer;}",
      ".card{background:#ffffff;border:1px solid rgba(27,29,32,0.16);border-radius:18px;padding:22px;box-shadow:0 12px 30px rgba(25,27,30,0.08);}",
      "h1{font-family:'Palatino Linotype','Book Antiqua',Palatino,serif;margin:0 0 4px;font-size:28px;}",
      "p.meta{margin:0 0 14px;color:#5e615e;font-size:12px;}",
      ".chart{background:#ffffff;}",
      ".chart svg{width:100%;height:auto;display:block;background:#ffffff;}",
      "table{width:auto;max-width:100%;border-collapse:collapse;font-size:10px;table-layout:auto;}",
      "th,td{border:1px solid #8d8d8d;padding:2px 4px;text-align:left;white-space:nowrap;}",
      "th{background:#efefef;}",
      "th.spacer,td.spacer{border:none;background:#ffffff;width:3%;}",
      "@page{margin:20mm;}",
      "@media print{body{background:#fff;} .toolbar{display:none;} .shell{max-width:none;padding:0;} .card{border:none;box-shadow:none;padding:0;background:#fff;}}",
      "</style>",
      "</head>",
      "<body>",
      "<div class='shell'>",
      "<div class='toolbar'><strong>Print Preview</strong><button onclick='window.print()'>Print</button></div>",
      "<div class='card'>",
      "<h1>Tapering Schedule</h1>",
      `<p class='meta'>Generated: ${escapeHtml(todayIso())} | Starting date: ${escapeHtml(state.values.start_date)} | Mode: ${escapeHtml(state.configUsed.mode)}</p>`,
      `<div class='chart'>${printChartSvg}</div>`,
      buildPrintTable(state.downloadRows),
      "</div>",
      "</div>",
      "</body>",
      "</html>",
    ].join("");
  }

  function buildPrintChartSvg() {
    if (!state.result || !state.configUsed || state.n == null || state.ec50 == null || !state.calibrationPoints) {
      return "";
    }
    return buildSummarySvg(
      state.result,
      state.configUsed,
      state.n,
      state.ec50,
      state.calibrationPoints,
      { width: 1180, height: 360, theme: PRINT_CHART_THEME }
    );
  }

  function buildPrintTable(rows) {
    const entries = rows.map((row) => [row.day, row.weekday, row.date, row.dose_mg]);
    const splitIndex = Math.ceil(entries.length / 2);
    const leftRows = entries.slice(0, splitIndex);
    const rightRows = entries.slice(splitIndex);
    const totalRows = Math.max(leftRows.length, rightRows.length);
    const bodyRows = [];
    for (let index = 0; index < totalRows; index += 1) {
      const left = leftRows[index] || null;
      const right = rightRows[index] || null;
      bodyRows.push(
        "<tr>" +
          printCell(left ? left[0] : "") +
          printCell(left ? left[1] : "") +
          printCell(left ? left[2] : "") +
          printCell(left ? formatDosePreview(left[3]) : "") +
          printCell("") +
          "<td class='spacer'></td>" +
          printCell(right ? right[0] : "") +
          printCell(right ? right[1] : "") +
          printCell(right ? right[2] : "") +
          printCell(right ? formatDosePreview(right[3]) : "") +
          printCell("") +
        "</tr>"
      );
    }

    return [
      "<table>",
      "<thead><tr>",
      "<th>Day</th><th>Weekday</th><th>Date</th><th>Dose (mg)</th><th>Taken</th>",
      "<th class='spacer'></th>",
      "<th>Day</th><th>Weekday</th><th>Date</th><th>Dose (mg)</th><th>Taken</th>",
      "</tr></thead>",
      "<tbody>",
      bodyRows.join(""),
      "</tbody>",
      "</table>",
    ].join("");
  }

  function printCell(value) {
    return `<td>${value === "" ? "&nbsp;" : escapeHtml(String(value))}</td>`;
  }

  function downloadBlob(filename, type, content) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    downloadDataUrl(filename, url, true);
  }

  function downloadDataUrl(filename, url, revoke) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (revoke) {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  function normalizeFilename(name) {
    const cleaned = (name || "").trim().replace(/[\\/:*?"<>|]+/g, "_");
    return cleaned || "download";
  }

  function ensureExtension(filename, extension) {
    return filename.toLowerCase().endsWith(extension) ? filename : `${filename}${extension}`;
  }

  function stripFileExtension(filename) {
    return filename.replace(/\.[^/.]+$/, "");
  }

  function csvEscape(value) {
    const text = String(value);
    if (/[,"\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
  }

  function formatTableValue(value) {
    if (typeof value === "number") {
      return formatFixed(value, 6);
    }
    return String(value);
  }

  function formatSchedulePreviewValue(row, key) {
    if (key === "day") {
      return String(Math.round(row.day));
    }
    if (key === "weekday") {
      return row.weekday || "";
    }
    if (key === "date") {
      return row.date || "";
    }
    if (key === "dose_mg") {
      return formatDosePreview(row.dose_mg);
    }
    return formatSignificant(row[key], 3);
  }

  function formatDosePreview(value) {
    if (value == null || Number.isNaN(value)) {
      return "";
    }
    const decimals = Math.abs(Number(value)) > 2 ? 1 : 2;
    return Number(value).toFixed(decimals);
  }

  function formatSignificant(value, digits) {
    if (value == null || Number.isNaN(value)) {
      return "";
    }
    return String(Number(Number(value).toPrecision(digits == null ? 3 : digits)));
  }

  function formatFixed(value, decimals) {
    if (value == null || Number.isNaN(value)) {
      return "";
    }
    const places = decimals == null ? 3 : decimals;
    return Number(value).toFixed(places);
  }

  function trimNumeric(value) {
    if (value == null || Number.isNaN(value)) {
      return "";
    }
    return String(Number(Number(value).toFixed(12)));
  }

  function maxOrFallback(values, fallback) {
    return values.length ? Math.max.apply(null, values.concat([fallback])) : fallback;
  }

  function maxOrPad(values) {
    const max = values.length ? Math.max.apply(null, values) : 1;
    return max === 0 ? 1 : max;
  }

  function padLeft(value, length) {
    return String(value).padStart(length, " ");
  }

  function debounce(fn, waitMs) {
    let timeoutId = null;
    return function () {
      const args = arguments;
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn.apply(null, args), waitMs);
    };
  }

  function cloneDefaults() {
    return {
      half_life_h: DEFAULTS.half_life_h,
      tau_h: DEFAULTS.tau_h,
      baseline_a: DEFAULTS.baseline_a,
      scale_s: DEFAULTS.scale_s,
      emin: DEFAULTS.emin,
      emax: DEFAULTS.emax,
      calibration_points: DEFAULTS.calibration_points.map((point) => point.slice()),
      days: DEFAULTS.days,
      r_end_pct: DEFAULTS.r_end_pct,
      start_dose_mg: DEFAULTS.start_dose_mg,
      mode: DEFAULTS.mode,
      start_date: DEFAULTS.start_date,
      csv_filename: DEFAULTS.csv_filename,
      plot_filename: DEFAULTS.plot_filename,
      find_days: DEFAULTS.find_days,
      min_days: DEFAULTS.min_days,
      max_days: DEFAULTS.max_days,
    };
  }

  function addDaysIso(startIso, days) {
    const date = new Date(`${startIso}T00:00:00`);
    date.setDate(date.getDate() + days);
    return dateToIsoLocal(date);
  }

  function weekdayShort(isoDate) {
    const date = new Date(`${isoDate}T00:00:00`);
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  }

  function todayIso() {
    const now = new Date();
    return dateToIsoLocal(now);
  }

  function dateToIsoLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
