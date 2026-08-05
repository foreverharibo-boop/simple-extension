const MODULE_NAME = "simple_extension";

const DEFAULT_SETTINGS = Object.freeze({
  settingsVersion: 4,
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
  nativeColumns: [],
  nativeUnits: new Map(),
  observer: null,
  layoutObserver: null,
  syncTimer: null,
  normalizeTimer: null,
  normalizeInterval: null,
  originalIndex: 0,
  rendering: false,
  normalizing: false,
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
    return;
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
    folders: hasUntouchedLegacyFolders ? [] : savedFolders || [],
    assignments:
      saved.assignments && typeof saved.assignments === "object"
        ? saved.assignments
        : {},
    openFolders: hasUntouchedLegacyFolders
      ? []
      : Array.isArray(saved.openFolders)
        ? saved.openFolders
        : [],
  };
  context.extensionSettings[MODULE_NAME] = state.settings;
}

function saveSettings() {
  const context = getContext();
  if (!context?.extensionSettings) return;
  context.extensionSettings[MODULE_NAME] = state.settings;
  context.saveSettingsDebounced?.();
}

function normalizeTitle(text) {
  return String(text || "")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[⌄⌃▼▲]+$/g, "")
    .trim()
    .slice(0, 120);
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

function findTitleElement(element) {
  const selectors = [
    ":scope > .inline-drawer > .inline-drawer-toggle b",
    ":scope > .inline-drawer > .inline-drawer-toggle strong",
    ":scope > .inline-drawer > .inline-drawer-toggle",
    ":scope > .inline-drawer-toggle b",
    ":scope > .inline-drawer-toggle strong",
    ":scope > .inline-drawer-toggle",
    ".inline-drawer-header b",
    ".inline-drawer-header strong",
    ".extension-title",
    ".extension_name",
    ":scope > h3",
    ":scope > h4",
    ":scope > strong",
    ":scope > b",
    ":scope > * > h3",
    ":scope > * > h4",
    ":scope > * > strong",
    ":scope > * > b",
    '[class*="title" i]',
    '[class*="name" i]',
  ];

  for (const selector of selectors) {
    try {
      const match = element.matches(selector)
        ? element
        : element.querySelector(selector);
      if (match?.closest(".se-fixed-extension-header")) continue;
      const title = normalizeTitle(match?.textContent);
      if (title) return match;
    } catch {
      // Older Android WebViews may not support every :scope selector.
    }
  }

  return null;
}

function extractTitle(element) {
  const titleElement = findTitleElement(element);
  const title = normalizeTitle(titleElement?.textContent);
  if (title) return title;

  const labelled =
    element.getAttribute("aria-label") || element.getAttribute("title");
  if (normalizeTitle(labelled)) return normalizeTitle(labelled);

  return (
    normalizeTitle(
      (element.id || "")
        .replace(/_container$|_settings?$|_extension$/gi, "")
        .replace(/[_-]+/g, " "),
    ) || "이름 없는 확장"
  );
}

function isRenderableUnit(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.classList.contains("se-ignore-native")) return false;
  return Boolean(
    element.children.length || normalizeTitle(element.textContent).length,
  );
}

function stableKey(element, title) {
  const explicit =
    element.id || element.dataset.name || element.dataset.extension || "";
  return slugify(explicit || `${title}-${state.originalIndex}`);
}

function registerNativeUnits() {
  let changed = false;

  state.nativeColumns.forEach((column) => {
    [...column.children].forEach((element) => {
      if (!isRenderableUnit(element)) return;
      if (element.dataset.seNativeKey) return;

      const title = extractTitle(element);
      let key = stableKey(element, title);
      let suffix = 2;
      while (state.nativeUnits.has(key))
        key = `${stableKey(element, title)}-${suffix++}`;

      element.dataset.seNativeKey = key;
      element.classList.add("se-native-unit");
      state.nativeUnits.set(key, {
        key,
        title,
        element,
        originalIndex: state.originalIndex++,
      });
      changed = true;
    });
  });

  return changed;
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
    button.addEventListener("click", action);
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
      return list.sort((a, b) => a.originalIndex - b.originalIndex);
    case "folder": {
      const order = new Map(
        state.settings.folders.map((folder, index) => [folder.id, index]),
      );
      return list.sort((a, b) => {
        const aOrder = order.get(state.settings.assignments[a.key]);
        const bOrder = order.get(state.settings.assignments[b.key]);
        return (
          (aOrder ?? Number.MAX_SAFE_INTEGER) -
            (bOrder ?? Number.MAX_SAFE_INTEGER) || byName(a, b)
        );
      });
    }
    default:
      return list.sort(byName);
  }
}

function addFolder() {
  const name = normalizeTitle(
    window.prompt("새 폴더 이름을 입력해 주세요.", "새 폴더"),
  );
  if (!name) return;
  const id = `folder-${Date.now().toString(36)}`;
  state.settings.folders.push({ id, name, icon: "📁" });
  state.settings.openFolders.push(id);
  saveSettings();
  render();
}

function makeFolderMenu(folder, anchor) {
  document.querySelectorAll(".se-folder-menu").forEach((menu) => menu.remove());
  const menu = document.createElement("div");
  menu.className = "se-folder-menu";

  const rename = document.createElement("button");
  rename.type = "button";
  rename.textContent = "이름 변경";
  rename.addEventListener("click", () => {
    const name = normalizeTitle(
      window.prompt("새 폴더 이름을 입력해 주세요.", folder.name),
    );
    if (!name) return;
    folder.name = name;
    saveSettings();
    render();
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "se-danger";
  remove.textContent = "폴더 삭제";
  remove.addEventListener("click", () => {
    if (!window.confirm(`“${folder.name}” 폴더를 삭제할까요?`)) return;
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

function makeMoreButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "se-more";
  button.textContent = "⋮";
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

function findPrimaryToggle(element) {
  const selectors = [
    ":scope > .inline-drawer > .inline-drawer-toggle",
    ":scope > .inline-drawer-toggle",
    ".inline-drawer-toggle",
    ".inline-drawer-header",
  ];
  for (const selector of selectors) {
    try {
      const match = element.querySelector(selector);
      if (match) return match;
    } catch {
      // Ignore unsupported :scope selectors on older Android WebViews.
    }
  }
  return null;
}

function directChild(element, selector) {
  return [...(element?.children || [])].find((child) =>
    child.matches(selector),
  );
}

function drawerTitle(toggle, fallback = "설정") {
  const named = toggle?.querySelector("b, strong, .extension-title");
  return normalizeTitle(named?.textContent || toggle?.textContent) || fallback;
}

function findCommonAncestor(left, right, root) {
  if (!left || !right) return null;
  const leftAncestors = new Set();
  let current = left;
  while (current) {
    leftAncestors.add(current);
    if (current === root) break;
    current = current.parentElement;
  }

  current = right;
  while (current) {
    if (leftAncestors.has(current)) return current;
    if (current === root) break;
    current = current.parentElement;
  }
  return null;
}

function findPillHeader(unit, toggle) {
  const titleElement = unit.titleElement?.isConnected
    ? unit.titleElement
    : findTitleElement(unit.element);
  unit.titleElement = titleElement;
  const common = findCommonAncestor(titleElement, toggle, unit.element);
  const content = findPrimaryContent(unit);
  if (
    common &&
    common !== unit.element &&
    (!content || !common.contains(content))
  ) {
    return common;
  }
  return toggle;
}

function findPrimaryContent(unit) {
  if (unit.primaryContent?.isConnected) return unit.primaryContent;
  const header = unit.primaryToggle?.isConnected
    ? unit.primaryToggle
    : findPrimaryToggle(unit.element);
  const drawer = header?.closest(".inline-drawer");
  let content = null;
  try {
    content = drawer?.querySelector(":scope > .inline-drawer-content");
  } catch {
    // Fall through to the broad native selector.
  }
  unit.primaryContent =
    content || unit.element.querySelector(".inline-drawer-content");
  return unit.primaryContent;
}

function updateDrawerOpenState(toggle, content, fixed) {
  if (!content || !fixed) return;
  const isOpen = getComputedStyle(content).display !== "none";
  fixed.classList.toggle("is-open", isOpen);
  fixed.setAttribute("aria-expanded", String(isOpen));
  toggle?.setAttribute("aria-expanded", String(isOpen));
}

function updateNativeOpenState(unit) {
  const content = findPrimaryContent(unit);
  if (!content) return;
  const isOpen = getComputedStyle(content).display !== "none";
  unit.element.classList.toggle("se-native-unit--open", isOpen);
  unit.fixedHeader?.classList.toggle("is-open", isOpen);
  unit.fixedHeader?.setAttribute("aria-expanded", String(isOpen));
}

function markNativeContentShell(unit) {
  const content = findPrimaryContent(unit);
  if (!content) return;
  content.classList.add("se-native-primary-content");
  let shell = content.parentElement;
  while (shell && shell !== unit.element) {
    shell.classList.add("se-native-content-shell");
    shell = shell.parentElement;
  }
}

function markFixedContent(unit, content) {
  if (!content) return;
  content.classList.add("se-native-fixed-content");
  let shell = content.parentElement;
  while (shell && shell !== unit.element) {
    shell.classList.add("se-native-content-shell");
    shell = shell.parentElement;
  }
}

function setFixedHeaderContents(fixed, title) {
  let name = fixed.querySelector(":scope > .se-fixed-extension-name");
  if (!name) {
    name = document.createElement("span");
    name.className = "se-fixed-extension-name";
    fixed.append(name);
  }
  if (name.textContent !== title) name.textContent = title;

  let more = fixed.querySelector(":scope > .se-fixed-extension-more");
  if (!more) {
    more = document.createElement("span");
    more.className = "se-fixed-extension-more";
    more.textContent = "⋮";
    more.setAttribute("aria-hidden", "true");
    fixed.append(more);
  }
}

function ensureFixedHeader(unit, originalToggle, originalHeader) {
  let fixed = unit.element.querySelector(":scope > .se-fixed-extension-header");
  if (!fixed) {
    fixed = document.createElement("button");
    fixed.type = "button";
    fixed.className = "se-fixed-extension-header se-ignore-native";
    unit.element.prepend(fixed);
    fixed.addEventListener("click", () => {
      unit.primaryToggle?.click();
      requestAnimationFrame(() => updateNativeOpenState(unit));
      window.setTimeout(() => updateNativeOpenState(unit), 250);
    });
  }

  setFixedHeaderContents(fixed, unit.title);
  fixed.setAttribute("aria-label", `${unit.title} 설정 열기`);
  unit.fixedHeader = fixed;

  originalHeader?.classList.add("se-native-original-header");
  originalToggle?.classList.add("se-native-original-toggle");
  if (
    unit.titleElement &&
    originalHeader &&
    !originalHeader.contains(unit.titleElement)
  ) {
    unit.titleElement.classList.add("se-native-original-title");
  }
}

function ensureSubdrawerHeader(unit, drawer, toggle, content, index) {
  if (!drawer.dataset.seDrawerId) {
    drawer.dataset.seDrawerId = `${unit.key}-drawer-${index}`;
  }
  const drawerId = drawer.dataset.seDrawerId;
  let fixed = [
    ...unit.element.querySelectorAll(".se-fixed-subdrawer-header"),
  ].find((candidate) => candidate.dataset.seDrawerFor === drawerId);
  if (!fixed) {
    fixed = document.createElement("button");
    fixed.type = "button";
    fixed.className =
      "se-fixed-extension-header se-fixed-subdrawer-header se-ignore-native";
    fixed.dataset.seDrawerFor = drawerId;
    drawer.before(fixed);
    fixed.addEventListener("click", () => {
      toggle.click();
      requestAnimationFrame(() =>
        updateDrawerOpenState(toggle, content, fixed),
      );
      window.setTimeout(
        () => updateDrawerOpenState(toggle, content, fixed),
        250,
      );
    });
  }

  const title = drawerTitle(toggle);
  setFixedHeaderContents(fixed, title);
  fixed.setAttribute("aria-label", `${title} 설정 열기`);
  toggle.classList.add("se-native-original-toggle");
  drawer.classList.add("se-native-fixed-drawer");
  markFixedContent(unit, content);
  updateDrawerOpenState(toggle, content, fixed);
  return fixed;
}

function collectNativeDrawers(unit) {
  return [...unit.element.querySelectorAll(".inline-drawer")]
    .filter(
      (drawer) =>
        !drawer.closest(".se-fixed-extension-header, .se-native-movebar"),
    )
    .map((drawer) => ({
      drawer,
      toggle: directChild(
        drawer,
        ".inline-drawer-toggle, .inline-drawer-header",
      ),
      content: directChild(drawer, ".inline-drawer-content"),
    }))
    .filter(({ toggle, content }) => toggle && content);
}

function normalizeNativeDrawers(unit) {
  const pairs = collectNativeDrawers(unit);
  const primaryContent = findPrimaryContent(unit);
  const primaryPair = pairs.find(
    ({ toggle, content }) =>
      toggle === unit.primaryToggle || content === primaryContent,
  );

  pairs.forEach(({ drawer, toggle, content }, index) => {
    markFixedContent(unit, content);
    if (primaryPair && drawer === primaryPair.drawer) {
      toggle.classList.add("se-native-original-toggle");
      return;
    }
    ensureSubdrawerHeader(unit, drawer, toggle, content, index);
  });

  // Some extensions build a title row and arrow separately, or insert it later.
  // Every original toggle is hidden after its native click target has been mapped.
  unit.element
    .querySelectorAll(".inline-drawer-toggle, .inline-drawer-header")
    .forEach((toggle) => {
      if (toggle.closest(".se-fixed-extension-header, .se-native-movebar"))
        return;
      toggle.classList.add("se-native-original-toggle");
      const splitHeader = toggle.parentElement;
      if (
        splitHeader &&
        splitHeader !== unit.element &&
        !splitHeader.querySelector(".inline-drawer-content")
      ) {
        splitHeader.classList.add("se-native-original-header");
      }
      const icon = toggle.querySelector(
        ".inline-drawer-icon, .fa-circle-chevron-down, .fa-circle-chevron-up",
      );
      icon?.classList.add("se-native-original-toggle");
    });
}

function normalizeAllNativeUnits() {
  if (state.normalizing || state.rendering) return;
  state.normalizing = true;
  try {
    state.nativeUnits.forEach((unit) => {
      if (!state.ui?.contains(unit.element)) return;
      const header = findPrimaryToggle(unit.element);
      unit.primaryToggle = header;
      unit.primaryContent = null;
      header?.classList.add("se-native-primary-toggle");
      const pillHeader = header ? findPillHeader(unit, header) : null;
      ensureFixedHeader(unit, header, pillHeader);
      markNativeContentShell(unit);
      normalizeNativeDrawers(unit);
      updateNativeOpenState(unit);
    });
  } finally {
    state.normalizing = false;
  }
}

function normalizeSoon() {
  window.clearTimeout(state.normalizeTimer);
  state.normalizeTimer = window.setTimeout(normalizeAllNativeUnits, 40);
}

function ensureNativeMoveBar(unit) {
  const content = findPrimaryContent(unit);
  if (!content) return;

  let bar = content.querySelector(":scope > .se-native-movebar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "se-native-movebar se-ignore-native";
    content.prepend(bar);
  }
  bar.hidden = state.settings.folders.length === 0;
  bar.replaceChildren();
  if (bar.hidden) return;

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
  bar.append(label);
}

function prepareNativeUnit(unit) {
  const element = unit.element;
  element.dataset.key = unit.key;
  element.dataset.search = unit.title.toLocaleLowerCase();
  element.classList.add("se-native-unit");

  const header = findPrimaryToggle(element);
  unit.primaryToggle = header;
  unit.primaryContent = null;
  header?.classList.add("se-native-primary-toggle");
  const pillHeader = header ? findPillHeader(unit, header) : null;
  unit.pillHeader = pillHeader;
  ensureFixedHeader(unit, header, pillHeader);
  markNativeContentShell(unit);
  normalizeNativeDrawers(unit);
  if (header && !header.dataset.seNativeListener) {
    header.dataset.seNativeListener = "true";
    header.addEventListener("click", () => {
      requestAnimationFrame(() => updateNativeOpenState(unit));
      window.setTimeout(() => updateNativeOpenState(unit), 250);
    });
  }

  ensureNativeMoveBar(unit);
  requestAnimationFrame(() => updateNativeOpenState(unit));
  return element;
}

function makeFolder(folder) {
  const assigned = sortUnits(
    [...state.nativeUnits.values()].filter(
      (unit) => state.settings.assignments[unit.key] === folder.id,
    ),
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
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  });

  const content = document.createElement("div");
  content.className = "se-folder-content";
  if (!assigned.length) {
    const empty = document.createElement("div");
    empty.className = "se-empty";
    empty.textContent = "아직 이 폴더에 담긴 확장이 없어요.";
    content.append(empty);
  } else {
    assigned.forEach((unit) => content.append(prepareNativeUnit(unit)));
  }
  wrapper.append(row, content);
  return wrapper;
}

function render() {
  if (!state.ui || state.rendering) return;
  state.rendering = true;

  const retained = document.createDocumentFragment();
  state.nativeUnits.forEach((unit) => retained.append(unit.element));
  state.ui.replaceChildren();
  state.ui.append(makeThemePicker(), createToolbar());

  const folders = document.createElement("div");
  folders.className = "se-folders";
  folders.append(createSectionTitle("내 폴더", "+ 폴더 추가", addFolder));
  state.settings.folders.forEach((folder) =>
    folders.append(makeFolder(folder)),
  );
  state.ui.append(folders);

  const validFolderIds = new Set(
    state.settings.folders.map((folder) => folder.id),
  );
  const unassigned = sortUnits(
    [...state.nativeUnits.values()].filter(
      (unit) => !validFolderIds.has(state.settings.assignments[unit.key]),
    ),
  );
  const all = document.createElement("div");
  all.className = "se-all-extensions";
  const allTitle = createSectionTitle("전체 확장");
  allTitle.append(createSortControl());
  all.append(allTitle);
  const list = document.createElement("div");
  list.className = "se-extension-list";
  unassigned.forEach((unit) => list.append(prepareNativeUnit(unit)));
  if (!state.nativeUnits.size) {
    const empty = document.createElement("div");
    empty.className = "se-empty";
    empty.textContent = "실리태번 원본 확장 설정을 찾지 못했어요.";
    list.append(empty);
  }
  all.append(list);
  state.ui.append(all);

  applyTheme();
  state.rendering = false;
  normalizeSoon();
}

function applyTheme() {
  state.root?.setAttribute("data-se-theme", state.settings.theme);
  state.root
    ?.closest("#rm_extensions_block")
    ?.setAttribute("data-se-theme", state.settings.theme);
}

function applySearch(value) {
  const query = normalizeTitle(value).toLocaleLowerCase();
  state.ui.querySelectorAll(".se-native-unit").forEach((element) => {
    element.hidden = Boolean(query) && !element.dataset.search.includes(query);
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
    const unitMatch = [...folder.querySelectorAll(".se-native-unit")].some(
      (unit) => !unit.hidden,
    );
    folder.hidden = !(folderMatch || unitMatch);
  });
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
    if (registerNativeUnits()) render();
  }, 80);
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
  root.insertBefore(ui, first);
  state.ui = ui;
  state.nativeColumns.forEach((column) =>
    column.classList.add("se-native-source"),
  );

  registerNativeUnits();
  render();

  state.observer = new MutationObserver(syncSoon);
  state.nativeColumns.forEach((column) =>
    state.observer.observe(column, { childList: true, subtree: true }),
  );

  state.layoutObserver = new MutationObserver((mutations) => {
    const hasNativeChange = mutations.some((mutation) => {
      if (
        mutation.target.closest?.(
          ".se-fixed-extension-header, .se-native-movebar, .se-theme-picker",
        )
      )
        return false;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(
        (node) =>
          node.nodeType === 1 && !node.classList?.contains("se-ignore-native"),
      );
    });
    if (hasNativeChange) normalizeSoon();
  });
  state.layoutObserver.observe(state.ui, { childList: true, subtree: true });
  state.normalizeInterval = globalThis.setInterval(
    normalizeAllNativeUnits,
    500,
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

  console.info("[simple extension] native SillyTavern layout themed");
  return true;
}

if (!initialize()) {
  const timer = window.setInterval(() => {
    if (initialize()) window.clearInterval(timer);
  }, 250);
  window.setTimeout(() => window.clearInterval(timer), 15_000);
}
