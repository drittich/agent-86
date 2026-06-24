/**
 * Provider + model state and rendering module.
 *
 * The settings UI separates two concepts across two tabs:
 *   • Providers (connections) — endpoint + credentials (name, baseUrl, apiKey).
 *   • Models — a model id attached to a provider, plus context window and an
 *     optional OpenRouter routing pin.
 *
 * Add/edit happens in modal dialogs. When the selected provider is OpenRouter
 * (detected from its base URL), the model field autocompletes from OpenRouter's
 * live catalog (fetched by the extension), falling back to a small bundled list.
 */

import { escapeHtml } from './utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProviderConnection {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
}

export interface ModelConfig {
  id: string;
  connectionId: string;
  model: string;
  label?: string;
  context: number;
  openRouterProvider?: string;
}

export interface CatalogModel {
  id: string;
  name?: string;
  context?: number;
}

interface ProviderType {
  key: 'openai' | 'anthropic' | 'openrouter' | 'compatible';
  label: string;
  baseUrl: string;
}

const PROVIDER_TYPES: ProviderType[] = [
  { key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { key: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com' },
  { key: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { key: 'compatible', label: 'OpenAI-compatible', baseUrl: '' },
];
const PRESET_BASE_URLS = PROVIDER_TYPES.map(t => t.baseUrl).filter(Boolean);

// ── Module state ──────────────────────────────────────────────────────────────

export let connections: ProviderConnection[] = [];
export let models: ModelConfig[] = [];
export let activeModelIndex = 0;

export type SettingsTab = 'providers' | 'models' | 'system';
let activeTab: SettingsTab = 'providers';

// Open dialog (mirrors the prototype's single-dialog model with a working draft).
type ProviderDraft = { type: ProviderType['key']; name: string; baseUrl: string; apiKey: string };
type ModelDraft = { connectionId: string; model: string; label: string; context: string; openRouterProvider: string };
let providerDraft: { mode: 'add' | 'edit'; id?: string; draft: ProviderDraft } | null = null;
let modelDraft: { mode: 'add' | 'edit'; id?: string; draft: ModelDraft } | null = null;

let showKey = false;
let providerMenuOpen = false;
let modelMenuOpen = false;
let suggestionsActiveIndex = -1;

let currentProviderStatus: 'online' | 'offline' | 'checking' | 'unknown' = 'unknown';

const catalogCache = new Map<string, CatalogModel[]>();

const OPENROUTER_FALLBACK: CatalogModel[] = [
  { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4', context: 200000 },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', context: 200000 },
  { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', context: 200000 },
  { id: 'openai/gpt-4o', name: 'GPT-4o', context: 128000 },
  { id: 'openai/gpt-4.1', name: 'GPT-4.1', context: 1000000 },
  { id: 'openai/o3', name: 'o3', context: 200000 },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', context: 1000000 },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', context: 64000 },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', context: 128000 },
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', context: 128000 },
  { id: 'qwen/qwen-2.5-coder-32b-instruct', name: 'Qwen2.5 Coder 32B', context: 128000 },
  { id: 'x-ai/grok-3', name: 'Grok 3', context: 131000 },
];

// ── DOM refs (set by initProviders) ─────────────────────────────────────────────

let providersList: HTMLUListElement;
let modelsList: HTMLUListElement;
let modelSelect: HTMLSelectElement;
let providerStatusDot: HTMLElement;

let tabProviders: HTMLButtonElement;
let tabModels: HTMLButtonElement;
let tabSystemPrompt: HTMLButtonElement;
let tabProvidersCount: HTMLElement;
let tabModelsCount: HTMLElement;
let providersPane: HTMLElement;
let modelsPane: HTMLElement;
let systemPromptPane: HTMLElement;

// Provider dialog
let providerDialog: HTMLElement;
let providerDialogTitle: HTMLElement;
let pfTypeChips: HTMLElement;
let pfName: HTMLInputElement;
let pfBaseUrl: HTMLInputElement;
let pfApiKey: HTMLInputElement;
let pfDetect: HTMLElement;
let btnPfToggleKey: HTMLButtonElement;

// Model dialog
let modelDialog: HTMLElement;
let modelDialogTitle: HTMLElement;
let mfNoProviders: HTMLElement;
let mfFields: HTMLElement;
let mfProviderBtn: HTMLButtonElement;
let mfProviderLabel: HTMLElement;
let mfProviderBadge: HTMLElement;
let mfProviderMenu: HTMLElement;
let mfModelGroup: HTMLElement;
let mfModel: HTMLInputElement;
let mfModelCaret: HTMLButtonElement;
let mfModelSuggestions: HTMLUListElement;
let mfModelHint: HTMLElement;
let mfLabel: HTMLInputElement;
let mfContext: HTMLInputElement;
let mfOrRow: HTMLElement;
let mfOrProvider: HTMLInputElement;
let btnMfSave: HTMLButtonElement;

let vscodeApi: { postMessage(msg: unknown): void };

// ── Init ──────────────────────────────────────────────────────────────────────

export interface ProviderRefs {
  providersList: HTMLUListElement;
  modelsList: HTMLUListElement;
  modelSelect: HTMLSelectElement;
  providerStatusDot: HTMLElement;
  tabProviders: HTMLButtonElement;
  tabModels: HTMLButtonElement;
  tabSystemPrompt: HTMLButtonElement;
  tabProvidersCount: HTMLElement;
  tabModelsCount: HTMLElement;
  providersPane: HTMLElement;
  modelsPane: HTMLElement;
  systemPromptPane: HTMLElement;
  providerDialog: HTMLElement;
  providerDialogTitle: HTMLElement;
  pfTypeChips: HTMLElement;
  pfName: HTMLInputElement;
  pfBaseUrl: HTMLInputElement;
  pfApiKey: HTMLInputElement;
  pfDetect: HTMLElement;
  btnPfToggleKey: HTMLButtonElement;
  modelDialog: HTMLElement;
  modelDialogTitle: HTMLElement;
  mfNoProviders: HTMLElement;
  mfFields: HTMLElement;
  mfProviderBtn: HTMLButtonElement;
  mfProviderLabel: HTMLElement;
  mfProviderBadge: HTMLElement;
  mfProviderMenu: HTMLElement;
  mfModelGroup: HTMLElement;
  mfModel: HTMLInputElement;
  mfModelCaret: HTMLButtonElement;
  mfModelSuggestions: HTMLUListElement;
  mfModelHint: HTMLElement;
  mfLabel: HTMLInputElement;
  mfContext: HTMLInputElement;
  mfOrRow: HTMLElement;
  mfOrProvider: HTMLInputElement;
  btnMfSave: HTMLButtonElement;
  vscode: { postMessage(msg: unknown): void };
}

export function initProviders(refs: ProviderRefs): void {
  providersList = refs.providersList;
  modelsList = refs.modelsList;
  modelSelect = refs.modelSelect;
  providerStatusDot = refs.providerStatusDot;
  tabProviders = refs.tabProviders;
  tabModels = refs.tabModels;
  tabSystemPrompt = refs.tabSystemPrompt;
  tabProvidersCount = refs.tabProvidersCount;
  tabModelsCount = refs.tabModelsCount;
  providersPane = refs.providersPane;
  modelsPane = refs.modelsPane;
  systemPromptPane = refs.systemPromptPane;
  providerDialog = refs.providerDialog;
  providerDialogTitle = refs.providerDialogTitle;
  pfTypeChips = refs.pfTypeChips;
  pfName = refs.pfName;
  pfBaseUrl = refs.pfBaseUrl;
  pfApiKey = refs.pfApiKey;
  pfDetect = refs.pfDetect;
  btnPfToggleKey = refs.btnPfToggleKey;
  modelDialog = refs.modelDialog;
  modelDialogTitle = refs.modelDialogTitle;
  mfNoProviders = refs.mfNoProviders;
  mfFields = refs.mfFields;
  mfProviderBtn = refs.mfProviderBtn;
  mfProviderLabel = refs.mfProviderLabel;
  mfProviderBadge = refs.mfProviderBadge;
  mfProviderMenu = refs.mfProviderMenu;
  mfModelGroup = refs.mfModelGroup;
  mfModel = refs.mfModel;
  mfModelCaret = refs.mfModelCaret;
  mfModelSuggestions = refs.mfModelSuggestions;
  mfModelHint = refs.mfModelHint;
  mfLabel = refs.mfLabel;
  mfContext = refs.mfContext;
  mfOrRow = refs.mfOrRow;
  mfOrProvider = refs.mfOrProvider;
  btnMfSave = refs.btnMfSave;
  vscodeApi = refs.vscode;

  // Tabs
  tabProviders.addEventListener('click', () => setSettingsTab('providers'));
  tabModels.addEventListener('click', () => setSettingsTab('models'));
  tabSystemPrompt.addEventListener('click', () => setSettingsTab('system'));

  // Provider dialog inputs
  pfName.addEventListener('input', () => { if (providerDraft) { providerDraft.draft.name = pfName.value; } });
  pfBaseUrl.addEventListener('input', () => {
    if (providerDraft) { providerDraft.draft.baseUrl = pfBaseUrl.value; }
    updateProviderDetectHint();
    renderTypeChips();
  });
  pfApiKey.addEventListener('input', () => { if (providerDraft) { providerDraft.draft.apiKey = pfApiKey.value; } });
  btnPfToggleKey.addEventListener('click', () => {
    showKey = !showKey;
    pfApiKey.type = showKey ? 'text' : 'password';
    btnPfToggleKey.textContent = showKey ? 'Hide' : 'Show';
  });

  // Model dialog: provider dropdown
  mfProviderBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleProviderMenu(); });
  // Model dialog: model autocomplete
  mfModel.addEventListener('input', () => {
    if (modelDraft) { modelDraft.draft.model = mfModel.value; }
    openModelMenu();
  });
  mfModel.addEventListener('focus', () => openModelMenu());
  mfModel.addEventListener('keydown', onModelInputKeydown);
  mfModelCaret.addEventListener('click', (e) => { e.stopPropagation(); toggleModelMenu(); });
  mfLabel.addEventListener('input', () => { if (modelDraft) { modelDraft.draft.label = mfLabel.value; } });
  mfContext.addEventListener('input', () => { if (modelDraft) { modelDraft.draft.context = mfContext.value; } });
  mfOrProvider.addEventListener('input', () => { if (modelDraft) { modelDraft.draft.openRouterProvider = mfOrProvider.value; } });

  // Close any open in-dialog menu when clicking elsewhere.
  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t || !t.closest('[data-dd]')) { closeMenus(); }
  });
}

// ── State setters (from extension) ──────────────────────────────────────────────

export function setProviderData(
  newConnections: ProviderConnection[],
  newModels: ModelConfig[],
  newActiveIndex: number,
): void {
  connections = newConnections ?? [];
  models = newModels ?? [];
  activeModelIndex = clampIndex(newActiveIndex);
}

export function setActiveProviderIndex(idx: number): void {
  activeModelIndex = idx;
}

function clampIndex(idx: number): number {
  if (models.length === 0) { return 0; }
  return Math.max(0, Math.min(idx, models.length - 1));
}

// ── Catalog ─────────────────────────────────────────────────────────────────────

export function setModelCatalog(baseUrl: string, list: CatalogModel[]): void {
  if (list && list.length > 0) {
    catalogCache.set(normalizeUrl(baseUrl), list);
    if (!modelDialog.hidden) { renderModelSuggestions(false); }
  }
}

function normalizeUrl(u: string): string {
  return (u || '').trim().replace(/\/+$/, '').toLowerCase();
}

function isOpenRouter(baseUrl: string): boolean {
  return (baseUrl || '').toLowerCase().includes('openrouter.ai');
}

function catalogFor(baseUrl: string): CatalogModel[] {
  return catalogCache.get(normalizeUrl(baseUrl)) ?? (isOpenRouter(baseUrl) ? OPENROUTER_FALLBACK : []);
}

function requestCatalogIfNeeded(baseUrl: string): void {
  if (!isOpenRouter(baseUrl) || catalogCache.has(normalizeUrl(baseUrl))) { return; }
  vscodeApi.postMessage({ type: 'fetchModelCatalog', baseUrl });
}

// ── Provider type detection ──────────────────────────────────────────────────────

function detectType(baseUrl: string): ProviderType {
  const u = (baseUrl || '').toLowerCase();
  if (u.includes('openrouter.ai')) { return PROVIDER_TYPES[2]; }
  if (u.includes('api.openai.com')) { return PROVIDER_TYPES[0]; }
  if (u.includes('anthropic.com')) { return PROVIDER_TYPES[1]; }
  return PROVIDER_TYPES[3];
}

function badgeClass(baseUrl: string): string {
  return `provider-badge type-${detectType(baseUrl).key}`;
}

function maskKey(k: string | undefined): string {
  if (!k || k === 'local') { return 'No API key'; }
  if (k.length <= 8) { return '••••'; }
  return k.slice(0, 4) + '••••' + k.slice(-4);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────────

export function setSettingsTab(tab: SettingsTab): void {
  activeTab = tab;
  tabProviders.setAttribute('aria-selected', String(tab === 'providers'));
  tabModels.setAttribute('aria-selected', String(tab === 'models'));
  tabSystemPrompt.setAttribute('aria-selected', String(tab === 'system'));
  providersPane.hidden = tab !== 'providers';
  modelsPane.hidden = tab !== 'models';
  systemPromptPane.hidden = tab !== 'system';
}

// ── Rendering: lists ──────────────────────────────────────────────────────────────

export function renderSettings(): void {
  tabProvidersCount.textContent = String(connections.length);
  tabModelsCount.textContent = String(models.length);
  renderProvidersList();
  renderModelsList();
}

function renderProvidersList(): void {
  providersList.innerHTML = '';
  if (connections.length === 0) {
    providersList.appendChild(emptyRow('No providers yet.'));
    return;
  }
  for (const c of connections) {
    const t = detectType(c.baseUrl);
    const modelCount = models.filter(m => m.connectionId === c.id).length;
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="provider-item-main">
        <span class="provider-item-titlerow">
          <span class="provider-item-name">${escapeHtml(c.name)}</span>
          <span class="${badgeClass(c.baseUrl)}">${escapeHtml(t.label)}</span>
        </span>
        <span class="provider-item-sub">${escapeHtml(c.baseUrl)}</span>
      </span>
      <span class="provider-item-meta">
        <span>${modelCount} model${modelCount === 1 ? '' : 's'}</span>
        <span class="mono">${escapeHtml(maskKey(c.apiKey))}</span>
      </span>
      <span class="provider-item-actions">
        <button data-id="${c.id}" class="btn-edit-conn" aria-label="Edit ${escapeHtml(c.name)}">Edit</button>
        <button data-id="${c.id}" class="btn-delete btn-delete-conn" aria-label="Delete ${escapeHtml(c.name)}">×</button>
      </span>
    `;
    providersList.appendChild(li);
  }
  providersList.querySelectorAll('.btn-edit-conn').forEach(b =>
    b.addEventListener('click', () => openProviderDialog((b as HTMLElement).dataset.id ?? null)));
  providersList.querySelectorAll('.btn-delete-conn').forEach(b =>
    b.addEventListener('click', () => deleteConnection((b as HTMLElement).dataset.id ?? '')));
}

function renderModelsList(): void {
  modelsList.innerHTML = '';
  if (models.length === 0) {
    modelsList.appendChild(emptyRow('No models yet.'));
    return;
  }
  for (const m of models) {
    const conn = connections.find(c => c.id === m.connectionId);
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="provider-item-main">
        <span class="provider-item-name">${escapeHtml(m.label || m.model)}</span>
        <span class="provider-item-sub">${escapeHtml(m.model)}</span>
      </span>
      <span class="${conn ? badgeClass(conn.baseUrl) : 'provider-badge'}">${escapeHtml(conn ? conn.name : 'Provider removed')}</span>
      <span class="provider-item-actions">
        <button data-id="${m.id}" class="btn-edit-model" aria-label="Edit ${escapeHtml(m.label || m.model)}">Edit</button>
        <button data-id="${m.id}" class="btn-delete btn-delete-model" aria-label="Delete ${escapeHtml(m.label || m.model)}">×</button>
      </span>
    `;
    modelsList.appendChild(li);
  }
  modelsList.querySelectorAll('.btn-edit-model').forEach(b =>
    b.addEventListener('click', () => openModelDialog((b as HTMLElement).dataset.id ?? null)));
  modelsList.querySelectorAll('.btn-delete-model').forEach(b =>
    b.addEventListener('click', () => deleteModel((b as HTMLElement).dataset.id ?? '')));
}

function emptyRow(text: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'settings-empty';
  li.textContent = text;
  return li;
}

// ── Bottom model picker ─────────────────────────────────────────────────────────

export function renderModelDropdown(): void {
  const prev = modelSelect.value;
  modelSelect.innerHTML = '';
  const order = models.map((_, i) => i).sort((a, b) => labelFor(models[a]).localeCompare(labelFor(models[b])));
  for (const i of order) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = labelFor(models[i]);
    modelSelect.appendChild(opt);
  }
  if (prev && modelSelect.querySelector(`option[value="${prev}"]`)) {
    modelSelect.value = prev;
  } else {
    modelSelect.value = String(clampIndex(activeModelIndex));
  }
  updateProviderStatusVisibility();
}

function labelFor(m: ModelConfig): string {
  return m.label || m.model;
}

// ── Status dot ──────────────────────────────────────────────────────────────────

export function triggerProviderStatusCheck(): void {
  if (models.length === 0) { return; }
  setProviderStatus('checking');
  vscodeApi.postMessage({ type: 'selectModel', providerIndex: clampIndex(activeModelIndex) });
}

export function setProviderStatus(status: 'online' | 'offline' | 'checking' | 'unknown'): void {
  currentProviderStatus = status;
  providerStatusDot.className = `status-dot status-${status}`;
  const labels: Record<string, string> = { online: 'Online', offline: 'Offline', checking: 'Checking...', unknown: 'Unknown' };
  providerStatusDot.title = labels[status] ?? 'Unknown';
}

export function getProviderStatus(): 'online' | 'offline' | 'checking' | 'unknown' {
  return currentProviderStatus;
}

export function updateProviderStatusVisibility(): void {
  const ok = models.length > 0 && activeModelIndex >= 0 && activeModelIndex < models.length;
  providerStatusDot.classList.toggle('hidden', !ok);
}

// ── Persistence ───────────────────────────────────────────────────────────────────

function persist(): void {
  vscodeApi.postMessage({
    type: 'saveSettings',
    connections,
    models,
    activeModelIndex: clampIndex(activeModelIndex),
  });
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ── Provider dialog ────────────────────────────────────────────────────────────────

export function openProviderDialog(id: string | null): void {
  closeModelDialog();
  showKey = false;
  pfApiKey.type = 'password';
  btnPfToggleKey.textContent = 'Show';

  if (id === null) {
    providerDraft = { mode: 'add', draft: { type: 'openrouter', name: '', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' } };
    providerDialogTitle.textContent = 'Add provider';
  } else {
    const c = connections.find(x => x.id === id);
    if (!c) { return; }
    providerDraft = { mode: 'edit', id, draft: { type: detectType(c.baseUrl).key, name: c.name, baseUrl: c.baseUrl, apiKey: c.apiKey ?? '' } };
    providerDialogTitle.textContent = 'Edit provider';
  }

  const d = providerDraft.draft;
  pfName.value = d.name;
  pfBaseUrl.value = d.baseUrl;
  pfApiKey.value = d.apiKey;
  renderTypeChips();
  updateProviderDetectHint();
  providerDialog.hidden = false;
  pfName.focus();
}

export function closeProviderDialog(): void {
  providerDialog.hidden = true;
  providerDraft = null;
}

function renderTypeChips(): void {
  if (!providerDraft) { return; }
  const activeKey = detectType(providerDraft.draft.baseUrl).key;
  pfTypeChips.innerHTML = '';
  for (const t of PROVIDER_TYPES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip${t.key === activeKey ? ' active' : ''}`;
    btn.textContent = t.label;
    btn.addEventListener('click', () => selectType(t));
    pfTypeChips.appendChild(btn);
  }
}

function selectType(t: ProviderType): void {
  if (!providerDraft) { return; }
  const d = providerDraft.draft;
  // Replace the base URL only when it's empty or still a known preset.
  if (!d.baseUrl || PRESET_BASE_URLS.includes(d.baseUrl)) {
    d.baseUrl = t.baseUrl;
    pfBaseUrl.value = t.baseUrl;
  }
  d.type = t.key;
  renderTypeChips();
  updateProviderDetectHint();
}

function updateProviderDetectHint(): void {
  const t = detectType(pfBaseUrl.value);
  const detected = t.key !== 'compatible';
  pfDetect.hidden = false;
  pfDetect.className = `form-hint${detected ? ' detected' : ''}`;
  pfDetect.innerHTML = `<span class="form-hint-dot"></span><span>${
    detected
      ? `Recognized as ${escapeHtml(t.label)}${t.key === 'openrouter' ? ' — model names will autocomplete from its catalog.' : '.'}`
      : 'Unrecognized endpoint — model ids are entered manually.'
  }</span>`;
}

export function saveProviderDialog(): void {
  if (!providerDraft) { return; }
  const name = pfName.value.trim();
  const baseUrl = pfBaseUrl.value.trim();
  if (!name || !baseUrl) { return; }
  const apiKey = pfApiKey.value || undefined;

  if (providerDraft.mode === 'add') {
    connections.push({ id: genId('conn'), name, baseUrl, apiKey });
  } else if (providerDraft.id) {
    const c = connections.find(x => x.id === providerDraft!.id);
    if (c) { c.name = name; c.baseUrl = baseUrl; c.apiKey = apiKey; }
  }
  persist();
  renderSettings();
  renderModelDropdown();
  closeProviderDialog();
}

function deleteConnection(id: string): void {
  connections = connections.filter(c => c.id !== id);
  const before = models.length;
  models = models.filter(m => m.connectionId !== id);
  if (models.length !== before) { activeModelIndex = clampIndex(activeModelIndex); }
  persist();
  renderSettings();
  renderModelDropdown();
  triggerProviderStatusCheck();
}

// ── Model dialog ────────────────────────────────────────────────────────────────

export function openModelDialog(id: string | null): void {
  closeProviderDialog();
  closeMenus();

  if (id === null) {
    modelDraft = {
      mode: 'add',
      draft: { connectionId: connections[0]?.id ?? '', model: '', label: '', context: '32768', openRouterProvider: '' },
    };
    modelDialogTitle.textContent = 'Add model';
  } else {
    const m = models.find(x => x.id === id);
    if (!m) { return; }
    modelDraft = {
      mode: 'edit',
      id,
      draft: {
        connectionId: m.connectionId,
        model: m.model,
        label: m.label ?? '',
        context: String(m.context ?? 32768),
        openRouterProvider: m.openRouterProvider ?? '',
      },
    };
    modelDialogTitle.textContent = 'Edit model';
  }

  const hasProviders = connections.length > 0;
  mfNoProviders.hidden = hasProviders;
  mfFields.hidden = !hasProviders;
  btnMfSave.hidden = !hasProviders;

  const d = modelDraft.draft;
  mfModel.value = d.model;
  mfLabel.value = d.label;
  mfContext.value = d.context;
  mfOrProvider.value = d.openRouterProvider;
  renderProviderButton();
  syncModelFieldMode();

  const conn = connections.find(c => c.id === d.connectionId);
  if (conn) { requestCatalogIfNeeded(conn.baseUrl); }

  modelDialog.hidden = false;
  if (hasProviders) { mfProviderBtn.focus(); }
}

export function closeModelDialog(): void {
  modelDialog.hidden = true;
  closeMenus();
  modelDraft = null;
}

function renderProviderButton(): void {
  if (!modelDraft) { return; }
  const conn = connections.find(c => c.id === modelDraft.draft.connectionId);
  if (conn) {
    mfProviderLabel.textContent = conn.name;
    mfProviderLabel.className = 'dd-label';
    mfProviderBadge.hidden = false;
    mfProviderBadge.className = badgeClass(conn.baseUrl);
    mfProviderBadge.textContent = detectType(conn.baseUrl).label;
  } else {
    mfProviderLabel.textContent = 'Select a provider…';
    mfProviderLabel.className = 'dd-label placeholder';
    mfProviderBadge.hidden = true;
  }
}

function toggleProviderMenu(): void {
  if (providerMenuOpen) { closeMenus(); return; }
  closeMenus();
  renderProviderMenu();
  mfProviderMenu.hidden = false;
  providerMenuOpen = true;
}

function renderProviderMenu(): void {
  mfProviderMenu.innerHTML = '';
  for (const c of connections) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'dd-option';
    opt.innerHTML = `
      <span class="dd-option-main">
        <span class="dd-option-name">${escapeHtml(c.name)}</span>
        <span class="dd-option-sub">${escapeHtml(c.baseUrl)}</span>
      </span>
      <span class="${badgeClass(c.baseUrl)}">${escapeHtml(detectType(c.baseUrl).label)}</span>
    `;
    opt.addEventListener('click', () => selectProviderInDialog(c.id));
    mfProviderMenu.appendChild(opt);
  }
  const sep = document.createElement('div');
  sep.className = 'dd-sep';
  mfProviderMenu.appendChild(sep);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'dd-add';
  add.textContent = '+ New provider…';
  add.addEventListener('click', () => openProviderDialog(null));
  mfProviderMenu.appendChild(add);
}

function selectProviderInDialog(id: string): void {
  if (!modelDraft) { return; }
  modelDraft.draft.connectionId = id;
  // Switching provider resets the model id (the catalog/format differs).
  modelDraft.draft.model = '';
  mfModel.value = '';
  closeMenus();
  renderProviderButton();
  syncModelFieldMode();
  const conn = connections.find(c => c.id === id);
  if (conn) { requestCatalogIfNeeded(conn.baseUrl); }
}

/** Update the model field's mode (autocomplete vs plain), hint, and OR-pin visibility. */
function syncModelFieldMode(): void {
  if (!modelDraft) { return; }
  const conn = connections.find(c => c.id === modelDraft.draft.connectionId);
  const or = !!conn && isOpenRouter(conn.baseUrl);
  mfModelGroup.hidden = !conn;
  mfOrRow.hidden = !or;
  mfModelCaret.hidden = !or;
  mfModelHint.hidden = false;
  if (or) {
    mfModel.placeholder = 'Search or type a model id…';
    mfModelHint.textContent = 'OpenRouter detected — pick from the list or type a custom id.';
  } else {
    mfModel.placeholder = 'e.g. llama-3.1-8b-instruct';
    mfModelHint.textContent = conn ? 'Enter the model id your endpoint expects.' : 'Select a provider first.';
  }
}

export function saveModelDialog(): void {
  if (!modelDraft) { return; }
  const connectionId = modelDraft.draft.connectionId;
  const model = mfModel.value.trim();
  if (!connectionId || !model) { return; }
  const label = mfLabel.value.trim() || undefined;
  const context = parseInt(mfContext.value, 10) || 32768;
  const conn = connections.find(c => c.id === connectionId);
  const openRouterProvider = conn && isOpenRouter(conn.baseUrl)
    ? (mfOrProvider.value.trim() || undefined)
    : undefined;

  if (modelDraft.mode === 'add') {
    models.push({ id: genId('model'), connectionId, model, label, context, openRouterProvider });
  } else if (modelDraft.id) {
    const m = models.find(x => x.id === modelDraft!.id);
    if (m) {
      m.connectionId = connectionId;
      m.model = model;
      m.label = label;
      m.context = context;
      m.openRouterProvider = openRouterProvider;
    }
  }
  persist();
  renderSettings();
  renderModelDropdown();
  closeModelDialog();
  triggerProviderStatusCheck();
}

function deleteModel(id: string): void {
  models = models.filter(m => m.id !== id);
  activeModelIndex = clampIndex(activeModelIndex);
  persist();
  renderSettings();
  renderModelDropdown();
  triggerProviderStatusCheck();
}

// ── Model autocomplete ──────────────────────────────────────────────────────────

function openModelMenu(): void {
  if (modelMenuOpen) { renderModelSuggestions(false); return; }
  renderModelSuggestions(true);
}

function toggleModelMenu(): void {
  if (modelMenuOpen) { closeMenus(); return; }
  renderModelSuggestions(true);
  mfModel.focus();
}

function renderModelSuggestions(forceOpen: boolean): void {
  if (!modelDraft) { return; }
  const conn = connections.find(c => c.id === modelDraft.draft.connectionId);
  if (!conn || !isOpenRouter(conn.baseUrl)) { hideSuggestions(); return; }

  const all = catalogFor(conn.baseUrl);
  const q = mfModel.value.trim().toLowerCase();
  const filtered = (q
    ? all.filter(m => m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q))
    : all
  ).slice(0, 60);

  mfModelSuggestions.innerHTML = '';
  suggestionsActiveIndex = -1;

  if (filtered.length === 0) {
    const li = document.createElement('li');
    li.className = 'dd-empty';
    li.innerHTML = q
      ? `No catalog match — “${escapeHtml(q)}” will be used as a custom id.`
      : 'No models available.';
    mfModelSuggestions.appendChild(li);
  } else {
    for (const m of filtered) {
      const li = document.createElement('li');
      li.className = 'dd-option';
      li.dataset.id = m.id;
      const ctx = m.context ? `${Math.round(m.context / 1000)}K` : '';
      li.innerHTML = `<span class="sg-id">${escapeHtml(m.id)}</span>${m.name ? `<span class="sg-ctx">${escapeHtml(m.name)}</span>` : ''}${ctx ? `<span class="sg-ctx">${ctx}</span>` : ''}`;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pickSuggestion(m); });
      mfModelSuggestions.appendChild(li);
    }
  }

  if (forceOpen || modelMenuOpen) {
    mfModelSuggestions.hidden = false;
    modelMenuOpen = true;
  }
}

function pickSuggestion(m: CatalogModel): void {
  if (!modelDraft) { return; }
  mfModel.value = m.id;
  modelDraft.draft.model = m.id;
  // Auto-fill context window from the catalog when not yet customized.
  if (m.context && (!mfContext.value || mfContext.value === '32768')) {
    mfContext.value = String(m.context);
    modelDraft.draft.context = String(m.context);
  }
  hideSuggestions();
}

function hideSuggestions(): void {
  mfModelSuggestions.hidden = true;
  mfModelSuggestions.innerHTML = '';
  modelMenuOpen = false;
  suggestionsActiveIndex = -1;
}

function onModelInputKeydown(e: KeyboardEvent): void {
  if (mfModelSuggestions.hidden) { return; }
  const items = Array.from(mfModelSuggestions.querySelectorAll('li.dd-option')) as HTMLElement[];
  if (items.length === 0) { return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    suggestionsActiveIndex = (suggestionsActiveIndex + delta + items.length) % items.length;
    items.forEach((it, i) => it.classList.toggle('active', i === suggestionsActiveIndex));
    items[suggestionsActiveIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && suggestionsActiveIndex >= 0) {
    e.preventDefault();
    const id = items[suggestionsActiveIndex].dataset.id ?? '';
    const m = catalogFor(connections.find(c => c.id === modelDraft?.draft.connectionId)?.baseUrl ?? '').find(x => x.id === id);
    pickSuggestion(m ?? { id });
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
}

function closeMenus(): void {
  providerMenuOpen = false;
  mfProviderMenu.hidden = true;
  hideSuggestions();
}

/** Whether a dialog is open (so the host can route Escape / focus handling). */
export function isDialogOpen(): boolean {
  return !providerDialog.hidden || !modelDialog.hidden;
}

/** Close whichever dialog is open (Escape from the host). Returns true if one closed. */
export function closeOpenDialog(): boolean {
  if (providerMenuOpen || modelMenuOpen) { closeMenus(); return true; }
  if (!modelDialog.hidden) { closeModelDialog(); return true; }
  if (!providerDialog.hidden) { closeProviderDialog(); return true; }
  return false;
}
