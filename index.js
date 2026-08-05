const MODULE_NAME = "simple_extension";

const DEFAULT_SETTINGS = Object.freeze({
  settingsVersion: 3,
  theme: "minimal-white",
  folders: [],
  assignments: {},
  openFolders: [],
  sort: "name-asc",
});

const LEGACY_DEFAULT_FOLDER_IDS = Object.freeze([
  "favorites",
  "utility",
  "decor",
  "story",
  "experimental",
]);

const THEME_LABELS = Object.freeze({
  "sillytavern-default": "기본 테마 색상",
  "minimal-white": "미니멀 화이트",
  "light-modern": "라이트 모던",
  "dark-modern": "다크 모던",
  "pastel-soft": "파스텔 소프트",
});

const SORT_LABELS = Object.freeze({
  "name-asc": "이름순",
  "name-desc": "이름 역순",
  original: "원래 순서",
  folder: "폴더순",
});

const state = {
  initialized: false,
  settings: null,
  root: null,
  ui: null,
  parking: null,
  nativeColumns: [],
  nativeUnits: new Map(),
  units: new Map(),
  installedRecords: [],
  installedReady: false,
  activeKey: null,
  activeRow: null,
  observer: null,
  syncTimer: null,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getContext() {
  return globalThis.SillyTavern?.getContext?.() ?? null;
}

function loadSettings() {
  const context = getContext();
  if (!context?.extensionSettings) {
    state.settings = clone(DEFAULT_SETTINGS);
    return state.settings;
  }

  const saved = context.extensionSettings[MODULE_NAME] ?? {};
  const defaults = clone(DEFAULT_SETTINGS);
  const savedFolders = Array.isArray(saved.folders) ? saved.folders : null;
  const hasAssignments = Boolean(
    saved.assignments && Object.keys(saved.assignments).length,
  );
  const hasUntouchedLegacyFolders =
    !saved.settingsVersion &&
    !hasAssignments &&
    savedFolders?.length === LEGACY_DEFAULT_FOLDER_IDS.length &&
    LEGACY_DEFAULT_FOLDER_IDS.every(
      (id, index) => savedFolders[index]?.id === id,
    );
  state.settings = {
    ...defaults,
    ...saved,
    settingsVersion: defaults.settingsVersion,
    folders: hasUntouchedLegacyFolders ? [] : savedFolders || defaults.folders,
    assignments:
      saved.assignments && typeof saved.assignments === "object"
        ? saved.assignments
        : {},
    openFolders: hasUntouchedLegacyFolders
      ? []
      : Array.isArray(saved.openFolders)
        ? saved.openFolders
        : defaults.openFolders,
  };
  context.extensionSettings[MODULE_NAME] = state.settings;
  return state.settings;
}

function saveSettings() {
  const context = getContext();
  if (context?.extensionSettings) {
    context.extensionSettings[MODULE_NAME] = state.settings;
    context.saveSettingsDebounced?.();
  }
}

function slugify(text) {
  return (
    String(text || "extension")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "extension"
  );
}

function normalizeTitle(text) {
  return String(text || "")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[⌄⌃▼▲]+$/g, "")
    .trim()
    .slice(0, 90);
}

function extractTitle(element) {
  const selectors = [
    ":scope > .inline-drawer > .inline-drawer-toggle b",
    ":scope > .inline-drawer-toggle b",
    ".inline-drawer-header b",
    ".inline-drawer-header strong",
    ".extension-title",
    ".extension_name",
    ":scope > h3",
    ":scope > h4",
    ":scope > strong",
    ":scope > b",
  ];

  for (const selector of selectors) {
    try {
      const match = element.matches(selector)
        ? element
        : element.querySelector(selector);
      const title = normalizeTitle(match?.textContent);
      if (title) return title;
    } catch {
      // Older WebViews may not support every :scope form.
    }
  }

  const labelled =
    element.getAttribute("aria-label") || element.getAttribute("title");
  if (normalizeTitle(labelled)) return normalizeTitle(labelled);

  const id = element.id || element.querySelector("[id]")?.id || "";
  return (
    normalizeTitle(
      id
        .replace(/_container$|_settings?$|_extension$/gi, "")
        .replace(/[_-]+/g, " "),
    ) || "이름 없는 확장"
  );
}

function extractIconClasses(element) {
  const icon = element.querySelector(
    ".inline-drawer-header i, .inline-drawer-toggle i, i.fa-solid, i.fa-regular, i.fa-brands",
  );
  if (!icon) return [];
  return [...icon.classList]
    .filter((name) => /^(fa-|fa$)/.test(name))
    .slice(0, 8);
}

function isRenderableUnit(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.classList.contains("se-ignore-native")) return false;
  if (element.id === "se-native-parking") return false;
  if (
    element.classList.contains("extension_container") &&
    !element.children.length &&
    !normalizeTitle(element.textContent)
  )
    return false;
  return (
    element.children.length > 0 ||
    normalizeTitle(element.textContent).length > 0
  );
}

function stableKey(element, title, columnIndex, itemIndex) {
  const explicit =
    element.id || element.dataset.name || element.dataset.extension || "";
  return slugify(explicit || `${title}-${columnIndex}-${itemIndex}`);
}

function comparisonKey(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\b(extension|확장|program|프로그램)\b/gi, "")
    .replace(/[^a-z0-9가-힣]+/g, "")
    .trim();
}

function mergeInstalledCatalog() {
  const merged = new Map(state.nativeUnits);
  const unusedNative = new Set(state.nativeUnits.keys());

  state.installedRecords.forEach((record) => {
    const displayKey = comparisonKey(record.title);
    const basename =
      record.name.split("/").filter(Boolean).at(-1) || record.name;
    const internalKey = comparisonKey(basename);
    let match = null;

    for (const nativeKey of unusedNative) {
      const native = state.nativeUnits.get(nativeKey);
      const nativeTitle = comparisonKey(native.title);
      const nativeIdentity = comparisonKey(
        `${native.key} ${native.element.id || ""}`,
      );
      if (
        (displayKey && nativeTitle === displayKey) ||
        (internalKey.length >= 4 &&
          (nativeTitle.includes(internalKey) ||
            internalKey.includes(nativeTitle) ||
            nativeIdentity.includes(internalKey)))
      ) {
        match = native;
        break;
      }
    }

    if (match) {
      unusedNative.delete(match.key);
      Object.assign(match, {
        manifestName: record.name,
        originalIndex: record.originalIndex,
        hasSettings: true,
      });
      return;
    }

    const key = `installed-${slugify(record.name)}`;
    if (!merged.has(key)) {
      merged.set(key, {
        key,
        title: record.title,
        element: null,
        iconClasses: [],
        column: null,
        manifestName: record.name,
        originalIndex: record.originalIndex,
        hasSettings: false,
      });
    }
  });

  let fallbackIndex = state.installedRecords.length;
  merged.forEach((unit) => {
    if (!Number.isFinite(unit.originalIndex)) {
      unit.originalIndex = fallbackIndex++;
    }
    unit.hasSettings = Boolean(unit.element);
  });
  state.units = merged;
}

function scanNativeUnits() {
  const next = new Map();

  state.nativeColumns.forEach((column, columnIndex) => {
    [...column.children].forEach((element, itemIndex) => {
      if (!isRenderableUnit(element)) return;
      const title = extractTitle(element);
      let key =
        element.dataset.seKey ||
        stableKey(element, title, columnIndex, itemIndex);
      let suffix = 2;
      while (next.has(key) && next.get(key).element !== element) {
        key = `${stableKey(element, title, columnIndex, itemIndex)}-${suffix++}`;
      }
      element.dataset.seKey = key;
      element.classList.add("se-managed-native");
      next.set(key, {
        key,
        title,
        element,
        iconClasses: extractIconClasses(element),
        column,
        originalIndex: Number.POSITIVE_INFINITY,
        hasSettings: true,
      });
    });
  });

  state.nativeUnits = next;
  mergeInstalledCatalog();
}

async function loadInstalledCatalog() {
  try {
    const discoveryResponse = await fetch("/api/extensions/discover", {
      cache: "no-store",
    });
    if (!discoveryResponse.ok) {
      throw new Error(
        `extension discovery failed: ${discoveryResponse.status}`,
      );
    }
    const discovered = await discoveryResponse.json();
    const names = Array.isArray(discovered)
      ? discovered
          .map((item) => (typeof item === "string" ? item : item?.name))
          .filter((name) => typeof name === "string" && name)
      : [];
    const records = await Promise.all(
      names.map(async (name, originalIndex) => {
        let manifest = null;
        try {
          const response = await fetch(
            `/scripts/extensions/${name}/manifest.json`,
            { cache: "no-store" },
          );
          if (response.ok) manifest = await response.json();
        } catch (error) {
          console.debug(
            `[simple extension] manifest read skipped: ${name}`,
            error,
          );
        }
        const basename = name.split("/").filter(Boolean).at(-1) || name;
        return {
          name,
          originalIndex,
          title: normalizeTitle(manifest?.display_name || basename),
        };
      }),
    );
    state.installedRecords = records;
  } catch (error) {
    console.warn(
      "[simple extension] installed extension catalog unavailable; using visible settings only",
      error,
    );
  } finally {
    state.installedReady = true;
    scanNativeUnits();
    render();
  }
}

function makeMoreButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "se-more";
  button.textContent = "⋮";
  button.setAttribute("aria-label", label);
  button.title = label;
  return button;
}

function makeExtensionRow(unit, compact = false) {
  const row = document.createElement("div");
  row.className = `se-extension-row${compact ? " se-extension-row--compact" : ""}`;
  row.dataset.key = unit.key;
  row.dataset.search = unit.title.toLocaleLowerCase();

  const name = document.createElement("span");
  name.className = "se-extension-name";
  name.textContent = unit.title;
  row.append(name);

  const more = makeMoreButton(`${unit.title} 설정 열기`);
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleNativeSettings(unit.key, row);
  });
  row.append(more);
  return row;
}

function makeFolderMenu(folder, anchor) {
  document.querySelectorAll(".se-folder-menu").forEach((menu) => menu.remove());
  const menu = document.createElement("div");
  menu.className = "se-folder-menu";

  const rename = document.createElement("button");
  rename.type = "button";
  rename.textContent = "이름 변경";
  rename.addEventListener("click", () => {
    const nextName = window.prompt(
      "새 폴더 이름을 입력해 주세요.",
      folder.name,
    );
    const cleanName = normalizeTitle(nextName);
    if (!cleanName) return;
    folder.name = cleanName;
    saveSettings();
    render();
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "폴더 삭제";
  remove.className = "se-danger";
  remove.addEventListener("click", () => {
    if (
      !window.confirm(
        `“${folder.name}” 폴더를 삭제할까요? 확장 설정은 삭제되지 않습니다.`,
      )
    )
      return;
    state.settings.folders = state.settings.folders.filter(
      (item) => item.id !== folder.id,
    );
    Object.keys(state.settings.assignments).forEach((key) => {
      if (state.settings.assignments[key] === folder.id)
        delete state.settings.assignments[key];
    });
    state.settings.openFolders = state.settings.openFolders.filter(
      (id) => id !== folder.id,
    );
    saveSettings();
    render();
  });

  menu.append(rename, remove);
  anchor.closest(".se-folder")?.append(menu);
}

function makeFolder(folder) {
  const assigned = [...state.units.values()].filter(
    (unit) => state.settings.assignments[unit.key] === folder.id,
  );
  const wrapper = document.createElement("section");
  wrapper.className = "se-folder";
  wrapper.dataset.folderId = folder.id;
  const isOpen = state.settings.openFolders.includes(folder.id);
  wrapper.classList.toggle("is-open", isOpen);

  const row = document.createElement("div");
  row.className = "se-folder-row";
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-expanded", String(isOpen));
  const icon = document.createElement("span");
  icon.className = "se-folder-icon";
  icon.textContent = folder.icon || "📁";
  const name = document.createElement("span");
  name.className = "se-folder-name";
  name.textContent = folder.name;
  const count = document.createElement("span");
  count.className = "se-count";
  count.textContent = String(assigned.length);
  const more = makeMoreButton(`${folder.name} 폴더 메뉴`);
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    makeFolderMenu(folder, more);
  });
  row.append(icon, name, count, more);

  const toggle = () => {
    const open = state.settings.openFolders.includes(folder.id);
    state.settings.openFolders = open
      ? state.settings.openFolders.filter((id) => id !== folder.id)
      : [...state.settings.openFolders, folder.id];
    saveSettings();
    render();
  };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });

  const content = document.createElement("div");
  content.className = "se-folder-content";
  if (!assigned.length) {
    const empty = document.createElement("div");
    empty.className = "se-empty";
    empty.textContent = "아직 이 폴더에 담긴 확장이 없어요.";
    content.append(empty);
  } else {
    assigned
      .sort((a, b) => a.title.localeCompare(b.title, "ko"))
      .forEach((unit) => content.append(makeExtensionRow(unit, true)));
  }
  wrapper.append(row, content);
  return wrapper;
}

function makeThemePicker() {
  const picker = document.createElement("div");
  picker.className = "se-theme-picker";
  picker.hidden = true;
  const heading = document.createElement("div");
  heading.className = "se-theme-title";
  heading.textContent = "테마 선택";
  picker.append(heading);

  const grid = document.createElement("div");
  grid.className = "se-theme-grid";
  Object.entries(THEME_LABELS).forEach(([id, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "se-theme-card";
    button.dataset.theme = id;
    button.classList.toggle("is-selected", state.settings.theme === id);
    const preview = document.createElement("span");
    preview.className = "se-theme-preview";
    preview.innerHTML = "<i></i><b></b><em></em>";
    const text = document.createElement("span");
    text.textContent = label;
    button.append(preview, text);
    button.addEventListener("click", () => {
      state.settings.theme = id;
      saveSettings();
      applyTheme();
      renderThemePicker();
    });
    grid.append(button);
  });
  picker.append(grid);
  return picker;
}

function renderThemePicker() {
  const oldPicker = state.root.querySelector(".se-theme-picker");
  if (!oldPicker) return;
  const wasOpen = !oldPicker.hidden;
  const picker = makeThemePicker();
  picker.hidden = !wasOpen;
  oldPicker.replaceWith(picker);
}

function createToolbar() {
  const toolbar = document.createElement("div");
  toolbar.className = "se-toolbar";
  const search = document.createElement("label");
  search.className = "se-search";
  search.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "확장 검색...";
  input.autocomplete = "off";
  input.addEventListener("input", () => applySearch(input.value));
  search.append(input);
  toolbar.append(search);
  return toolbar;
}

function createSectionTitle(text, actionText, action) {
  const line = document.createElement("div");
  line.className = "se-section-title";
  const title = document.createElement("h4");
  title.textContent = text;
  line.append(title);
  if (actionText) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "se-text-button";
    button.textContent = actionText;
    if (typeof action === "function") button.addEventListener("click", action);
    else button.disabled = true;
    line.append(button);
  }
  return line;
}

function createSortControl() {
  const label = document.createElement("label");
  label.className = "se-sort";
  const text = document.createElement("span");
  text.textContent = "정렬";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "확장 정렬 기준");
  Object.entries(SORT_LABELS).forEach(([value, name]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = name;
    select.append(option);
  });
  select.value = state.settings.sort || "name-asc";
  select.addEventListener("change", () => {
    state.settings.sort = select.value;
    saveSettings();
    render();
  });
  label.append(text, select);
  return label;
}

function sortUnits(units) {
  const list = [...units];
  const byName = (a, b) => a.title.localeCompare(b.title, "ko");
  switch (state.settings.sort) {
    case "name-desc":
      return list.sort((a, b) => byName(b, a));
    case "original":
      return list.sort(
        (a, b) => a.originalIndex - b.originalIndex || byName(a, b),
      );
    case "folder": {
      const folderOrder = new Map(
        state.settings.folders.map((folder, index) => [folder.id, index]),
      );
      return list.sort((a, b) => {
        const aFolder = state.settings.assignments[a.key];
        const bFolder = state.settings.assignments[b.key];
        const aOrder = folderOrder.has(aFolder)
          ? folderOrder.get(aFolder)
          : Number.MAX_SAFE_INTEGER;
        const bOrder = folderOrder.has(bFolder)
          ? folderOrder.get(bFolder)
          : Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder || byName(a, b);
      });
    }
    case "name-asc":
    default:
      return list.sort(byName);
  }
}

function addFolder() {
  const name = normalizeTitle(
    window.prompt("새 폴더 이름을 입력해 주세요.", "새 폴더"),
  );
  if (!name) return;
  const base = `folder-${Date.now().toString(36)}`;
  state.settings.folders.push({ id: base, name, icon: "📁" });
  state.settings.openFolders.push(base);
  saveSettings();
  render();
}

function render() {
  if (!state.ui) return;
  closeNativeSettings();
  state.ui.replaceChildren();
  state.ui.append(makeThemePicker(), createToolbar());

  const folders = document.createElement("div");
  folders.className = "se-folders";
  folders.append(createSectionTitle("내 폴더", "+ 폴더 추가", addFolder));
  state.settings.folders.forEach((folder) =>
    folders.append(makeFolder(folder)),
  );
  state.ui.append(folders);

  const all = document.createElement("div");
  all.className = "se-all-extensions";
  const allTitle = createSectionTitle("전체 확장");
  allTitle.append(createSortControl());
  all.append(allTitle);
  const list = document.createElement("div");
  list.className = "se-extension-list";
  sortUnits(state.units.values()).forEach((unit) =>
    list.append(makeExtensionRow(unit)),
  );
  if (!state.units.size) {
    const empty = document.createElement("div");
    empty.className = "se-empty";
    empty.textContent = "표시할 확장 설정을 찾지 못했어요.";
    list.append(empty);
  }
  all.append(list);
  state.ui.append(all);
  applyTheme();
}

function applyTheme() {
  state.root?.setAttribute("data-se-theme", state.settings.theme);
  state.root
    ?.closest("#rm_extensions_block")
    ?.setAttribute("data-se-theme", state.settings.theme);
}

function applySearch(value) {
  const query = normalizeTitle(value).toLocaleLowerCase();
  state.ui.querySelectorAll(".se-extension-row").forEach((row) => {
    row.hidden = Boolean(query) && !row.dataset.search.includes(query);
  });
  state.ui.querySelectorAll(".se-folder").forEach((folder) => {
    if (!query) {
      folder.hidden = false;
      return;
    }
    const folderMatch = folder
      .querySelector(".se-folder-name")
      ?.textContent.toLocaleLowerCase()
      .includes(query);
    const itemMatch = [...folder.querySelectorAll(".se-extension-row")].some(
      (row) => !row.hidden,
    );
    folder.hidden = !(folderMatch || itemMatch);
  });
}

function setOnlyActiveNative(key) {
  state.units.forEach((unit, unitKey) => {
    unit.element?.classList.toggle("se-active-native", unitKey === key);
  });
}

function ensureNativeExpanded(unit) {
  if (!unit.element) return;
  const drawer = unit.element.querySelector(".inline-drawer-content");
  const toggle = unit.element.querySelector(".inline-drawer-toggle");
  if (!drawer || !toggle) return;
  requestAnimationFrame(() => {
    if (getComputedStyle(drawer).display === "none") toggle.click();
  });
}

function createMoveBar(unit) {
  const bar = document.createElement("div");
  bar.className = "se-settings-bar";
  const label = document.createElement("label");
  label.textContent = "폴더 이동";
  const select = document.createElement("select");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "미분류";
  select.append(none);
  state.settings.folders.forEach((folder) => {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = `${folder.icon || "📁"} ${folder.name}`;
    select.append(option);
  });
  select.value = state.settings.assignments[unit.key] || "";
  select.addEventListener("change", () => {
    if (select.value) state.settings.assignments[unit.key] = select.value;
    else delete state.settings.assignments[unit.key];
    saveSettings();
    render();
  });
  label.append(select);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "se-settings-close";
  close.innerHTML = '<i class="fa-solid fa-xmark"></i><span>닫기</span>';
  close.addEventListener("click", closeNativeSettings);
  bar.append(label, close);
  return bar;
}

function toggleNativeSettings(key, row) {
  if (state.activeKey === key) {
    closeNativeSettings();
    return;
  }
  closeNativeSettings();
  const unit = state.units.get(key);
  if (!unit) return;

  const slot = document.createElement("div");
  slot.className = "se-settings-slot";
  slot.dataset.key = key;
  slot.append(createMoveBar(unit));
  if (unit.element) {
    state.nativeColumns.forEach((column) => slot.append(column));
  } else {
    const empty = document.createElement("div");
    empty.className = "se-empty se-no-settings";
    empty.textContent = "이 확장은 별도로 표시할 설정 화면이 없어요.";
    slot.append(empty);
  }
  row.insertAdjacentElement("afterend", slot);
  setOnlyActiveNative(key);
  state.activeKey = key;
  state.activeRow = row;
  row.classList.add("is-active");
  ensureNativeExpanded(unit);
}

function closeNativeSettings() {
  if (!state.parking) return;
  state.nativeColumns.forEach((column) => state.parking.append(column));
  state.units.forEach((unit) =>
    unit.element?.classList.remove("se-active-native"),
  );
  state.root
    ?.querySelectorAll(".se-settings-slot")
    .forEach((slot) => slot.remove());
  state.activeRow?.classList.remove("is-active");
  state.activeKey = null;
  state.activeRow = null;
}

function styleNativeTopBar() {
  const notify = state.root.querySelector("#extensions_notify_updates");
  const details = state.root.querySelector("#extensions_details");
  const install = state.root.querySelector("#third_party_extension_button");
  const bar =
    notify?.closest(".alignitemscenter.flex-container.wide100p") ||
    details?.parentElement ||
    install?.parentElement;
  if (!bar) return;
  bar.classList.add("se-native-topbar");
  const heading = bar.querySelector("h3");
  if (heading) heading.textContent = "확장";
  if (!bar.querySelector(".se-native-palette")) {
    const palette = document.createElement("button");
    palette.type = "button";
    palette.className = "se-palette-button se-native-palette";
    palette.title = "테마 선택";
    palette.setAttribute("aria-label", "테마 선택");
    palette.innerHTML = '<i class="fa-solid fa-palette"></i>';
    palette.addEventListener("click", (event) => {
      event.stopPropagation();
      const picker = state.root.querySelector(".se-theme-picker");
      if (picker) picker.hidden = !picker.hidden;
    });
    bar.append(palette);
  }
}

function syncSoon() {
  window.clearTimeout(state.syncTimer);
  state.syncTimer = window.setTimeout(() => {
    const previous = [...state.units.keys()].join("|");
    scanNativeUnits();
    const current = [...state.units.keys()].join("|");
    if (previous !== current) render();
  }, 120);
}

function initialize() {
  if (state.initialized) return true;
  const root = document.querySelector("#rm_extensions_block .extensions_block");
  const first = document.getElementById("extensions_settings");
  const second = document.getElementById("extensions_settings2");
  if (!root || !first || !second) return false;

  state.initialized = true;
  state.root = root;
  state.nativeColumns = [first, second];
  loadSettings();
  styleNativeTopBar();

  const ui = document.createElement("div");
  ui.id = "simple-extension-ui";
  ui.className = "se-ui se-ignore-native";
  const parking = document.createElement("div");
  parking.id = "se-native-parking";
  parking.className = "se-native-parking se-ignore-native";
  root.insertBefore(ui, first);
  root.insertBefore(parking, first);
  parking.append(first, second);
  state.ui = ui;
  state.parking = parking;

  state.nativeColumns.forEach((column) =>
    column.classList.add("se-native-column"),
  );
  scanNativeUnits();
  render();
  void loadInstalledCatalog();

  state.observer = new MutationObserver(syncSoon);
  state.nativeColumns.forEach((column) =>
    state.observer.observe(column, { childList: true, subtree: true }),
  );
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".se-theme-picker, .se-palette-button")) {
      const picker = state.root?.querySelector(".se-theme-picker");
      if (picker) picker.hidden = true;
    }
    if (!event.target.closest(".se-folder-menu, .se-more")) {
      document
        .querySelectorAll(".se-folder-menu")
        .forEach((menu) => menu.remove());
    }
  });
  console.info("[simple extension] loaded for SillyTavern 1.18");
  return true;
}

function start() {
  if (initialize()) return;
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    if (initialize() || attempts > 100) window.clearInterval(timer);
  }, 100);
}

const context = getContext();
const appReady = context?.event_types?.APP_READY;
if (context?.eventSource && appReady) {
  context.eventSource.on(appReady, () => window.setTimeout(start, 0));
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  window.setTimeout(start, 0);
}
